from urllib.parse import urlencode

from allauth.account.adapter import DefaultAccountAdapter
from allauth.account.models import EmailAddress
from allauth.core import context as allauth_context
from allauth.mfa.adapter import DefaultMFAAdapter
from allauth.socialaccount.adapter import DefaultSocialAccountAdapter
from allauth.socialaccount.signals import social_account_added

from django.conf import settings
from django.contrib import messages
from django.dispatch import receiver
from django.shortcuts import redirect
from django.urls import reverse
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from temba.orgs.models import Invitation
from temba.users.models import User
from temba.utils.email.send import EmailSender


class InviteAdapterMixin:
    def post_login(self, request, user, *, email_verification, signal_kwargs, email, signup, redirect_url):
        # deferred so this module stays importable from allauth's startup
        # `adapter_check`. Importing anything from `temba.orgs.views.*` at module
        # scope runs `temba/orgs/views/__init__.py`, which star-imports the
        # heavy `views.py`; under Python 3.14's stricter `_ModuleLock` deadlock
        # detection that races with runserver's autoreloader and aborts startup.
        from temba.orgs.views.utils import switch_to_org

        # if we are working with an invite, mark it as accepted
        secret = request.session.pop("invite_secret", None)
        if secret:
            invite = Invitation.objects.filter(secret=secret, is_active=True).first()
            if invite:
                # this can happen if a SSO with a different email address is used
                if user.email != User.objects.normalize_email(invite.email):  # pragma: no cover
                    messages.add_message(
                        self.request,
                        messages.WARNING,
                        _("To accept this invitation, please login with %(email)s.") % {"email": invite.email},
                    )
                else:
                    invite.accept(user)
                    switch_to_org(request, user)

        return super().post_login(
            request,
            user,
            email_verification=email_verification,
            signal_kwargs=signal_kwargs,
            email=email,
            signup=signup,
            redirect_url=redirect_url,
        )

    def is_open_for_signup(self, request, sociallogin=None):
        # only users with a valid invite can create accounts
        secret = request.GET.get("invite", request.session.get("invite_secret", None))

        return bool(secret and Invitation.objects.filter(secret=secret, is_active=True).exists())


class TembaAccountAdapter(InviteAdapterMixin, DefaultAccountAdapter):
    def get_sso_only_message(self, email: str):
        """
        Returns the error for an email address whose domain requires SSO, or None.
        """
        domain = email.rsplit("@", 1)[-1].lower() if email else ""
        return {d.lower(): m for d, m in settings.SSO_ONLY_DOMAINS.items()}.get(domain)

    def pre_login(self, request, user, *, email_verification, signal_kwargs, email, signup, redirect_url):
        # users whose email domain requires SSO can't login any other way
        is_sso = bool(signal_kwargs and signal_kwargs.get("sociallogin"))
        sso_only_message = self.get_sso_only_message(user.email)
        if not is_sso and sso_only_message:
            messages.error(request, sso_only_message)
            login_url = reverse("account_login")
            if redirect_url:
                login_url += "?" + urlencode({"next": redirect_url})
            return redirect(login_url)

        return super().pre_login(
            request,
            user,
            email_verification=email_verification,
            signal_kwargs=signal_kwargs,
            email=email,
            signup=signup,
            redirect_url=redirect_url,
        )

    def send_mail(self, template_prefix, email, context):
        # our emails need some additional context
        context["branding"] = self.request.branding
        context["now"] = timezone.now()

        sender = EmailSender.from_email_type(self.request.branding, "notifications")
        sender.send([email], template_prefix, context)


class TembaSocialAccountAdapter(InviteAdapterMixin, DefaultSocialAccountAdapter):
    @staticmethod
    def _get_email(sociallogin) -> str | None:
        # providers like OpenID Connect nest the user's claims inside extra_data, so read them via the provider account
        data = sociallogin.account.get_provider_account().get_user_data() or {}

        # azure ad may only provide the email as upn or preferred_username
        return data.get("email") or data.get("upn") or data.get("preferred_username")

    def populate_user(self, request, sociallogin, data):
        user = super().populate_user(request, sociallogin, data)
        email = self._get_email(sociallogin)
        if not user.email:
            user.email = email
        if "email" not in data and email:
            data["email"] = email
        return user

    def save_user(self, request, sociallogin, form=None):  # pragma: no cover
        user = super().save_user(request, sociallogin, form)
        email = user.email
        if email:
            EmailAddress.objects.update_or_create(
                user=user,
                email=email,
                defaults={"verified": True, "primary": True},
            )
        return user

    def pre_social_login(self, request, sociallogin):
        email = self._get_email(sociallogin)

        # if we have an email but no email_addresses set, create one
        if email and not sociallogin.email_addresses:
            sociallogin.email_addresses = [EmailAddress(email=email, verified=True, primary=True)]

        # if user exists, connect the social account, but only if the provider is trusted to authenticate by email as
        # its claims may be unverified or editable by the user
        if email and not sociallogin.is_existing and self.can_authenticate_by_email(sociallogin, email):
            user = User.get_by_email(email)
            if user:
                sociallogin.connect(request, user)


@receiver(social_account_added)
def update_user_profile_picture(request, sociallogin, **kwargs):  # pragma: no cover
    user = sociallogin.user
    user.fetch_avatar(sociallogin.account.get_avatar_url())


class TembaMFAAdapter(DefaultMFAAdapter):
    def _get_site_name(self) -> str:
        return allauth_context.request.get_host()

    def build_totp_url(self, user, secret: str) -> str:
        url = super().build_totp_url(user, secret)

        # some totp clients support images in the QR code
        url = f"{url}&image={self.request.branding.get('logos').get('favico')}"
        return url
