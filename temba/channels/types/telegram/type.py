import requests

from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import Channel, ChannelType
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
        "Add a %(link)s bot to send and receive messages to Telegram users for free. Your users will need an Android, "
        "Windows or iOS device and a Telegram account to send and receive messages."
    ) % {"link": '<a target="_blank" href="https://telegram.org">Telegram</a>'}
    claim_view = ClaimView

    credentials = (
        ChannelType.Credential(
            Channel.CONFIG_AUTH_TOKEN, _("Authentication Token"), _("The Authentication token for your Telegram Bot")
        ),
    )

    def check_credentials(self, config: dict) -> bool:
        try:
            response = requests.get(
                f"https://api.telegram.org/bot{config[Channel.CONFIG_AUTH_TOKEN]}/getMe", timeout=10
            )
            return response.status_code == 200 and response.json().get("ok", False)
        except requests.RequestException, ValueError:  # ValueError for non-JSON responses
            return False

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
