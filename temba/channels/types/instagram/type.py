import requests

from django.conf import settings
from django.urls import re_path
from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import Channel, ChannelType
from .views import ClaimView, RefreshToken


class InstagramType(ChannelType):
    """
    A Instagram channel
    """

    code = "IG"
    name = "Instagram"
    category = ChannelType.Category.SOCIAL_MEDIA

    unique_addresses = True

    schemes = [URN.INSTAGRAM_SCHEME]

    claim_blurb = _(
        "Contacts can message your business on %(link)s from its profile, posts and stories, and reply with photos, "
        "videos and by tapping buttons. Automated replies can be sent within 24 hours of a contact's last message, and "
        "replies from your team for up to 7 days."
    ) % {"link": '<a target="_blank" href="https://instagram.com">Instagram</a>'}
    claim_view = ClaimView

    menu_items = [dict(label=_("Reconnect Business Account"), view_name="channels.types.instagram.refresh_token")]

    def get_urls(self):
        return [
            self.get_claim_url(),
            re_path(
                r"^(?P<uuid>[a-z0-9\-]+)/refresh_token/$",
                RefreshToken.as_view(channel_type=self),
                name="refresh_token",
            ),
        ]

    def deactivate(self, channel):
        config = channel.config
        requests.delete(
            f"https://graph.facebook.com/v22.0/{channel.address}/subscribed_apps",
            params={"access_token": config[Channel.CONFIG_AUTH_TOKEN]},
        )

    def get_redact_values(self, channel) -> tuple:  # pragma: needs cover
        """
        Gets the values to redact from logs
        """
        return (settings.FACEBOOK_APPLICATION_SECRET, settings.FACEBOOK_WEBHOOK_SECRET)

    def get_error_ref_url(self, channel, code: str) -> str:
        return "https://developers.facebook.com/docs/instagram-api/reference/error-codes"
