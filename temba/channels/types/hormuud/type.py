from django.utils.translation import gettext_lazy as _

from temba.channels.types.hormuud.views import ClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class HormuudType(ChannelType):
    """
    A Hormuud channel (https://www.hormuud.com/)
    """

    code = "HM"
    name = "Hormuud"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["Africa/Mogadishu"]

    claim_blurb = _(
        "%(link)s offers businesses an SMS API on its network in Somalia, sold in prepaid packages of local messages. "
        "Connect a number you have with Hormuud to send and receive SMS with your contacts."
    ) % {"link": '<a target="_blank" href="https://www.hormuud.com/SmsApi">Hormuud</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to notify Hormuud of the following URL for incoming "
            "(MO) messages."
        ),
        endpoints=[
            ConfigUI.Endpoint(courier="receive", label=_("Receive URL")),
        ],
    )
