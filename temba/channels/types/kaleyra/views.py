from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN
from temba.utils.fields import SelectWidget

from ...models import Channel
from ...views import ALL_COUNTRIES, ClaimViewMixin


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        number = forms.CharField(label=_("Number"))
        country = forms.ChoiceField(
            choices=ALL_COUNTRIES, widget=SelectWidget(attrs={"searchable": True}), label=_("Country")
        )
        account_sid = forms.CharField(label=_("SID"))
        api_key = forms.CharField(label=_("API Key"))

        def __init__(self, **kwargs):
            super().__init__(**kwargs)

            # most numbers are in the workspace's own country
            if country := self.request.org.default_country_code:
                self.fields["country"].initial = country

        def clean_number(self):
            # check that our phone number looks sane
            country = self.data["country"]
            number = URN.normalize_number(self.data["number"], country)
            if not URN.validate(URN.from_parts(URN.TEL_SCHEME, number), country):
                raise forms.ValidationError(_("Please enter a valid phone number"))
            return number

    form_class = Form

    def form_valid(self, form):
        from .type import CONFIG_ACCOUNT_SID, CONFIG_API_KEY

        data = form.cleaned_data
        config = {
            CONFIG_ACCOUNT_SID: data["account_sid"],
            CONFIG_API_KEY: data["api_key"],
        }

        self.object = Channel.create(
            self.request.org,
            self.request.user,
            data["country"],
            "KWA",
            name="Kaleyra WhatsApp: %s" % data["number"],
            address=data["number"],
            config=config,
        )

        return super().form_valid(form)
