from django.utils.translation import gettext_lazy as _

from temba.channels.types.globe.views import ClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class GlobeType(ChannelType):
    """
    A Globe Labs channel
    """

    code = "GL"
    name = "Globe Labs"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["Asia/Manila"]

    claim_blurb = _(
        "%(link)s is Globe Telecom's developer platform. Connect a short code you have with a Globe Labs app to send "
        "and receive SMS with subscribers on Globe, one of the largest mobile networks in the Philippines."
    ) % {"link": '<a target="_blank" href="https://www.globelabs.com.ph/">Globe Labs</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to set the following notify URI for SMS on your "
            "application configuration page."
        ),
        endpoints=[
            ConfigUI.Endpoint(courier="receive", label=_("Notify URI")),
        ],
    )

    def is_recommended_to(self, org, user):
        return self.is_available_to(org, user)[0]
