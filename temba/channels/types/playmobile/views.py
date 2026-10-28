from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.utils.fields import ExternalURLField

from ...models import Channel
from ...views import ClaimViewMixin


class ClaimView(ClaimViewMixin, SmartFormView):
    class PMClaimForm(ClaimViewMixin.Form):
        base_url = ExternalURLField(label=_("Base URL"))
        shortcode = forms.CharField(label=_("Shortcode"), max_length=15, min_length=1)
        username = forms.CharField(label=_("Username"))
        password = forms.CharField(label=_("Password"))

    form_class = PMClaimForm

    def form_valid(self, form):
        data = form.cleaned_data
        config = {
            Channel.CONFIG_BASE_URL: data["base_url"],
            Channel.CONFIG_USERNAME: data["username"],
            Channel.CONFIG_PASSWORD: data["password"],
        }

        self.object = Channel.create(
            self.request.org,
            self.request.user,
            "UZ",
            self.channel_type,
            name=data["shortcode"],
            address=data["shortcode"],
            config=config,
        )

        return super(ClaimView, self).form_valid(form)
