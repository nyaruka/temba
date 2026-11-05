from allauth.account.adapter import DefaultAccountAdapter
from allauth.account.internal.emailkit import valid_email_or_none
from allauth.account.models import EmailAddress
from allauth.core import context as allauth_context
from allauth.mfa.adapter import DefaultMFAAdapter
from allauth.socialaccount.adapter import DefaultSocialAccountAdapter
from allauth.socialaccount.signals import social_account_added

from django.contrib import messages
from django.dispatch import receiver
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from temba.orgs.models import Invitation
from temba.orgs.views.views import switch_to_org
from temba.users.models import User
from temba.utils.email.send import EmailSender


class InviteAdapterMixin:
    def post_login(self, request, user, *, email_verification, signal_kwargs, email, signup, redirect_url):
        # if we are working with an invite, mark it as accepted
        secret = request.session.pop("invite_secret", None)
        if secret:
            invite = Invitation.objects.filter(secret=secret, is_active=True).first()
            if invite:
                # this can happen if a SSO with a different email address is used
                if user.email.lower() != invite.email.lower():
                    messages.add_message(
                        self.request,
                        messages.WARNING,
                        _(f"To accept this invitation, please login with {invite.email}."),
                    )
                else:
                    invite.accept(user)
                    switch_to_org(request, user)

        # DefaultSocialAccountAdapter does not inherit DefaultAccountAdapter, so delegate
        # invite handling here and continue login via the account adapter.
        if isinstance(self, DefaultAccountAdapter):
            return super().post_login(
                request,
                user,
                email_verification=email_verification,
                signal_kwargs=signal_kwargs,
                email=email,
                signup=signup,
                redirect_url=redirect_url,
            )

        from allauth.account.adapter import get_adapter as get_account_adapter

        return get_account_adapter().post_login(
            request,
            user,
            email_verification=email_verification,
            signal_kwargs=signal_kwargs,
            email=email,
            signup=signup,
            redirect_url=redirect_url,
        )

    def is_open_for_signup(self, request, sociallogin=None):
        # if we have a signup invite, we need to allow signups
        secret = request.GET.get("invite", request.session.get("invite_secret", None))

        if secret and Invitation.objects.filter(secret=secret, is_active=True).exists():
            return True

        return "signups" in request.branding.get("features")


class TembaAccountAdapter(InviteAdapterMixin, DefaultAccountAdapter):
    def send_mail(self, template_prefix, email, context):

        # allauth's default send_mail puts `email` in the template context;
        # keep that contract so templates like account_already_exists render it.
        context.setdefault("email", email)
        context["branding"] = self.request.branding
        context["now"] = timezone.now()

        sender = EmailSender.from_email_type(self.request.branding, "notifications")
        sender.send([email], template_prefix, context)


class TembaSocialAccountAdapter(InviteAdapterMixin, DefaultSocialAccountAdapter):
    EMAIL_CLAIM_KEYS = ("email", "upn", "preferred_username", "mail")

    @classmethod
    def email_from_mapping(cls, data):
        if not isinstance(data, dict):
            return None

        for key in cls.EMAIL_CLAIM_KEYS:
            email = valid_email_or_none(data.get(key))
            if email:
                return email
        return None

    @classmethod
    def extract_email(cls, sociallogin):
        for address in getattr(sociallogin, "email_addresses", []) or []:
            email = valid_email_or_none(getattr(address, "email", None))
            if email:
                return email

        extra_data = getattr(getattr(sociallogin, "account", None), "extra_data", None) or {}
        # allauth >= 65.11 stores OIDC payloads as {userinfo, id_token}; older
        # versions keep claims at the top level.
        return (
            cls.email_from_mapping(extra_data)
            or cls.email_from_mapping(extra_data.get("userinfo"))
            or cls.email_from_mapping(extra_data.get("id_token"))
        )

    @staticmethod
    def find_existing_user(email):
        user = User.get_by_email(email)
        if user:
            return user

        address = EmailAddress.objects.filter(email__iexact=email).select_related("user").first()
        return address.user if address else None

    @staticmethod
    def mark_email_verified(user, email):
        address = EmailAddress.objects.filter(user=user, email__iexact=email).first()
        if address:
            if not address.verified or not address.primary:
                address.verified = True
                address.primary = True
                address.save(update_fields=["verified", "primary"])
        else:
            EmailAddress.objects.create(user=user, email=email, verified=True, primary=True)

    @staticmethod
    def ensure_verified_email_addresses(sociallogin, email):
        sociallogin.email_addresses = [EmailAddress(email=email, verified=True, primary=True)]

    def is_email_verified(self, provider, email):
        # Microsoft Entra is a trusted IdP; treat social emails as verified so
        # allauth lookup() can match existing accounts before auto-signup runs.
        if email:
            return True
        return super().is_email_verified(provider, email)

    def can_authenticate_by_email(self, login, email):
        # Do not depend on SocialApp.settings in the DB matching settings.py.
        return True

    def populate_user(self, request, sociallogin, data):
        user = super().populate_user(request, sociallogin, data)
        email = self.extract_email(sociallogin) or self.email_from_mapping(data)
        if email:
            if not user.email:
                user.email = email
            data["email"] = email
            # lookup() runs after populate_user and only considers verified
            # email_addresses — fill them here, not in pre_social_login.
            self.ensure_verified_email_addresses(sociallogin, email)
        return user

    def save_user(self, request, sociallogin, form=None):
        user = super().save_user(request, sociallogin, form)
        if user.email:
            self.mark_email_verified(user, user.email)
        return user

    def pre_social_login(self, request, sociallogin):
        email = self.extract_email(sociallogin)
        if not email:
            return

        self.ensure_verified_email_addresses(sociallogin, email)

        sociallogin_user = getattr(sociallogin, "user", None)
        if sociallogin_user is None or sociallogin_user.pk is None:
            user = self.find_existing_user(email)
            if user:
                sociallogin.connect(request, user)
                self.mark_email_verified(user, email)


@receiver(social_account_added)
def update_user_profile_picture(request, sociallogin, **kwargs):  # pragma: no cover
    user = sociallogin.user
    try:
        avatar_url = sociallogin.account.get_avatar_url()
    except Exception:
        return
    if avatar_url:
        user.fetch_avatar(avatar_url)


class TembaMFAAdapter(DefaultMFAAdapter):
    def _get_site_name(self) -> str:
        return allauth_context.request.get_host()

    def build_totp_url(self, user, secret: str) -> str:
        url = super().build_totp_url(user, secret)

        # some totp clients support images in the QR code
        url = f"{url}&image={self.request.branding.get("logos").get("favico")}"
        return url
