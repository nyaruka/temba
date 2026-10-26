import base64
import logging

import requests

from django.forms import ValidationError
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from temba.channels.models import Channel, ChannelType
from temba.channels.types.turn.views import ClaimView
from temba.contacts.models import URN
from temba.request_logs.models import HTTPLog

CONFIG_FB_BUSINESS_ID = "fb_business_id"
CONFIG_FB_ACCESS_TOKEN = "fb_access_token"
CONFIG_FB_NAMESPACE = "fb_namespace"
CONFIG_FB_TEMPLATE_LIST_DOMAIN = "fb_template_list_domain"
CONFIG_FB_TEMPLATE_API_VERSION = "fb_template_list_domain_api_version"
CONFIG_WEBHOOK_URL = "webhook_url"

TEMPLATE_LIST_URL = "https://%s/%s/%s/message_templates"

logger = logging.getLogger(__name__)


class TurnType(ChannelType):
    """
    A Turn.io WhatsApp Channel Type
    """

    code = "TRN"
    name = "Turn.io WhatsApp"
    category = ChannelType.Category.SOCIAL_MEDIA

    unique_addresses = True
    tps = 45

    schemes = [URN.WHATSAPP_SCHEME]
    async_activation = False
    template_type = "whatsapp"

    claim_blurb = _(
        "If you have an enterprise Turn.io WhatsApp account, you can connect it to communicate with your contacts"
    )
    claim_view = ClaimView

    def get_headers(self, channel):
        return {
            "Authorization": "Bearer %s" % channel.config[Channel.CONFIG_AUTH_TOKEN],
            "Content-Type": "application/json",
        }

    def activate(self, channel):
        receive_url = channel.courier_url("receive")

        resp = requests.patch(
            channel.config[Channel.CONFIG_BASE_URL] + "/v1/settings/application",
            json={"webhooks": {"url": receive_url}},
            headers=self.get_headers(channel),
        )

        if resp.status_code != 200:
            raise ValidationError(_("Unable to register webhooks: %(resp)s"), params={"resp": resp.text})

        channel.config[CONFIG_WEBHOOK_URL] = receive_url
        channel.save(update_fields=("config",))

    def deactivate(self, channel):
        # only clear the webhook if we're the one that registered it - channels claimed before we did this, or whose
        # registration failed, may have a webhook the user configured themselves
        if not channel.config.get(CONFIG_WEBHOOK_URL):
            return

        # resetting the application settings clears the primary webhook
        resp = requests.delete(
            channel.config[Channel.CONFIG_BASE_URL] + "/v1/settings/application",
            headers=self.get_headers(channel),
        )

        if resp.status_code != 200:
            raise ValidationError(_("Unable to remove webhooks: %(resp)s"), params={"resp": resp.text})

    def fetch_templates(self, channel) -> list:
        # Retrieve the template domain, fallback to the default for channels that have been setup earlier for backwards
        # compatibility
        facebook_template_domain = channel.config.get(CONFIG_FB_TEMPLATE_LIST_DOMAIN, "graph.facebook.com")
        facebook_business_id = channel.config.get(CONFIG_FB_BUSINESS_ID)
        facebook_template_api_version = channel.config.get(CONFIG_FB_TEMPLATE_API_VERSION, "v14.0")
        url = TEMPLATE_LIST_URL % (facebook_template_domain, facebook_template_api_version, facebook_business_id)
        templates = []

        while url:
            start = timezone.now()
            try:
                response = requests.get(
                    url, params={"access_token": channel.config[CONFIG_FB_ACCESS_TOKEN], "limit": 255}
                )
                response.raise_for_status()
                HTTPLog.from_response(
                    HTTPLog.WHATSAPP_TEMPLATES_SYNCED, response, start, timezone.now(), channel=channel
                )

                templates.extend(response.json()["data"])
                url = response.json().get("paging", {}).get("next", None)
            except requests.RequestException as e:
                HTTPLog.from_exception(HTTPLog.WHATSAPP_TEMPLATES_SYNCED, e, start, channel=channel)
                raise e

        return templates

    def get_redact_values(self, channel) -> tuple:
        """
        Gets the values to redact from logs
        """
        credentials_base64 = base64.b64encode(
            f"{channel.config[Channel.CONFIG_USERNAME]}:{channel.config[Channel.CONFIG_PASSWORD]}".encode()
        ).decode()
        return (
            channel.config[CONFIG_FB_ACCESS_TOKEN],
            channel.config[Channel.CONFIG_PASSWORD],
            credentials_base64,
        )
