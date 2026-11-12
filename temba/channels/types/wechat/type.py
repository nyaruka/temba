from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI
from .views import ClaimView


class WeChatType(ChannelType):
    """
    A WeChat channel (https://www.wechat.com)
    """

    code = "WC"
    name = "WeChat"
    category = ChannelType.Category.SOCIAL_MEDIA

    schemes = [URN.WECHAT_SCHEME]

    claim_blurb = _(
        "%(link)s is the leading messaging app in China. Contacts follow your WeChat Official Account to message it, "
        "and can send photos, videos and voice messages. Your account can reply for up to 48 hours after a contact's "
        "last message."
    ) % {"link": '<a target="_blank" href="https://www.wechat.com">WeChat</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to enter the following webhook URL and token on "
            "WeChat Official Accounts Platform."
        ),
        endpoints=[
            ConfigUI.Endpoint(courier="", label=_("Webhook URL")),
        ],
        show_secret=True,
        show_public_ips=True,
    )
