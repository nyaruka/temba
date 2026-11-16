import requests

from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import ChannelType
from .views import ClaimView


class TelegramType(ChannelType):
    """
    A Telegram bot channel
    """

    code = "TG"
    name = "Telegram"
    category = ChannelType.Category.SOCIAL_MEDIA

    schemes = [URN.TELEGRAM_SCHEME]
    async_activation = False

    redact_response_keys = {"first_name", "last_name", "username"}

    claim_blurb = _(
        "A %(link)s bot lets you message contacts for free, with no phone numbers or carrier fees involved. Contacts "
        "find your bot by its username and start the conversation themselves, and can reply by tapping buttons as well "
        "as by sending text, photos, voice notes and locations."
    ) % {"link": '<a target="_blank" href="https://telegram.org">Telegram</a>'}
    claim_view = ClaimView

    def is_recommended_to(self, org, user):
        return True  # because it's super simpler to setup, free, and works everywhere

    def activate(self, channel):
        config = channel.config

        response = requests.post(
            f"https://api.telegram.org/bot{config['auth_token']}/setWebhook",
            data={"url": channel.courier_url("receive")},
        )
        response.raise_for_status()

    def deactivate(self, channel):
        config = channel.config

        response = requests.post(f"https://api.telegram.org/bot{config['auth_token']}/deleteWebhook")
        response.raise_for_status()

    def get_error_ref_url(self, channel, code: str) -> str:
        return "https://core.telegram.org/api/errors"
