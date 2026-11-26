import requests
from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN
from temba.request_logs.models import HTTPLog
from temba.utils.fields import InputWidget, SelectWidget

from ...models import Channel
from ...views import ALL_COUNTRIES, ClaimViewMixin, UpdateChannelForm

BASE_URL = "https://whatsapp.turn.io"

API_TOKEN_HELP = _(
    "Created in the Turn.io settings under API & Webhooks, with an expiry date after which the channel stops working."
)


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        address = forms.CharField(label=_("Number"))
        country = forms.ChoiceField(
            widget=SelectWidget(attrs={"searchable": True}), choices=ALL_COUNTRIES, label=_("Country")
        )
        api_token = forms.CharField(max_length=256, label=_("API Token"), help_text=API_TOKEN_HELP)

        access_token = forms.CharField(
            max_length=256, label=_("Access Token"), help_text=_("Used to sync WhatsApp templates.")
        )

        namespace = forms.CharField(
            max_length=128, label=_("Namespace"), help_text=_("The namespace of your WhatsApp templates.")
        )

        def __init__(self, **kwargs):
            super().__init__(**kwargs)

            # most numbers are in the workspace's own country
            if country := self.request.org.default_country_code:
                self.fields["country"].initial = country

        def clean(self):
            # the checks below need all of these, and missing ones already have their own errors
            if not all(self.cleaned_data.get(f) for f in ("country", "address", "api_token", "access_token")):
                return self.cleaned_data

            # first check that our phone number looks sane
            country = self.cleaned_data["country"]
            normalized = URN.normalize_number(self.cleaned_data["address"], country)
            if not URN.validate(URN.from_parts(URN.TEL_SCHEME, normalized), country):
                self.add_error("address", _("Please enter a valid phone number"))
                return self.cleaned_data
            self.cleaned_data["address"] = normalized

            # check the token before trying to create a channel with it
            config = {Channel.CONFIG_BASE_URL: BASE_URL, Channel.CONFIG_AUTH_TOKEN: self.cleaned_data["api_token"]}
            if not self.channel_type.check_credentials(config):
                self.add_error("api_token", _("Unable to access Turn.io with this token."))
                return self.cleaned_data

            # check we can access their messages templates
            from .type import TEMPLATE_LIST_URL

            response = requests.get(
                TEMPLATE_LIST_URL % ("whatsapp.turn.io", "v14.0", normalized.lstrip("+")),
                params=dict(access_token=self.cleaned_data["access_token"]),
            )

            if response.status_code != 200:
                raise forms.ValidationError(_("Unable to access Messages templates from turn.io"))
            return super().clean()

    form_class = Form

    def form_valid(self, form):
        from .type import (
            CONFIG_FB_ACCESS_TOKEN,
            CONFIG_FB_BUSINESS_ID,
            CONFIG_FB_NAMESPACE,
            CONFIG_FB_TEMPLATE_LIST_DOMAIN,
        )

        data = form.cleaned_data
        config = {
            Channel.CONFIG_BASE_URL: BASE_URL,
            Channel.CONFIG_AUTH_TOKEN: data["api_token"],
            CONFIG_FB_BUSINESS_ID: data["address"].lstrip("+"),
            CONFIG_FB_ACCESS_TOKEN: data["access_token"],
            CONFIG_FB_NAMESPACE: data["namespace"],
            CONFIG_FB_TEMPLATE_LIST_DOMAIN: "whatsapp.turn.io",
        }

        try:
            self.object = Channel.create(
                self.request.org,
                self.request.user,
                data["country"],
                self.channel_type,
                name="WhatsApp: %s" % data["address"],
                address=data["address"],
                config=config,
            )
        except forms.ValidationError as e:
            form.add_error(None, e)
            return self.form_invalid(form)

        return super().form_valid(form)


class UpdateForm(UpdateChannelForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.add_config_field(
            Channel.CONFIG_AUTH_TOKEN,
            forms.CharField(
                max_length=256,
                label=_("API Token"),
                help_text=_("Replaces the token the channel is using, which is kept if this is blank."),
                widget=InputWidget(),
                required=False,
            ),
            default="",
        )

        # the current token isn't shown - one generated from login credentials can be replaced by a refresh while the
        # form is open, and submitting it back unchanged would then look like a new token
        self.fields[Channel.CONFIG_AUTH_TOKEN].initial = ""

    def get_config_values(self):
        values = super().get_config_values()
        if not values.get(Channel.CONFIG_AUTH_TOKEN):
            values.pop(Channel.CONFIG_AUTH_TOKEN, None)
        return values

    def save(self, commit=True):
        token = self.cleaned_data[Channel.CONFIG_AUTH_TOKEN]

        # a channel given a new token no longer needs the login credentials that were used to generate tokens for it,
        # and keeping them would have its token replaced, and so invalidated, by the next refresh
        if token and token != self.instance.config.get(Channel.CONFIG_AUTH_TOKEN):
            self.instance.config.pop(Channel.CONFIG_USERNAME, None)
            self.instance.config.pop(Channel.CONFIG_PASSWORD, None)

            # the logs of those tokens being generated include them, and only the current token is redacted
            self.instance.http_logs.filter(log_type=HTTPLog.WHATSAPP_TOKENS_SYNCED).delete()

        return super().save(commit=commit)

    class Meta(UpdateChannelForm.Meta):
        fields = ("name", "address", "is_enabled")
        readonly = ("address",)
