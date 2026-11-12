from django.utils.translation import gettext_lazy as _

from temba.channels.types.m3tech.views import ClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class M3TechType(ChannelType):
    """
    An M3 Tech channel (http://m3techservice.com)
    """

    code = "M3"
    name = "M3 Tech"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]

    claim_blurb = _(
        "%(link)s provides SMS gateway services to businesses in Pakistan. Connect a number or short code you have "
        "with M3 Tech to send and receive SMS with your contacts."
    ) % {"link": '<a target="_blank" href="http://m3techservice.com">M3 Tech</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_("To finish configuring this channel, you'll need to notify M3Tech of the following callback URLs."),
        endpoints=[
            ConfigUI.Endpoint(courier="receive", label=_("Received URL")),
            ConfigUI.Endpoint(courier="sent", label=_("Sent URL")),
            ConfigUI.Endpoint(courier="delivered", label=_("Delivered URL")),
            ConfigUI.Endpoint(courier="failed", label=_("Failed URL")),
        ],
    )

    available_timezones = ["Asia/Karachi"]
