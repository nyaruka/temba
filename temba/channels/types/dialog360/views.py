from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN
from temba.utils.fields import InputWidget

from ...models import Channel
from ...views import ALL_COUNTRIES, ClaimViewMixin, UpdateChannelForm


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        address = forms.CharField(label=_("Number"))
        country = forms.ChoiceField(choices=ALL_COUNTRIES, label=_("Country"))

        api_key = forms.CharField(max_length=256, help_text=_("Generated after registering your 360dialog account."))

        def clean(self):
            # first check that our phone number looks sane
            country = self.cleaned_data["country"]
            normalized = URN.normalize_number(self.cleaned_data["address"], country)
            if not URN.validate(URN.from_parts(URN.TEL_SCHEME, normalized), country):
                raise forms.ValidationError(_("Please enter a valid phone number"))
            self.cleaned_data["address"] = normalized
            return super().clean()

    form_class = Form

    def form_valid(self, form):
        data = form.cleaned_data
        config = {
            Channel.CONFIG_BASE_URL: "https://waba-v2.360dialog.io",
            Channel.CONFIG_AUTH_TOKEN: data["api_key"],
        }

        self.object = Channel.create(
            self.request.org,
            self.request.user,
            data["country"],
            self.channel_type,
            name="WhatsApp: %s" % data["address"],
            address=data["address"],
            config=config,
        )

        return super().form_valid(form)


class UpdateForm(UpdateChannelForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.add_config_field(
            Channel.CONFIG_AUTH_TOKEN,
            forms.CharField(
                max_length=256,
                label=_("API Key"),
                help_text=_("Generated after registering your 360dialog account."),
                widget=InputWidget(),
            ),
            default="",
        )

    class Meta(UpdateChannelForm.Meta):
        fields = ("name", "address", "is_enabled")
        readonly = ("address",)
