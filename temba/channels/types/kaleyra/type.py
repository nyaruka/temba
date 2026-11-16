from django.utils.translation import gettext_lazy as _

from temba.channels.models import ChannelType, ConfigUI
from temba.channels.types.kaleyra.views import ClaimView
from temba.contacts.models import URN

CONFIG_ACCOUNT_SID = "account_sid"
CONFIG_API_KEY = "api_key"


class KaleyraType(ChannelType):
    """
    A Kaleyra Channel Type
    """

    code = "KWA"
    name = "Kaleyra WhatsApp"
    category = ChannelType.Category.SOCIAL_MEDIA
    tps = 45

    schemes = [URN.WHATSAPP_SCHEME]

    claim_blurb = _(
        "%(link)s, part of Tata Communications and a Meta Premier Partner, offers WhatsApp alongside SMS, voice and "
        "other channels from one platform. Contacts can message your number and send photos, videos, voice notes and "
        "documents."
    ) % {
        "link": '<a target="_blank" href="https://www.tatacommunications.com/kaleyra/cpaas/whatsapp-business-api">Kaleyra</a>'
    }
    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to set the following callback URL on your Kaleyra account."
        ),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Receive URL"),
                help=_("To receive incoming messages, you need to set the receive URL for your Kaleyra account."),
            ),
        ],
    )
