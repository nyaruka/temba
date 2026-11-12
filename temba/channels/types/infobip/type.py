from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI
from .views import ClaimView


class InfobipType(ChannelType):
    """
    An Infobip channel (https://www.infobip.com/)
    """

    code = "IB"
    name = "Infobip"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]

    claim_blurb = _(
        "%(link)s is a global communications platform with direct connections to mobile networks around the world. "
        "Connect a number you have with Infobip to send and receive SMS, and MMS where your number supports it."
    ) % {"link": '<a target="_blank" href="https://www.infobip.com/">Infobip</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to set the following callback URLs on the Infobip "
            "website under your account."
        ),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Received URL"),
                help=_(
                    "This endpoint should be called with a POST by Infobip when new messages are received to your number. "
                    "You can set the receive URL on your Infobip account in the customer portal."
                ),
            ),
            ConfigUI.Endpoint(
                courier="delivered",
                label=_("Delivered URL"),
                help=_(
                    "This endpoint should be called with a POST by Infobip when a message has been to the final recipient. "
                    "(delivery reports) The callback webhook will be sent with the outgoing message, but you can set the delivery "
                    "callback URL on your Infobip account in the customer portal."
                ),
            ),
        ],
    )
