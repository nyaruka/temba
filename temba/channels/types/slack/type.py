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

    claim_blurb = _(
        "A %(link)s app lets people in your Slack workspace message your bot directly, so you can run flows for your "
        "own team where they already work, e.g. check-ins, surveys or a help desk. People can send your bot files as "
        "well as messages."
    ) % {"link": '<a target="_blank" href="https://slack.com">Slack</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI()  # has own template
