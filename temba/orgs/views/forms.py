import smtplib
from email.utils import parseaddr

from django import forms
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.utils.translation import gettext_lazy as _

from temba.utils.email import EmailSender, make_smtp_url, parse_smtp_url
from temba.utils.fields import InputWidget


class SMTPForm(forms.Form):
    from_email = forms.CharField(
        max_length=128,
        label=_("From Address"),
        help_text=_("Can include a name, e.g. Jane Doe <jane@example.org>."),
        widget=InputWidget(),
    )
    host = forms.CharField(
        label=_("Hostname"), max_length=128, widget=InputWidget(attrs={"placeholder": _("e.g. smtp.example.com")})
    )
    port = forms.IntegerField(
        label=_("Port"), min_value=1, max_value=65535, widget=InputWidget(attrs={"placeholder": _("e.g. 25")})
    )
    username = forms.CharField(max_length=128, label=_("Username"), widget=InputWidget())
    password = forms.CharField(max_length=128, label=_("Password"), widget=InputWidget(attrs={"password": True}))

    def __init__(self, org, initial: str, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.org = org

        host, port, username, password, from_email, _ = parse_smtp_url(initial)
        self.fields["from_email"].initial = from_email
        self.fields["host"].initial = host
        self.fields["port"].initial = port
        self.fields["username"].initial = username
        self.fields["password"].initial = password

    def clean_from_email(self):
        # clean the from email, that can contain a name, e.g. Jane Doe <jane@example.org>
        data = self.cleaned_data["from_email"]
        if data:
            try:
                validate_email(parseaddr(data)[1])
            except ValidationError:
                raise forms.ValidationError(_("Not a valid email address."))
        return data

    def clean(self):
        super().clean()

        # if individual fields look valid, do an actual email test...
        if self.is_valid():
            from_email = self.cleaned_data["from_email"]
            host = self.cleaned_data["host"]
            port = self.cleaned_data["port"]
            username = self.cleaned_data["username"]
            password = self.cleaned_data["password"]

            smtp_url = make_smtp_url(host, port, username, password, from_email, tls=True)
            sender = EmailSender.from_smtp_url(self.org.branding, smtp_url)
            recipients = [admin.email for admin in self.org.get_admins().order_by("email")]
            subject = _("%(name)s SMTP settings test") % self.org.branding
            try:
                sender.send(recipients, "orgs/email/smtp_test", {}, subject)
            except smtplib.SMTPException as e:
                raise ValidationError(_("SMTP settings test failed with error: %s") % str(e))
            except Exception:
                raise ValidationError(_("SMTP settings test failed."))

            self.cleaned_data["smtp_url"] = smtp_url

        return self.cleaned_data

    class Meta:
        fields = ("from_email", "host", "username", "password", "port")
