from django.utils.translation import gettext_lazy as _

from temba.channels.types.clickmobile.views import ClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class ClickMobileType(ChannelType):
    """
    A ClickMobile Channel Type https://www.click-mobile.com/
    """

    code = "CM"
    name = "Click Mobile"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["Africa/Accra", "Africa/Blantyre"]

    claim_blurb = _(
        "%(link)s connects directly to mobile networks across Africa. Connect a number or short code you have with "
        "Click Mobile in Ghana or Malawi to send and receive SMS with your contacts."
    ) % {"link": '<a target="_blank" href="https://www.click-mobile.com/">Click Mobile</a>'}

    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you need to configure Click Mobile to send new messages to the URL below."
        ),
        endpoints=[
            ConfigUI.Endpoint(courier="receive", label=_("Receive URL")),
        ],
    )
