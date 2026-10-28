from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.utils.fields import SelectWidget

from ...models import Channel
from ...views import ClaimViewMixin


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        shortcode = forms.CharField(max_length=6, min_length=1)
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
        )
        is_shared = forms.BooleanField(
            initial=False,
            required=False,
            help_text=_("Marks the short code as shared with other Africa's Talking accounts."),
        )
        username = forms.CharField(max_length=32)
        api_key = forms.CharField(max_length=128)

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
