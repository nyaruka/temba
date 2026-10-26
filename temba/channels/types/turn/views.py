import requests
from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN
from temba.utils.fields import SelectWidget

from ...models import Channel
from ...views import ALL_COUNTRIES, ClaimViewMixin


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        address = forms.CharField(help_text=_("Your enterprise Turn.io WhatsApp number"), label=_("Number"))
        country = forms.ChoiceField(
            widget=SelectWidget(attrs={"searchable": True}),
            choices=ALL_COUNTRIES,
            label=_("Country"),
            help_text=_("The country this phone number is used in"),
        )
        username = forms.CharField(
            max_length=32, help_text=_("The username to access your Turn.io WhatsApp enterprise account")
        )
        password = forms.CharField(
            max_length=64, help_text=_("The password to access your Turn.io WhatsApp enterprise account")
        )

        access_token = forms.CharField(
            max_length=256, help_text=_("The access token that will be used for syncing WhatsApp templates")
        )

        namespace = forms.CharField(max_length=128, help_text=_("The namespace for your Turn.io WhatsApp templates"))

        def clean(self):
            # first check that our phone number looks sane
            country = self.cleaned_data["country"]
            normalized = URN.normalize_number(self.cleaned_data["address"], country)
            if not URN.validate(URN.from_parts(URN.TEL_SCHEME, normalized), country):
                raise forms.ValidationError(_("Please enter a valid phone number"))
            self.cleaned_data["address"] = normalized

            try:
                resp = requests.post(
                    "https://whatsapp.turn.io/v1/users/login",
                    auth=(self.cleaned_data["username"], self.cleaned_data["password"]),
                )

                if resp.status_code != 200:
                    raise Exception("Received non-200 response: %d", resp.status_code)

                self.cleaned_data["auth_token"] = resp.json()["users"][0]["token"]

            except Exception:
                raise forms.ValidationError(
                    _("Unable to check WhatsApp enterprise account, please check username and password")
                )

            # check we can access their messages templates
            from .type import TEMPLATE_LIST_URL

            response = requests.get(
                TEMPLATE_LIST_URL % ("whatsapp.turn.io", "v14.0", normalized.lstrip("+")),
                params=dict(access_token=self.cleaned_data["access_token"]),
            )

            if response.status_code != 200:
                raise forms.ValidationError(_("Unable to access Messages templates from turn.io"))
            return super().clean()

    form_class = Form

    def form_valid(self, form):
        from .type import (
            CONFIG_FB_ACCESS_TOKEN,
            CONFIG_FB_BUSINESS_ID,
            CONFIG_FB_NAMESPACE,
            CONFIG_FB_TEMPLATE_LIST_DOMAIN,
        )

        data = form.cleaned_data
        config = {
            Channel.CONFIG_BASE_URL: "https://whatsapp.turn.io",
            Channel.CONFIG_USERNAME: data["username"],
            Channel.CONFIG_PASSWORD: data["password"],
            Channel.CONFIG_AUTH_TOKEN: data["auth_token"],
            CONFIG_FB_BUSINESS_ID: data["address"].lstrip("+"),
            CONFIG_FB_ACCESS_TOKEN: data["access_token"],
            CONFIG_FB_NAMESPACE: data["namespace"],
            CONFIG_FB_TEMPLATE_LIST_DOMAIN: "whatsapp.turn.io",
        }

        try:
            self.object = Channel.create(
                self.request.org,
                self.request.user,
                data["country"],
                self.channel_type,
                name="WhatsApp: %s" % data["address"],
                address=data["address"],
                config=config,
            )
        except forms.ValidationError as e:
            form.add_error(None, e)
            return self.form_invalid(form)

        return super().form_valid(form)
