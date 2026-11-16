from django.utils.translation import gettext_lazy as _

from temba.channels.types.telesom.views import ClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class TelesomType(ChannelType):
    """
    An Telesom channel
    """

    code = "TS"
    name = "Telesom"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["Africa/Mogadishu"]

    claim_blurb = _(
        "%(link)s is the largest mobile operator in Somaliland. Connect a short code you have with Telesom to send and "
        "receive SMS with contacts on its network."
    ) % {"link": '<a target="_blank" href="https://telesom.com">Telesom</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to provide Telesom with the following delivery URL "
            "for incoming messages."
        ),
        endpoints=[
            ConfigUI.Endpoint(courier="receive", label=_("Delivery URL")),
        ],
    )

    def is_recommended_to(self, org, user):
        return self.is_available_to(org, user)[0]
