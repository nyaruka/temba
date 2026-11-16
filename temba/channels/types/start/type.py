from django.utils.translation import gettext_lazy as _

from temba.channels.views import AuthenticatedExternalClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class StartType(ChannelType):
    """
    An Start Mobile channel (https://bulk.startmobile.ua/)
    """

    code = "ST"
    name = "Start Mobile"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["Europe/Kiev"]

    claim_blurb = _(
        "%(link)s has provided bulk SMS in Ukraine since 2007, along with voice broadcasts. Connect a number you have "
        "with Start Mobile to send and receive SMS with contacts in Ukraine."
    ) % {"link": '<a target="_blank" href="https://startmobile.ua/">Start Mobile</a>'}
    claim_view = AuthenticatedExternalClaimView

    config_ui = ConfigUI(
        blurb=_("To finish configuring this channel, you'll need to notify Start of the following receiving URL."),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Inbound URL"),
                help=_("This endpoint should be called by Start Mobile when new messages are received to your number."),
            ),
        ],
    )
