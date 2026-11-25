import re

import phonenumbers
import requests
from smartmin.views import SmartFormView

from django import forms
from django.forms import ValidationError
from django.utils.translation import gettext_lazy as _

from temba.utils.fields import SelectWidget

from ...models import Channel
from ...views import ALL_COUNTRIES, ClaimViewMixin

SPACE_RE = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$")


class SignalWireClaimView(ClaimViewMixin, SmartFormView):
    class SignalWireForm(ClaimViewMixin.Form):
        country = forms.ChoiceField(
            choices=ALL_COUNTRIES,
            widget=SelectWidget(attrs={"searchable": True}),
            label=_("Country"),
            help_text=_("The country this phone number is used in"),
            initial="US",
        )
        number = forms.CharField(
            max_length=14,
            min_length=1,
            label=_("Number"),
            help_text=_("The phone number or short code you are connecting."),
        )
        space = forms.CharField(
            max_length=63,
            label=_("Space"),
            help_text=_("Your SignalWire Space name. For example, if your space is rapid.signalwire.com, enter rapid."),
        )
        project_key = forms.CharField(
            max_length=64,
            label=_("Project Key"),
            help_text=_("The key for your project ex: 990c5c10-bf8f-4156-b014-44282e60b3a1"),
        )
        api_token = forms.CharField(
            max_length=64,
            required=False,
            help_text=_("The API token to use to authenticate ex: FPd199eb93e878f8a3tw9ttna313914tnauwy"),
        )

        def clean_space(self):
            value = self.cleaned_data["space"].strip().lower()
            if not SPACE_RE.match(value):
                raise forms.ValidationError(_("Enter a valid space name."))
            return value

        def clean(self):
            sid = self.cleaned_data.get("project_key")
            token = self.cleaned_data.get("api_token")
            space = self.cleaned_data.get("space")
            number = self.cleaned_data.get("number")
            country = self.cleaned_data.get("country")

            if not (space and number and country):
                return self.cleaned_data

            domain = f"{space}.signalwire.com"

            address = number
            if len(number) > 6:
                parsed_number = phonenumbers.parse(number=number, region=country)
                address = phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.E164)

            phone_sid = ""
            try:
                response = requests.get(
                    f"https://{domain}/api/laml/2010-04-01/Accounts/{sid}/IncomingPhoneNumbers.json", auth=(sid, token)
                )
                response.raise_for_status()

                response_json = response.json()

                for phone in response_json.get("incoming_phone_numbers", []):
                    if phone.get("phone_number", "") == address:
                        phone_sid = phone.get("sid", "")
                        break
            except Exception:
                raise ValidationError("Unable to connect to SignalWire, please check your space, key and token")

            if phone_sid == "":
                raise ValidationError(f"Unable to find phone with number {number} on your account")

            return self.cleaned_data

    form_class = SignalWireForm

    def form_valid(self, form):
        user = self.request.user
        org = self.request.org
        data = form.cleaned_data

        country = data.get("country")
        number = data.get("number")
        space = data.get("space")
        domain = f"{space}.signalwire.com"
        sid = data.get("project_key")
        token = data.get("api_token")

        role = Channel.ROLE_SEND + Channel.ROLE_RECEIVE
        address = number

        # parse our long code to figure out our name
        if len(number) > 6:
            parsed_number = phonenumbers.parse(number=number, region=country)
            address = phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.E164)
            name = phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.NATIONAL)
            role = Channel.ROLE_SEND + Channel.ROLE_RECEIVE + Channel.ROLE_CALL + Channel.ROLE_ANSWER

        config = {
            Channel.CONFIG_BASE_URL: f"https://{domain}/api/laml",
            Channel.CONFIG_ACCOUNT_SID: sid,
            Channel.CONFIG_AUTH_TOKEN: token,
            Channel.CONFIG_CALLBACK_DOMAIN: org.get_brand_domain(),
        }

        self.object = Channel.create(
            org, user, country, self.channel_type, name=name, address=address, config=config, role=role
        )
        return super().form_valid(form)
