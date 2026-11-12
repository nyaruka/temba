from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI
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
        "%(link)s is the leading social network in Russia. Contacts message your VK community, and can send photos, "
        "stickers, voice messages, documents and locations or reply by tapping buttons."
    ) % {"link": '<a target="_blank" href="https://vk.com/">VK</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI()  # has own template
