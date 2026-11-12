from django.utils.translation import gettext_lazy as _

from temba.channels.types.yo.views import ClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class YoType(ChannelType):
    """
    An Yo! channel (http://www.yo.co.ug/)
    """

    code = "YO"
    name = "YO!"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["Africa/Kampala"]

    claim_view = ClaimView
    claim_blurb = _(
        "%(link)s has provided SMS, USSD and IVR aggregation for more than 18 years, for organizations in Uganda and "
        "beyond. Connect a short code or number you have with Yo! to send and receive SMS."
    ) % {"link": '<a target="_blank" href="https://www.yo.co.ug/">Yo!</a>'}

    config_ui = ConfigUI(
        blurb=_("To finish configuring this channel, you'll need to notify Yo! of the following inbound SMS URL."),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Inbound SMS URL"),
                help=_(
                    "This URL should be called with a GET by Yo! when new incoming "
                    "messages are received on your short code."
                ),
            ),
        ],
    )

    def is_recommended_to(self, org, user):
        return self.is_available_to(org, user)[0]
