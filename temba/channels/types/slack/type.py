import slack_sdk

from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI
from .views import ClaimView


class SlackType(ChannelType):
    """
    A Slack bot channel
    """

    CONFIG_BOT_TOKEN = "bot_token"
    CONFIG_USER_TOKEN = "user_token"
    CONFIG_VERIFICATION_TOKEN = "verification_token"

    code = "SL"
    name = "Slack"
    category = ChannelType.Category.SOCIAL_MEDIA

    unique_addresses = True

    schemes = [URN.SLACK_SCHEME]

    claim_blurb = _("Add a %(link)s bot to send and receive messages to Slack users, on your slack workspace.") % {
        "link": '<a target="_blank" href="https://slack.com">Slack</a>'
    }
    claim_view = ClaimView

    credentials = (
        ChannelType.Credential(
            CONFIG_USER_TOKEN,
            _("User OAuth Token"),
            _("In Slack select your bot app and go to Features / OAuth & Permissions to see this information."),
        ),
        ChannelType.Credential(
            CONFIG_BOT_TOKEN,
            _("Bot User OAuth Token"),
            _("In Slack select your bot app and go to Features / OAuth & Permissions to see this information."),
        ),
    )

    def check_credentials(self, config: dict) -> bool:
        try:
            for key in (self.CONFIG_USER_TOKEN, self.CONFIG_BOT_TOKEN):
                slack_sdk.WebClient(token=config[key], timeout=10).api_call(api_method="auth.test")
        except slack_sdk.errors.SlackApiError, OSError:
            return False

        return True

    config_ui = ConfigUI()  # has own template
