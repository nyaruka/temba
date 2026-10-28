from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.utils.fields import ExternalURLField, SelectWidget
from temba.utils.uuid import uuid4

from ...models import Channel
from ...views import ALL_COUNTRIES, ClaimViewMixin


class ClaimView(ClaimViewMixin, SmartFormView):
    class KannelClaimForm(ClaimViewMixin.Form):
        number = forms.CharField(max_length=14, min_length=1, label=_("Number"))
        country = forms.ChoiceField(
            choices=ALL_COUNTRIES, widget=SelectWidget(attrs={"searchable": True}), label=_("Country")
        )
        url = ExternalURLField(
            max_length=1024,
            label=_("Send URL"),
            help_text=_("Must be publicly accessible, e.g. https://kannel.example.com/cgi-bin/sendsms."),
        )
        username = forms.CharField(
            max_length=64,
            required=False,
            help_text=_("Generated automatically if left blank."),
        )
        password = forms.CharField(
            max_length=64,
            required=False,
            help_text=_("Generated automatically if left blank."),
        )
        encoding = forms.ChoiceField(choices=Channel.ENCODING_CHOICES, label=_("Encoding"))
        use_national = forms.BooleanField(
            initial=False,
            required=False,
            label=_("Use National Numbers"),
            help_text=_("Sends to numbers without their country code, which isn't recommended."),
        )

    form_class = KannelClaimForm

    def form_valid(self, form):
        org = self.request.org
        data = form.cleaned_data

        country = data["country"]
        url = data["url"]
        number = data["number"]
        role = Channel.ROLE_SEND + Channel.ROLE_RECEIVE

        config = {
            Channel.CONFIG_SEND_URL: url,
            Channel.CONFIG_USE_NATIONAL: data.get("use_national", False),
            Channel.CONFIG_USERNAME: data.get("username", None),
            Channel.CONFIG_PASSWORD: data.get("password", None),
            Channel.CONFIG_ENCODING: data.get("encoding", Channel.ENCODING_DEFAULT),
            Channel.CONFIG_CALLBACK_DOMAIN: org.get_brand_domain(),
        }
        self.object = Channel.add_config_external_channel(
            org, self.request.user, country, number, "KN", config, role=role
        )

        # if they didn't set a username or password, generate them, we do this after the addition above
        # because we use the channel id in the configuration
        config = self.object.config
        if not config.get(Channel.CONFIG_USERNAME, None):
            config[Channel.CONFIG_USERNAME] = "%s_%d" % (self.request.branding["name"].lower(), self.object.pk)

        if not config.get(Channel.CONFIG_PASSWORD, None):
            config[Channel.CONFIG_PASSWORD] = str(uuid4())

        self.object.config = config
        self.object.save()

        return super().form_valid(form)
