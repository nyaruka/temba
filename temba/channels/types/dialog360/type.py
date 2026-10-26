import requests

from django.forms import ValidationError
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from temba.channels.models import Channel
from temba.channels.types.dialog360.views import ClaimView
from temba.contacts.models import URN
from temba.request_logs.models import HTTPLog

from ...models import ChannelType, ConfigUI


class Dialog360Type(ChannelType):
    """
    A 360 Dialog Channel Type
    """

    code = "D3C"
    name = "360Dialog WhatsApp"
    category = ChannelType.Category.SOCIAL_MEDIA

    unique_addresses = True
    tps = 45

    schemes = [URN.WHATSAPP_SCHEME]
    template_type = "whatsapp"

    claim_blurb = _(
        "Activate your own enterprise WhatsApp account in %(link)s (Cloud) to communicate with your contacts. "
    ) % {"link": '<a target="_blank" href="https://www.360dialog.com/">360Dialog</a>'}
    claim_view = ClaimView

    credentials = (
        ChannelType.Credential(
            Channel.CONFIG_AUTH_TOKEN,
            _("API Key"),
            _("The 360 Dialog API key generated after account registration"),
        ),
    )

    config_ui = ConfigUI()  # has own template

    def get_headers(self, channel):
        return {"D360-API-KEY": channel.config[Channel.CONFIG_AUTH_TOKEN], "Content-Type": "application/json"}

    def check_credentials(self, config: dict) -> bool:
        try:
            response = requests.get(
                config[Channel.CONFIG_BASE_URL] + "/v1/configs/templates",
                headers={"D360-API-KEY": config[Channel.CONFIG_AUTH_TOKEN]},
                timeout=10,
            )
        except requests.RequestException:
            return False

        return response.status_code == 200

    def activate(self, channel):
        # first set our callbacks
        payload = {"url": channel.courier_url("receive")}
        resp = requests.post(
            channel.config[Channel.CONFIG_BASE_URL] + "/v1/configs/webhook",
            json=payload,
            headers=self.get_headers(channel),
        )

        if resp.status_code != 200:
            raise ValidationError(_("Unable to register callbacks: %(resp)s"), params={"resp": resp.content})

    def fetch_templates(self, channel) -> list:
        templates_url = "%s/v1/configs/templates" % channel.config[Channel.CONFIG_BASE_URL]
        start = timezone.now()
        try:
            response = requests.get(templates_url, headers=self.get_headers(channel))
            response.raise_for_status()
            HTTPLog.from_response(HTTPLog.WHATSAPP_TEMPLATES_SYNCED, response, start, timezone.now(), channel=channel)
        except requests.RequestException as e:
            HTTPLog.from_exception(HTTPLog.WHATSAPP_TEMPLATES_SYNCED, e, start, channel=channel)
            raise e

        return response.json()["waba_templates"]

    def get_redact_values(self, channel) -> tuple:
        return (channel.config[Channel.CONFIG_AUTH_TOKEN],)
