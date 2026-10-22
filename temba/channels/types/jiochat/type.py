from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI
from .views import ClaimView


class JioChatType(ChannelType):
    """
    A JioChat channel (https://www.jiochat.com)
    """

    code = "JC"
    name = "JioChat"
    category = ChannelType.Category.SOCIAL_MEDIA

    schemes = [URN.JIOCHAT_SCHEME]

    claim_blurb = _(
        "Add a %(link)s bot to send and receive messages to JioChat users for free. Your users will need an Android, "
        "Windows or iOS device and a JioChat account to send and receive messages."
    ) % {"link": '<a href="https://jiochat.com" target="_blank">JioChat</a>'}
    claim_view = ClaimView

    credentials = (
        ChannelType.Credential("jiochat_app_id", _("App ID"), _("The JioChat App ID")),
        ChannelType.Credential("jiochat_app_secret", _("Application Secret"), _("The JioChat App secret")),
    )

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to enter the following webhook URL and token on "
            "JioChat Developer Center configuration."
        ),
        endpoints=[
            ConfigUI.Endpoint(courier="", label=_("Webhook URL")),
        ],
        show_secret=True,
    )
