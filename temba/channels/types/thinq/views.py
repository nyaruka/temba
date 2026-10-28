import phonenumbers
from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from ...models import Channel
from ...views import ClaimViewMixin


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        account_id = forms.IntegerField()
        number = forms.CharField(min_length=10)
        country = forms.ChoiceField(choices=(("US", _("United States")),))
        token_user = forms.CharField(help_text=_("The username for your API token."))
        token = forms.CharField()

        def clean_number(self):
            number = self.data["number"]
            try:
                cleaned = phonenumbers.parse(number, self.data["country"])
                return phonenumbers.format_number(cleaned, phonenumbers.PhoneNumberFormat.E164)
            except Exception:  # pragma: no cover
                raise forms.ValidationError(
                    _("Invalid phone number, please include the country code. ex: +12065551212")
                )

    form_class = Form

    def form_valid(self, form):
        from .type import ThinQType

        data = form.cleaned_data
        config = {
            ThinQType.CONFIG_ACCOUNT_ID: str(data["account_id"]),
            ThinQType.CONFIG_API_TOKEN_USER: data["token_user"],
            ThinQType.CONFIG_API_TOKEN: data["token"],
        }

        self.object = Channel.create(
            self.request.org, self.request.user, data["country"], ThinQType.code, address=data["number"], config=config
        )

        return super().form_valid(form)
