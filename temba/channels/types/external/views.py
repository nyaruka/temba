import json

from smartmin.views import SmartFormView

from django import forms
from django.core.validators import MaxValueValidator, MinValueValidator
from django.forms import ValidationError
from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN
from temba.utils.fields import ExternalURLField, InputWidget, SelectMultipleWidget, SelectWidget

from ...models import Channel
from ...views import ALL_COUNTRIES, ClaimViewMixin, UpdateChannelForm


class ClaimView(ClaimViewMixin, SmartFormView):
    class ClaimForm(ClaimViewMixin.Form):
        scheme = forms.ChoiceField(choices=URN.SCHEME_CHOICES, label=_("URN Type"))

        # number or address is required depending on the scheme, see clean
        number = forms.CharField(
            max_length=14,
            min_length=1,
            label=_("Number"),
            required=False,
            widget=InputWidget(attrs={"optional": False}),
        )

        address = forms.CharField(
            max_length=64,
            min_length=1,
            label=_("Address"),
            required=False,
            widget=InputWidget(attrs={"optional": False}),
        )

        country = forms.ChoiceField(
            choices=ALL_COUNTRIES, label=_("Country"), required=False, widget=SelectWidget(attrs={"searchable": True})
        )

        method = forms.ChoiceField(choices=(("POST", "HTTP POST"), ("GET", "HTTP GET"), ("PUT", "HTTP PUT")))

        encoding = forms.ChoiceField(choices=Channel.ENCODING_CHOICES, label=_("Encoding"))

        content_type = forms.ChoiceField(choices=Channel.CONTENT_TYPE_CHOICES)

        max_length = forms.IntegerField(
            initial=160,
            validators=[MaxValueValidator(6400), MinValueValidator(60)],
            help_text=_("Longer messages are split into multiple messages."),
        )

        send_authorization = forms.CharField(max_length=2048, label=_("Authorization Header Value"), required=False)

        url = ExternalURLField(
            max_length=1024,
            label=_("Send URL"),
            help_text=_("Can include variable substitutions."),
        )

        body = forms.CharField(
            max_length=2048,
            label=_("Request Body"),
            required=False,
            widget=forms.Textarea,
            help_text=_("Can include variable substitutions and is only used for PUT and POST requests."),
        )

        mt_response_check = forms.CharField(
            max_length=2048,
            label=_("MT Response check"),
            required=False,
            widget=forms.Textarea,
            help_text=_("Content that must be in the response for the request to be considered successful."),
        )

        def clean(self):
            from .type import ExternalType

            cleaned_data = super().clean()
            scheme = cleaned_data.get("scheme")
            if scheme == URN.TEL_SCHEME and not cleaned_data.get("number"):
                raise ValidationError({"number": _("This field is required.")})
            elif scheme != URN.TEL_SCHEME and not cleaned_data.get("address"):
                raise ValidationError({"address": _("This field is required.")})

            content_type = cleaned_data.get("content_type")

            variables = {
                "text": "",
                "from": "",
                "from_no_plus": "",
                "to": "",
                "to_no_plus": "",
                "uuid": "",
                "quick_replies": "",
                "channel": "",
            }
            replaced_body = ExternalType.replace_variables(
                cleaned_data.get("body"), variables, content_type=content_type
            )
            if content_type == Channel.CONTENT_TYPE_JSON:
                try:
                    json.loads(replaced_body)
                except json.decoder.JSONDecodeError:
                    raise ValidationError({"body": _("Invalid JSON, make sure to remove quotes around variables")})

    class SendClaimForm(ClaimViewMixin.Form):
        url = ExternalURLField(
            max_length=1024,
            label=_("Send URL"),
            help_text=_("Can include variable substitutions."),
        )

        method = forms.ChoiceField(choices=(("POST", "HTTP POST"), ("GET", "HTTP GET"), ("PUT", "HTTP PUT")))

        encoding = forms.ChoiceField(choices=Channel.ENCODING_CHOICES, label=_("Encoding"))

        content_type = forms.ChoiceField(choices=Channel.CONTENT_TYPE_CHOICES)

        max_length = forms.IntegerField(
            initial=160,
            validators=[MaxValueValidator(6400), MinValueValidator(60)],
            help_text=_("Longer messages are split into multiple messages."),
        )

        send_authorization = forms.CharField(max_length=2048, label=_("Authorization Header Value"), required=False)

        body = forms.CharField(
            max_length=2048,
            label=_("Request Body"),
            required=False,
            widget=forms.Textarea,
            help_text=_("Can include variable substitutions and is only used for PUT and POST requests."),
        )

        mt_response_check = forms.CharField(
            max_length=2048,
            label=_("MT Response check"),
            required=False,
            widget=forms.Textarea,
            help_text=_("Content that must be in the response for the request to be considered successful."),
        )

    title = _("Connect External Service")
    permission = "channels.channel_claim"
    success_url = "uuid@channels.channel_configuration"

    def derive_initial(self):
        from .type import ExternalType

        return {"body": ExternalType.CONFIG_DEFAULT_SEND_BODY, "scheme": URN.TEL_SCHEME}

    def get_form_class(self):
        if self.request.GET.get("role", None) == "S":  # pragma: needs cover
            return ClaimView.SendClaimForm
        else:
            return ClaimView.ClaimForm

    def form_valid(self, form):
        from .type import ExternalType

        org = self.request.org
        data = form.cleaned_data

        role = Channel.ROLE_SEND + Channel.ROLE_RECEIVE
        scheme = data["scheme"]
        if scheme == URN.TEL_SCHEME:
            address = data["number"]
            country = data["country"]
        else:
            address = data["address"]
            country = None

        config = {
            Channel.CONFIG_SEND_URL: data["url"],
            ExternalType.CONFIG_SEND_METHOD: data["method"],
            ExternalType.CONFIG_CONTENT_TYPE: data["content_type"],
            ExternalType.CONFIG_MAX_LENGTH: data["max_length"],
            Channel.CONFIG_ENCODING: data.get("encoding", Channel.ENCODING_DEFAULT),
        }

        if "send_authorization" in data:
            config[ExternalType.CONFIG_SEND_AUTHORIZATION] = data["send_authorization"]

        if "body" in data:
            config[ExternalType.CONFIG_SEND_BODY] = data["body"]

        if "mt_response_check" in data:
            config[ExternalType.CONFIG_MT_RESPONSE_CHECK] = data["mt_response_check"]

        self.object = Channel.add_config_external_channel(
            org, self.request.user, country, address, self.channel_type, config, role, [scheme]
        )

        return super().form_valid(form)


class UpdateForm(UpdateChannelForm):
    role = forms.MultipleChoiceField(
        choices=((Channel.ROLE_RECEIVE, _("Receive")), (Channel.ROLE_SEND, _("Send"))),
        widget=SelectMultipleWidget(attrs={"widget_only": True}),
        label=_("Channel Role"),
    )

    def clean_role(self):
        return "".join(self.cleaned_data.get("role", []))

    class Meta(UpdateChannelForm.Meta):
        fields = "name", "role", "is_enabled"
        readonly = []
