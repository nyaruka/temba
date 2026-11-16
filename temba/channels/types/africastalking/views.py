from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.utils.fields import SelectWidget

from ...models import Channel
from ...views import ClaimViewMixin


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        shortcode = forms.CharField(max_length=6, min_length=1, label=_("Short Code"))
        country = forms.ChoiceField(
            choices=(
                ("BJ", ("Benin")),
                ("BW", ("Botswana")),
                ("CM", ("Cameroon")),
                ("CI", ("Côte d'Ivoire")),
                ("SZ", ("Eswatini")),
                ("ET", ("Ethiopia")),
                ("GH", ("Ghana")),
                ("KE", ("Kenya")),
                ("LS", ("Lesotho")),
                ("MW", ("Malawi")),
                ("ML", ("Mali")),
                ("NA", ("Namibia")),
                ("NG", ("Nigeria")),
                ("RW", ("Rwanda")),
                ("SN", ("Senegal")),
                ("ZA", ("South Africa")),
                ("TZ", ("Tanzania")),
                ("UG", ("Uganda")),
                ("ZM", ("Zambia")),
                ("ZW", ("Zimbabwe")),
                ("BF", ("Burkina Faso")),
            ),
            widget=SelectWidget(attrs={"searchable": True}),
            label=_("Country"),
        )
        is_shared = forms.BooleanField(
            initial=False,
            required=False,
            label=_("Shared"),
            help_text=_("Marks the short code as shared with other Africa's Talking accounts."),
        )
        username = forms.CharField(max_length=32, label=_("Username"))
        api_key = forms.CharField(max_length=128, label=_("API Key"))

        def __init__(self, **kwargs):
            super().__init__(**kwargs)

            # most short codes are in the workspace's own country
            country = self.request.org.default_country_code
            if country and country in dict(self.fields["country"].choices):
                self.fields["country"].initial = country

    form_class = Form

    def form_valid(self, form):
        user = self.request.user
        org = self.request.org
        data = form.cleaned_data
        config = dict(username=data["username"], api_key=data["api_key"], is_shared=data["is_shared"])

        self.object = Channel.create(
            org,
            user,
            data["country"],
            self.channel_type,
            name="Africa's Talking: %s" % data["shortcode"],
            address=data["shortcode"],
            config=config,
        )

        return super().form_valid(form)
