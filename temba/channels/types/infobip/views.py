import re

import phonenumbers
from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.channels.views import ALL_COUNTRIES, ClaimViewMixin
from temba.utils.fields import SelectWidget

from ...models import Channel

SUBDOMAIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$")


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        country = forms.ChoiceField(
            choices=ALL_COUNTRIES,
            widget=SelectWidget(attrs={"searchable": True}),
            label=_("Country"),
            help_text=_("The country this phone number is used in"),
        )
        number = forms.CharField(
            required=True,
            label=_("Originating Phone number"),
            help_text=_("The phone number being added"),
        )
        api_key = forms.CharField(
            required=True,
            label=_("Infobip API Key"),
            help_text=_("The API Key"),
        )
        subdomain = forms.CharField(
            required=True,
            max_length=63,
            label=_("Infobip API subdomain"),
            help_text=_(
                "The subdomain of your Infobip API base URL. For example, if your base URL is "
                "https://xxxxx.api.infobip.com, enter xxxxx. You can find this in the Infobip API Resource hub."
            ),
        )

        def clean_subdomain(self):
            value = self.cleaned_data["subdomain"].strip().lower()
            if not SUBDOMAIN_RE.match(value):
                raise forms.ValidationError(_("Enter a valid subdomain."))
            return value

        def clean_number(self):
            number = self.data["number"]

            # number is a shortcode, accept as is
            if len(number) > 0 and len(number) < 7:
                return number

            # otherwise, try to parse into an international format
            if number and number[0] != "+":
                number = "+" + number

            try:
                cleaned = phonenumbers.parse(number, None)
                return phonenumbers.format_number(cleaned, phonenumbers.PhoneNumberFormat.E164)
            except Exception:  # pragma: needs cover
                raise forms.ValidationError(
                    _("Invalid phone number, please include the country code. ex: +250788123123")
                )

    form_class = Form

    def form_valid(self, form):
        org = self.request.org
        number = form.cleaned_data.get("number")
        title = f"Infobip: {number}"
        api_key = form.cleaned_data.get("api_key")
        subdomain = form.cleaned_data.get("subdomain")
        country = form.cleaned_data.get("country")
        config = {
            Channel.CONFIG_API_KEY: api_key,
            Channel.CONFIG_BASE_URL: f"https://{subdomain}.api.infobip.com",
            Channel.CONFIG_CALLBACK_DOMAIN: org.get_brand_domain(),
        }

        self.object = Channel.create(
            self.request.org,
            self.request.user,
            country,
            self.channel_type,
            address=number,
            name=title,
            config=config,
        )

        return super().form_valid(form)
