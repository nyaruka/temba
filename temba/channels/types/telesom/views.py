from django import forms
from django.utils.translation import gettext_lazy as _

from temba.channels.models import Channel
from temba.channels.views import AuthenticatedExternalClaimView, ClaimViewMixin
from temba.utils.fields import ExternalURLField


class ClaimView(AuthenticatedExternalClaimView):
    class TelesomForm(ClaimViewMixin.Form):
        number = forms.CharField(max_length=14, min_length=1, label=_("Short Code"))
        url = ExternalURLField(label=_("Send URL"))
        username = forms.CharField(label=_("Username"))
        password = forms.CharField(label=_("Password"))
        secret = forms.CharField(label=_("Private Key"))

    form_class = TelesomForm

    def get_country(self, obj):
        return "Somalia"

    def get_submitted_country(self, data):  # pragma: needs cover
        return "SO"

    def form_valid(self, form):
        data = form.cleaned_data
        self.object = Channel.add_config_external_channel(
            self.request.org,
            self.request.user,
            "SO",
            data["number"],
            self.channel_type,
            dict(send_url=data["url"], username=data["username"], password=data["password"], secret=data["secret"]),
        )

        return super(AuthenticatedExternalClaimView, self).form_valid(form)
