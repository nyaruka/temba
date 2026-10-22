from django.utils.translation import gettext_lazy as _

from temba.channels.models import ChannelType, ConfigUI
from temba.channels.types.novo.views import ClaimView
from temba.contacts.models import URN


class NovoType(ChannelType):
    """
    A Novo channel (http://www.novotechnologyinc.com/)
    """

    CONFIG_MERCHANT_ID = "merchant_id"
    CONFIG_MERCHANT_SECRET = "merchant_secret"

    code = "NV"
    name = "Novo"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["America/Port_of_Spain"]

    claim_blurb = _(
        "If you are based in Trinidad & Tobago, you can purchase a short code from %(link)s and connect it in a few "
        "simple steps."
    ) % {"link": '<a target="_blank" href="http://www.novotechnologyinc.com/">Novo</a>'}
    claim_view = ClaimView

    credentials = (
        ChannelType.Credential(
            CONFIG_MERCHANT_ID, _("Merchant ID"), _("The merchant id to compose your Merchant URL provided by Novo")
        ),
        ChannelType.Credential(CONFIG_MERCHANT_SECRET, _("Merchant Secret"), _("The merchant secret provided by Novo")),
    )

    config_ui = ConfigUI(
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Receive URL"),
                help=_("To receive incoming messages, you need to set the receive URL for your Novo account."),
            ),
        ],
    )
