import phonenumbers

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.channels.views import ALL_COUNTRIES, AuthenticatedExternalCallbackClaimView, ClaimViewMixin
from temba.utils.fields import ExternalURLField, SelectWidget


class ClaimView(AuthenticatedExternalCallbackClaimView):
    class JasminForm(ClaimViewMixin.Form):
        country = forms.ChoiceField(
            choices=ALL_COUNTRIES, widget=SelectWidget(attrs={"searchable": True}), label=_("Country")
        )
        number = forms.CharField(max_length=14, min_length=3, label=_("Number"))
        url = ExternalURLField(
            widget=forms.URLInput(attrs={"placeholder": _("e.g. https://jasmin.example.com/send")}),
            label=_("URL"),
            help_text=_("The send path of your Jasmin server."),
        )
        username = forms.CharField(label=_("Username"))
        password = forms.CharField(label=_("Password"))

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

    form_class = JasminForm
