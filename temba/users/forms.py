from allauth.account.forms import AddEmailForm, ChangePasswordForm, LoginForm, SignupForm

from django import forms
from django.utils.functional import cached_property
from django.utils.translation import gettext_lazy as _

from temba.orgs.models import Invitation
from temba.users.models import User


class InviteFormMixin:
    def __init__(self, secret, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.secret = secret

    @cached_property
    def invite(self):
        if self.secret:
            return Invitation.objects.filter(secret=self.secret, is_active=True).first()
        return None


class TembaSignupForm(InviteFormMixin, SignupForm):
    first_name = forms.CharField(
        max_length=User._meta.get_field("first_name").max_length,
        label="",
        widget=forms.TextInput(attrs={"placeholder": _("First name")}),
    )

    last_name = forms.CharField(
        max_length=User._meta.get_field("last_name").max_length,
        label="",
        widget=forms.TextInput(
            attrs={
                "placeholder": _("Last name"),
            }
        ),
    )

    field_order = ["first_name", "last_name", "email", "password1"]

    def __init__(self, secret, *args, **kwargs):
        super().__init__(secret, *args, **kwargs)
        if self.invite:
            self.fields["email"].widget = forms.widgets.HiddenInput()

    def clean_email(self):
        if self.invite:
            return self.invite.email
        return super().clean_email()

    def save(self, request):
        # deferred for the same reason as in temba/users/adapter.py — keep this
        # module out of the orgs.views import chain so it stays safe to load
        # from any startup-side path under Python 3.14
        from temba.orgs.views.utils import switch_to_org

        # remove our invite from the session
        if "invite_secret" in request.session:
            del request.session["invite_secret"]

        if self.invite:
            request.session["account_verified_email"] = self.invite.email
        user = super(TembaSignupForm, self).save(request)

        # if we have an invite, accept it and switch to that org
        if self.invite:
            self.invite.accept(user)
            switch_to_org(request, self.invite.org)

        return user


class TembaLoginForm(InviteFormMixin, LoginForm):
    def __init__(self, secret, *args, **kwargs):
        super().__init__(secret, *args, **kwargs)
        if self.invite:
            self.fields["login"].widget = forms.widgets.HiddenInput()

    def clean_login(self):
        if self.invite:
            return self.invite.email

        # this is tested by allauth
        return super().clean_login()  # pragma: no cover


class TembaChangePasswordForm(ChangePasswordForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["password1"].help_text = "At least 8 characters or more"


class TembaAddEmailForm(AddEmailForm):
    def clean_email(self):
        # check if email is already in use
        if User.objects.filter(email__iexact=self.cleaned_data["email"]).exists():
            raise forms.ValidationError(_("This email is already in use"))

        return super().clean_email()
