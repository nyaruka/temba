from smartmin.views import SmartFormView

from django import forms
from django.core.exceptions import ValidationError
from django.utils.translation import gettext_lazy as _

from temba.channels.models import Channel
from temba.channels.views import ALL_COUNTRIES, ClaimViewMixin
from temba.utils.fields import SelectWidget


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        number = forms.CharField(max_length=14, min_length=1, label=_("Number"))
        country = forms.ChoiceField(
            choices=ALL_COUNTRIES, widget=SelectWidget(attrs={"searchable": True}), label=_("Country")
        )

        api_key = forms.CharField(label=_("API Key"))
        api_secret = forms.CharField(label=_("API Secret"))

        def __init__(self, **kwargs):
            super().__init__(**kwargs)

            # most numbers are in the workspace's own country
            if country := self.request.org.default_country_code:
                self.fields["country"].initial = country

    form_class = Form

    def form_valid(self, form):
        data = form.cleaned_data

        country = data["country"]

        config = {Channel.CONFIG_API_KEY: data["api_key"], Channel.CONFIG_SECRET: data["api_secret"]}

        # activating registers our webhooks with JustCall, and the channel is removed again if that fails, e.g.
        # because the key or secret is wrong
        try:
            self.object = Channel.add_config_external_channel(
                self.request.org,
                self.request.user,
                country,
                data["number"],
                self.channel_type,
                config,
                role=Channel.ROLE_SEND + Channel.ROLE_RECEIVE,
            )
        except ValidationError as e:
            form.add_error(None, e)
            return self.form_invalid(form)

        return super(ClaimView, self).form_valid(form)
