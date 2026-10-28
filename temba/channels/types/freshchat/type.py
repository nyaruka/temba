from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import Channel, ChannelType, ConfigUI
from .views import ClaimView


class FreshChatType(ChannelType):
    """
    An FreshChat channel
    """

    code = "FC"
    name = "FreshChat"
    category = ChannelType.Category.API

    unique_addresses = True

    schemes = [URN.FRESHCHAT_SCHEME]

    claim_blurb = _("Connect your approved %(link)s channel") % {
        "link": '<a target="_blank" href="https://www.freshworks.com/live-chat-software/">FreshChat</a>'
    }
    claim_view = ClaimView

    credentials = (
        ChannelType.Credential(
            Channel.CONFIG_AUTH_TOKEN, _("FreshChat API Auth Token"), _("The API auth token- leave out the bearer")
        ),
    )

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll have to configure the FreshChat server to direct "
            "messages to the url below."
        ),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Receive URL"),
                help=_("POST FreshChat trigger to this address."),
            ),
        ],
    )
