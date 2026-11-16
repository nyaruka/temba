import base64

import requests

from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from temba.channels.types.twilio.type import TwilioType
from temba.contacts.models import URN
from temba.request_logs.models import HTTPLog

from ...models import Channel, ChannelType, ConfigUI
from .views import ClaimView, UpdateForm


class TwilioWhatsappType(ChannelType):
    """
    An Twilio channel
    """

    SESSION_ACCOUNT_SID = TwilioType.SESSION_ACCOUNT_SID
    SESSION_AUTH_TOKEN = TwilioType.SESSION_AUTH_TOKEN

    code = "TWA"
    name = "Twilio WhatsApp"
    category = ChannelType.Category.SOCIAL_MEDIA

    unique_addresses = True

    schemes = [URN.WHATSAPP_SCHEME]
    template_type = "twilio"

    redact_request_keys = (
        "FromCity",
        "FromState",
        "FromZip",
        "ToCity",
        "ToState",
        "ToZip",
        "CalledCity",
        "CalledState",
        "CalledZip",
    )

    claim_blurb = _(
        "%(link)s lets you message contacts on WhatsApp through the same Twilio account you may already use for SMS "
        "and voice. Contacts can message your number and reply with photos, videos and documents or by tapping "
        "template buttons, and you can reach them at any time with templates you create in Twilio and Meta approves."
    ) % {"link": '<a target="_blank" href="https://www.twilio.com/whatsapp/">Twilio WhatsApp</a>'}

    claim_view = ClaimView
    update_form = UpdateForm

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to add the following URL in your Twilio "
            "Inbound Settings. Check the Twilio WhatsApp documentation for more information."
        ),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Request URL"),
                help=_("This endpoint should be called by Twilio when new messages are received by your number."),
            ),
        ],
    )

    def get_error_ref_url(self, channel, code: str) -> str:
        return f"https://www.twilio.com/docs/api/errors/{code}"

    def check_credentials(self, config: dict) -> bool:
        return TwilioType().check_credentials(config)

    def fetch_templates(self, channel) -> list:
        url = "https://content.twilio.com/v1/Content"
        credentials_base64 = base64.b64encode(
            f"{channel.config[Channel.CONFIG_ACCOUNT_SID]}:{channel.config[Channel.CONFIG_AUTH_TOKEN]}".encode()
        ).decode()

        headers = {"Authorization": f"Basic {credentials_base64}"}

        twilio_templates = []

        while url:
            start = timezone.now()
            try:
                response = requests.get(url, headers=headers)
                response.raise_for_status()
                HTTPLog.from_response(
                    HTTPLog.WHATSAPP_TEMPLATES_SYNCED, response, start, timezone.now(), channel=channel
                )

                twilio_templates.extend(response.json()["contents"])
                url = response.json().get("meta", {}).get("next_page_url", None)
            except requests.RequestException as e:
                HTTPLog.from_exception(HTTPLog.WHATSAPP_TEMPLATES_SYNCED, e, start, channel=channel)
                raise e

        return twilio_templates
