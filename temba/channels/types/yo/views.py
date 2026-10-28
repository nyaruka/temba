import phonenumbers

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.channels.views import ALL_COUNTRIES, AuthenticatedExternalClaimView, ClaimViewMixin
from temba.utils.fields import SelectWidget


class ClaimView(AuthenticatedExternalClaimView):
    class YoClaimForm(ClaimViewMixin.Form):
        country = forms.ChoiceField(
            choices=ALL_COUNTRIES, widget=SelectWidget(attrs={"searchable": True}), label=_("Country")
        )
        number = forms.CharField(
            max_length=14,
            min_length=1,
            label=_("Number"),
            help_text=_("A phone number with country code or a short code, e.g. +250788123124 or 15543."),
        )
        username = forms.CharField(label=_("Account Number"))
        password = forms.CharField(label=_("Gateway Password"))

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

    form_class = YoClaimForm

    def get_country(self, obj):
        return "Uganda"

    def get_submitted_country(self, data):
        return "UG"
