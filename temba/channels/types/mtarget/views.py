from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.channels.models import Channel
from temba.channels.views import ALL_COUNTRIES, ClaimViewMixin
from temba.contacts.models import URN
from temba.utils.fields import SelectWidget


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        country = forms.ChoiceField(
            choices=ALL_COUNTRIES, widget=SelectWidget(attrs={"searchable": True}), label=_("Country")
        )
        address = forms.CharField(label=_("Service ID"))
        username = forms.CharField(label=_("Username"))
        password = forms.CharField(label=_("Password"))

        def __init__(self, **kwargs):
            super().__init__(**kwargs)

            # most services are in the workspace's own country
            if country := self.request.org.default_country_code:
                self.fields["country"].initial = country

    form_class = Form

    def form_valid(self, form):
        data = form.cleaned_data
        config = {Channel.CONFIG_USERNAME: data["username"], Channel.CONFIG_PASSWORD: data["password"]}

        self.object = Channel.create(
            org=self.request.org,
            user=self.request.user,
            country=data["country"],
            channel_type=self.channel_type,
            name=data["address"],
            address=data["address"],
            config=config,
            schemes=[URN.TEL_SCHEME],
        )

        return super().form_valid(form)
