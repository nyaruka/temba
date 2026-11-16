import requests

from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI
from .views import ClaimView, UpdateForm


class ViberType(ChannelType):
    """
    A Viber public account channel (https://www.viber.com/public-accounts/)
    """

    code = "VP"
    name = "Viber"
    category = ChannelType.Category.SOCIAL_MEDIA

    unique_addresses = True

    schemes = [URN.VIBER_SCHEME]

    update_form = UpdateForm

    claim_view = ClaimView
    claim_blurb = _(
        "A %(link)s bot lets contacts find your business in Viber and message it, and reply with photos, videos, "
        "stickers and locations or by tapping buttons. Contacts who open a conversation with your bot can be greeted "
        "with a welcome message before they've subscribed to it."
    ) % {"link": '<a target="_blank" href="https://www.viber.com/">Viber</a>'}

    config_ui = ConfigUI(
        blurb=_("Your Viber channel is connected. If needed the webhook endpoints are listed below."),
        endpoints=[
            ConfigUI.Endpoint(courier="receive", label=_("Webhook URL")),
        ],
    )

    def activate(self, channel):
        auth_token = channel.config["auth_token"]
        handler_url = channel.courier_url("receive")

        requests.post(
            "https://chatapi.viber.com/pa/set_webhook",
            json={
                "auth_token": auth_token,
                "url": handler_url,
                "event_types": ["delivered", "failed", "conversation_started"],
            },
        )

    def deactivate(self, channel):
        auth_token = channel.config["auth_token"]
        requests.post("https://chatapi.viber.com/pa/set_webhook", json={"auth_token": auth_token, "url": ""})

    def get_error_ref_url(self, channel, code: str) -> str:
        return "https://developers.viber.com/docs/api/rest-bot-api/#error-codes"
