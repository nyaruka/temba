from smartmin.views import SmartFormView

from django import forms
from django.core.exceptions import ValidationError
from django.utils.translation import gettext_lazy as _

from temba.utils.fields import SelectWidget

from ...models import Channel
from ...views import ALL_COUNTRIES, ClaimViewMixin


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        number = forms.CharField(max_length=14, min_length=1, label=_("Number"))
        country = forms.ChoiceField(
            choices=ALL_COUNTRIES, widget=SelectWidget(attrs={"searchable": True}), label=_("Country")
        )
        consumer_key = forms.CharField(required=True, label=_("Consumer Key"))
        consumer_secret = forms.CharField(required=True, label=_("Consumer Secret"))
        cp_address = forms.CharField(
            required=False, label=_("CP Address"), help_text=_("Only needed if MTN provided one.")
        )

        def __init__(self, **kwargs):
            super().__init__(**kwargs)

            # most numbers are in the workspace's own country
            if country := self.request.org.default_country_code:
                self.fields["country"].initial = country

    form_class = Form

    def form_valid(self, form):
        cleaned_data = form.cleaned_data

        country = cleaned_data["country"]
        number = cleaned_data["number"]
        config = {
            Channel.CONFIG_API_KEY: cleaned_data.get("consumer_key"),
            Channel.CONFIG_AUTH_TOKEN: cleaned_data.get("consumer_secret"),
        }

        if cleaned_data.get("cp_address"):
            config[self.channel_type.CP_ADDRESS] = cleaned_data.get("cp_address")

        # activating subscribes to the number's messages with MTN, and the channel is removed again if that fails
        try:
            self.object = Channel.create(
                self.request.org,
                self.request.user,
                country,
                self.channel_type,
                name="",
                address=number,
                config=config,
                schemes=("tel",),
            )
        except ValidationError as e:
            form.add_error(None, e)
            return self.form_invalid(form)

        return super(ClaimView, self).form_valid(form)
