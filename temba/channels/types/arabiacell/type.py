from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI
from .views import ClaimView


class ArabiaCellType(ChannelType):
    """
    An ArabiaCell channel type (http://arabiacell.com)
    """

    code = "AC"
    name = "ArabiaCell"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["Asia/Amman"]
    recommended_timezones = ["Asia/Amman"]

    claim_view = ClaimView
    claim_blurb = _(
        "%(link)s is a Jordanian provider of SMS and mobile content services. Connect a short code you have with "
        "ArabiaCell, with messages either free or billed to contacts, to send and receive SMS with your contacts."
    ) % {"link": '<a target="_blank" href="https://www.arabiacell.com/">ArabiaCell</a>'}

    config_ui = ConfigUI(
        blurb=_("To finish configuring this channel, you'll need ArabiaCell to use the following callback URL."),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Receive URL"),
                help=_("This URL should be called by ArabiaCell when new messages are received."),
            ),
        ],
    )
