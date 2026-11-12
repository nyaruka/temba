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
        shortcode = forms.CharField(label=_("Short Code"))
        service_id = forms.CharField(label=_("Service ID"))
        charging_level = forms.ChoiceField(
            choices=(("0", _("Free")), ("1", _("Billed"))),
            label=_("Charging Level"),
            help_text=_("Whether contacts are charged for the messages they're sent."),
        )
        username = forms.CharField(label=_("Username"))
        password = forms.CharField(label=_("Password"))

        def __init__(self, **kwargs):
            super().__init__(**kwargs)

            # most numbers are in the workspace's own country
            if country := self.request.org.default_country_code:
                self.fields["country"].initial = country

    form_class = Form

    def form_valid(self, form):
        data = form.cleaned_data
        config = {
            Channel.CONFIG_USERNAME: data["username"],
            Channel.CONFIG_PASSWORD: data["password"],
            "service_id": data["service_id"],
            "charging_level": data["charging_level"],
        }

        self.object = Channel.create(
            org=self.request.org,
            user=self.request.user,
            country=data["country"],
            channel_type=self.channel_type,
            name=data["shortcode"],
            address=data["shortcode"],
            config=config,
            schemes=[URN.TEL_SCHEME],
        )

        return super(ClaimViewMixin, self).form_valid(form)
