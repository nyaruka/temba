from smartmin.views import SmartFormView

from django import forms
from django.core.exceptions import ValidationError
from django.utils.translation import gettext_lazy as _

from temba.channels.types.whatsapp.views import add_direct_send_field
from temba.contacts.models import URN
from temba.utils.fields import InputWidget, SelectWidget

from ...models import Channel
from ...views import ALL_COUNTRIES, ClaimViewMixin, UpdateChannelForm

BASE_URL = "https://waba-v2.360dialog.io"


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        address = forms.CharField(label=_("Number"))
        country = forms.ChoiceField(
            choices=ALL_COUNTRIES, widget=SelectWidget(attrs={"searchable": True}), label=_("Country")
        )

        api_key = forms.CharField(max_length=256, label=_("API Key"))

        def __init__(self, **kwargs):
            super().__init__(**kwargs)

            # most numbers are in the workspace's own country
            if country := self.request.org.default_country_code:
                self.fields["country"].initial = country

        def clean(self):
            # first check that our phone number looks sane
            country = self.cleaned_data.get("country")
            address = self.cleaned_data.get("address")
            if not country or not address:
                return self.cleaned_data

            normalized = URN.normalize_number(address, country)
            if not URN.validate(URN.from_parts(URN.TEL_SCHEME, normalized), country):
                self.add_error("address", _("Please enter a valid phone number"))
                return self.cleaned_data

            self.cleaned_data["address"] = normalized

            # check the key works before connecting, as a channel which can't send is no use
            api_key = self.cleaned_data.get("api_key")
            if api_key and not self.channel_type.check_credentials(
                {Channel.CONFIG_BASE_URL: BASE_URL, Channel.CONFIG_AUTH_TOKEN: api_key}
            ):
                self.add_error("api_key", _("This API key isn't working. Check it's the latest one for your number."))
                return self.cleaned_data

            return super().clean()

    form_class = Form

    def form_valid(self, form):
        data = form.cleaned_data
        config = {Channel.CONFIG_BASE_URL: BASE_URL, Channel.CONFIG_AUTH_TOKEN: data["api_key"]}

        # activating registers our webhook with 360dialog, and the channel is removed again if that fails
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
        except ValidationError as e:
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
                label=_("API Key"),
                help_text=_("Generated after registering your 360dialog account."),
                widget=InputWidget(),
            ),
            default="",
        )
        add_direct_send_field(self)

    class Meta(UpdateChannelForm.Meta):
        fields = ("name", "address", "is_enabled")
        readonly = ("address",)
