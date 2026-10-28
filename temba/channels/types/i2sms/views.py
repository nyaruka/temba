from django import forms
from django.utils.translation import gettext_lazy as _

from ...views import AuthenticatedExternalClaimView


class ClaimView(AuthenticatedExternalClaimView):
    class Form(AuthenticatedExternalClaimView.Form):
        channel_hash = forms.CharField(max_length=42)
        username = forms.CharField(label=_("Username"))
        password = forms.CharField(label=_("Password"))

    form_class = Form

    def get_channel_config(self, org, data):
        return dict(channel_hash=data["channel_hash"])
