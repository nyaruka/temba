from django.utils.translation import gettext_lazy as _

from temba.channels.types.macrokiosk.views import ClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class MacrokioskType(ChannelType):
    """
    An Macrokiok channel (http://www.macrokiosk.com/)
    """

    CONFIG_SENDER_ID = "macrokiosk_sender_id"
    CONFIG_SERVICE_ID = "macrokiosk_service_id"

    code = "MK"
    name = "Macrokiosk"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["Asia/Kuala_Lumpur"]

    claim_blurb = _(
        "%(link)s offers SMS alongside WhatsApp, Viber, LINE and other channels through a single API. Connect a number "
        "or short code you have with MACROKIOSK to send and receive SMS with your contacts."
    ) % {"link": '<a target="_blank" href="https://www.macrokiosk.com/">MACROKIOSK</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_("To finish configuring this channel, you'll need to notify MACROKIOSK of the following URLs."),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Inbound URL"),
                help=_("This endpoint should be called by MACROKIOSK when new messages are received to your number."),
            ),
            ConfigUI.Endpoint(
                courier="status",
                label=_("DLR URL"),
                help=_(
                    "This endpoint should be called by MACROKIOSK when the message status changes. (delivery reports)"
                ),
            ),
        ],
    )
