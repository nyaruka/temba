from django.utils.translation import gettext_lazy as _

from temba.channels.views import AuthenticatedExternalCallbackClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class HighConnectionType(ChannelType):
    """
    An High Connection channel (http://www.highconnexion.com/en/)
    """

    code = "HX"
    slug = "high_connection"
    name = "High Connection"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["Europe/Paris"]

    claim_blurb = _(
        "%(link)s is a French mobile marketing and payments company used by more than 370 companies and "
        "associations. Connect a number you have with HighCONNEXION to send and receive SMS with contacts in France."
    ) % {"link": '<a target="_blank" href="https://www.highconnexion.com/en_GB">HighCONNEXION</a>'}
    claim_view = AuthenticatedExternalCallbackClaimView

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to notify HighConnection of the following URL for incoming "
            "(MO) messages."
        ),
        endpoints=[
            ConfigUI.Endpoint(courier="receive", label=_("Receive URL")),
        ],
    )
