from django.utils.translation import gettext_lazy as _

from temba.channels.models import ChannelType, ConfigUI
from temba.channels.types.playmobile.views import ClaimView
from temba.contacts.models import URN


class PlayMobileType(ChannelType):
    """
    A Play Mobile channel (http://playmobile.uz/)
    """

    code = "PM"
    name = "Play Mobile"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["Asia/Tashkent", "Asia/Samarkand"]

    claim_blurb = _(
        "%(link)s is an SMS operator for businesses in Uzbekistan, used by banks, payment systems and online stores "
        "to message their customers. Connect a short code you have with Play Mobile to send and receive SMS with your "
        "contacts."
    ) % {"link": '<a target="_blank" href="https://playmobile.uz/">Play Mobile</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_("To finish configuring this channel, you'll need to notify Play Mobile of the following URL."),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Receive URL"),
                help=_("To receive incoming messages, you need to set the receive URL for your Play Mobile account."),
            ),
        ],
    )
