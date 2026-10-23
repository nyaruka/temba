from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import Channel, ChannelType, ConfigUI
from .views import ClaimView


class WavyType(ChannelType):
    """
    An Movile/Wavy channel type (https://wavy.global/en/)
    """

    code = "WV"
    name = "Movile/Wavy"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = [
        "America/Noronha",
        "America/Belem",
        "America/Fortaleza",
        "America/Recife",
        "America/Araguaina",
        "America/Maceio",
        "America/Bahia",
        "America/Sao_Paulo",
        "America/Campo_Grande",
        "America/Cuiaba",
        "America/Santarem",
        "America/Porto_Velho",
        "America/Boa_Vista",
        "America/Manaus",
        "America/Eirunepe",
        "America/Rio_Branco",
    ]

    claim_view = ClaimView

    credentials = (
        ChannelType.Credential(Channel.CONFIG_USERNAME, _("Username"), _("The username for your Movile/Wavy account")),
        ChannelType.Credential(
            Channel.CONFIG_AUTH_TOKEN,
            _("Authentication Token"),
            _("The Authentication Token for your Movile/Wavy account"),
        ),
    )
    claim_blurb = _("If you have an %(link)s number, you can quickly connect it using their APIs.") % {
        "link": '<a target="_blank" href="https://wavy.global/en/">Movile/Wavy</a>'
    }

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you need to have Movile/Wavy configure the URL below for your number."
        ),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Receive URL"),
                help=_("This URL should be called by Movile/Wavy when new messages are received."),
            ),
            ConfigUI.Endpoint(
                courier="sent",
                label=_("Sent URL"),
                help=_(
                    "To receive the acknowledgement of sent messages, you need to set the Sent URL for your Movile/Wavy "
                    "account."
                ),
            ),
            ConfigUI.Endpoint(
                courier="delivered",
                label=_("Delivered URL"),
                help=_(
                    "To receive delivery of delivered messages, you need to set the Delivered URL for your Movile/Wavy "
                    "account."
                ),
            ),
        ],
    )
