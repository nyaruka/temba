from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import ChannelType
from .views import ClaimView


class RocketChatType(ChannelType):
    """
    A Rocket.Chat app channel
    """

    CONFIG_BASE_URL = "base_url"
    CONFIG_BOT_USERNAME = "bot_username"
    CONFIG_ADMIN_AUTH_TOKEN = "admin_auth_token"
    CONFIG_ADMIN_USER_ID = "admin_user_id"
    CONFIG_SECRET = "secret"

    code = "RC"
    name = "Rocket.Chat"
    category = ChannelType.Category.SOCIAL_MEDIA

    schemes = [URN.ROCKETCHAT_SCHEME]

    claim_blurb = _(
        "%(link)s is an open source chat platform you can host yourself. Through its Omnichannel, contacts who reach "
        "you on Rocket.Chat, e.g. through its live chat widget on your website, can be answered by your flows, and "
        "messages and replies can include attachments."
    ) % {"link": '<a target="_blank" href="https://rocket.chat/">Rocket.Chat</a>'}
    claim_view = ClaimView
