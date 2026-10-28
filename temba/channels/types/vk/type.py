from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import Channel, ChannelType, ConfigUI
from .views import ClaimView

CONFIG_COMMUNITY_NAME = "community_name"
CONFIG_CALLBACK_VERIFICATION_STRING = "callback_verification_string"


class VKType(ChannelType):
    """
    A VK channel
    """

    CONFIG_COMMUNITY_NAME = "community_name"

    code = "VK"
    name = "VK"
    category = ChannelType.Category.SOCIAL_MEDIA

    unique_addresses = True

    schemes = [URN.VK_SCHEME]

    claim_blurb = _(
        "Add a %(link)s bot to send and receive messages on behalf of a VK community for free. You will need to create "
        "an access token for your community first."
    ) % {"link": '<a target="_blank" href="https://vk.com/">VK</a>'}
    claim_view = ClaimView

    credentials = (
        ChannelType.Credential(Channel.CONFIG_AUTH_TOKEN, _("Access Token"), _("The Community Access Token")),
    )

    config_ui = ConfigUI()  # has own template
