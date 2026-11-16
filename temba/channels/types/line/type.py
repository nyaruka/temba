from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI
from .views import ClaimView


class LineType(ChannelType):
    """
    A LINE channel (https://line.me/)
    """

    code = "LN"
    name = "LINE"
    category = ChannelType.Category.SOCIAL_MEDIA

    unique_addresses = True

    schemes = [URN.LINE_SCHEME]

    claim_blurb = _(
        "%(link)s is the leading messaging app in Japan, Thailand and Taiwan. Contacts add your LINE Official Account "
        "as a friend to message it, and can reply with photos, videos, audio, files and locations or by tapping "
        "buttons. Replies to contacts are free, while messages your account starts count toward your LINE plan's "
        "monthly allowance."
    ) % {"link": '<a target="_blank" href="https://line.me">LINE</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to add the following to your channel in the LINE Developers "
            "Console."
        ),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Webhook URL"),
                help=_("Set this as your channel's webhook URL on its Messaging API tab, then turn on Use webhook."),
            ),
        ],
        show_public_ips=True,
    )

    def get_error_ref_url(self, channel, code: str) -> str:
        return "https://developers.line.biz/en/reference/messaging-api/#error-responses"
