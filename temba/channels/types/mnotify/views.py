import phonenumbers
from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.utils.text import generate_secret

from ...models import Channel
from ...views import ClaimViewMixin

COUNTRY = "GH"


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        number = forms.CharField(max_length=16, min_length=4, label=_("Number"), help_text=_("e.g. 0501234567"))
        api_key = forms.CharField(max_length=128, label=_("API Key"))

        def clean_number(self):
            try:
                parsed = phonenumbers.parse(self.cleaned_data["number"], COUNTRY)
            except phonenumbers.NumberParseException:
                parsed = None

            if not parsed or not phonenumbers.is_possible_number(parsed):
                raise forms.ValidationError(_("Not a valid phone number."))

            return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)

    form_class = Form

    def form_valid(self, form):
        data = form.cleaned_data
        org = self.request.org

        config = {
            Channel.CONFIG_API_KEY: data["api_key"],
            Channel.CONFIG_SECRET: generate_secret(32),
            Channel.CONFIG_CALLBACK_DOMAIN: org.get_brand_domain(),
            Channel.CONFIG_MAX_CONCURRENT_CALLS: 10,
        }

        self.object = Channel.create(
            org,
            self.request.user,
            COUNTRY,
            self.channel_type,
            name=f"mNotify: {data['number']}",
            address=data["number"],
            config=config,
            role=Channel.ROLE_CALL + Channel.ROLE_ANSWER,
        )

        return super().form_valid(form)
