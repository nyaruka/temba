import re

from smartmin.views import SmartFormView

from django import forms
from django.core.exceptions import ValidationError
from django.utils.translation import gettext_lazy as _

from temba.channels.models import Channel
from temba.channels.views import ClaimViewMixin, UpdateChannelForm

CONFIG_ALLOWED_DOMAINS = "allowed_domains"
CONFIG_EMAIL_FROM = "email_from"
CONFIG_MAILGUN_DOMAIN = "mailgun_domain"
CONFIG_MAILGUN_REGION = "mailgun_region"
CONFIG_MAILGUN_API_KEY = "mailgun_api_key"

MAILGUN_REGION_CHOICES = (("us", _("US")), ("eu", _("EU")))

# a domain entry is a host - dot-separated alphanumeric labels which may contain hyphens - optionally followed by a
# port (whose 1-65535 range is checked separately), e.g. "example.com" or "localhost:3000" - never a scheme or path
DOMAIN_REGEX = re.compile(r"[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)*(:(?P<port>\d{1,5}))?")


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        pass

    form_class = Form
    readonly_servicing = False

    def form_valid(self, form):
        self.object = Channel.create(
            self.request.org, self.request.user, None, self.channel_type, name="WebChat", config={}
        )

        return super().form_valid(form)


class UpdateForm(UpdateChannelForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        field = forms.CharField(
            label=_("Allowed Domains"),
            required=False,
            widget=forms.Textarea(attrs={"rows": 3}),
            help_text=_(
                "The domains of the websites that can embed this channel's chat widget, one per line or comma "
                "separated, e.g. example.com or example.com:8080. If empty, any website can embed it."
            ),
        )
        self.add_config_field(CONFIG_ALLOWED_DOMAINS, field, default=[])
        field.initial = "\n".join(field.initial or [])

        self.add_config_field(
            CONFIG_EMAIL_FROM,
            forms.EmailField(
                label=_("Email From Address"),
                required=False,
                help_text=_("The address that emails to contacts are sent from, e.g. support@example.com."),
            ),
            default="",
        )
        self.add_config_field(
            CONFIG_MAILGUN_DOMAIN,
            forms.CharField(
                label=_("Mailgun Domain"),
                required=False,
                help_text=_("The Mailgun sending domain to send emails through. If empty, emails aren't sent."),
            ),
            default="",
        )
        self.add_config_field(
            CONFIG_MAILGUN_REGION,
            forms.ChoiceField(
                label=_("Mailgun Region"),
                choices=MAILGUN_REGION_CHOICES,
                help_text=_("The region of the Mailgun account that the domain belongs to."),
            ),
            default="us",
        )
        self.add_config_field(
            CONFIG_MAILGUN_API_KEY,
            forms.CharField(
                label=_("Mailgun API Key"),
                required=False,
                widget=forms.PasswordInput(),
                help_text=_("A sending API key for the Mailgun domain. Leave empty to keep the existing key."),
            ),
            default="",
        )
        self.fields[CONFIG_MAILGUN_API_KEY].initial = ""

    def clean_allowed_domains(self) -> list:
        domains = []
        for entry in re.split(r"[,\n]", self.cleaned_data[CONFIG_ALLOWED_DOMAINS]):
            entry = entry.strip().lower()
            if not entry:
                continue
            match = DOMAIN_REGEX.fullmatch(entry)
            if not match or (match["port"] and not 1 <= int(match["port"]) <= 65535):
                raise ValidationError(
                    _("%(domain)s is not a valid domain. Enter domains without schemes or paths, e.g. example.com."),
                    params={"domain": entry},
                )
            if entry not in domains:
                domains.append(entry)
        return domains

    def clean_mailgun_domain(self) -> str:
        domain = self.cleaned_data[CONFIG_MAILGUN_DOMAIN].strip().lower()
        match = DOMAIN_REGEX.fullmatch(domain)
        if domain and (not match or match["port"]):
            raise ValidationError(_("Enter a domain without a scheme, path or port, e.g. mg.example.com."))
        return domain

    def clean_mailgun_api_key(self) -> str:
        # the saved key is never rendered back to the browser
        return self.cleaned_data[CONFIG_MAILGUN_API_KEY] or self.instance.config.get(CONFIG_MAILGUN_API_KEY, "")

    def clean(self) -> dict:
        if self.cleaned_data.get(CONFIG_MAILGUN_DOMAIN):
            for key in (CONFIG_EMAIL_FROM, CONFIG_MAILGUN_API_KEY):
                if key in self.cleaned_data and not self.cleaned_data[key]:
                    self.add_error(key, _("Required to send emails."))
        else:
            self.cleaned_data[CONFIG_EMAIL_FROM] = ""
            self.cleaned_data[CONFIG_MAILGUN_API_KEY] = ""

        if self.errors:
            return self.cleaned_data

        return super().clean()
