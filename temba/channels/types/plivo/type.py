import requests

from django.conf import settings
from django.core.exceptions import ValidationError
from django.urls import re_path
from django.utils.translation import gettext_lazy as _

from temba.channels.models import ChannelType
from temba.contacts.models import URN
from temba.utils.http import http_headers

from .views import ClaimView, Connect, SearchView


class PlivoType(ChannelType):
    """
    An Plivo channel (https://www.plivo.com/)
    """

    CONFIG_AUTH_ID = "PLIVO_AUTH_ID"
    CONFIG_AUTH_TOKEN = "PLIVO_AUTH_TOKEN"
    CONFIG_APP_ID = "PLIVO_APP_ID"

    code = "PL"
    name = "Plivo"
    category = ChannelType.Category.PHONE

    unique_addresses = True

    schemes = [URN.TEL_SCHEME]

    claim_blurb = _("Easily add a two way number you have configured with %(link)s using their APIs.") % {
        "link": '<a href="https://www.plivo.com/">Plivo</a>'
    }
    claim_view = ClaimView

    credentials = (
        ChannelType.Credential(CONFIG_AUTH_ID, _("Account ID"), _("Your Plivo auth ID")),
        ChannelType.Credential(CONFIG_AUTH_TOKEN, _("Authentication Token"), _("Your Plivo auth token")),
    )

    def check_credentials(self, config: dict) -> bool:
        auth_id = config[self.CONFIG_AUTH_ID]
        try:
            response = requests.get(
                f"https://api.plivo.com/v1/Account/{auth_id}/",
                headers=http_headers(extra={"Content-Type": "application/json"}),
                auth=(auth_id, config[self.CONFIG_AUTH_TOKEN]),
                timeout=10,
            )
        except requests.RequestException:
            return False

        return response.status_code == 200

    async_activation = False

    def activate(self, channel):
        config = channel.config
        auth_id, auth_token = config[self.CONFIG_AUTH_ID], config[self.CONFIG_AUTH_TOKEN]
        headers = http_headers(extra={"Content-Type": "application/json"})

        # create an application to handle messaging for this channel
        app_name = "%s_%s" % (channel.callback_domain.lower().replace(".", "_"), channel.uuid)
        response = requests.post(
            "https://api.plivo.com/v1/Account/%s/Application/" % auth_id,
            json=dict(
                app_name=app_name,
                answer_url=f"{settings.STORAGE_URL}/plivo_voice_unavailable.xml",
                message_url=channel.courier_url("receive"),
            ),
            headers=headers,
            auth=(auth_id, auth_token),
        )
        if response.status_code not in (200, 201, 202):
            raise ValidationError(_("Unable to create a Plivo application for that number, please try again."))

        channel.config[self.CONFIG_APP_ID] = response.json()["app_id"]
        channel.save(update_fields=("config",))

        # and point our number at it
        response = requests.post(
            "https://api.plivo.com/v1/Account/%s/Number/%s/" % (auth_id, channel.address.lstrip("+")),
            json=dict(app_id=channel.config[self.CONFIG_APP_ID]),
            headers=headers,
            auth=(auth_id, auth_token),
        )
        if response.status_code != 202:
            raise ValidationError(_("There was a problem updating that number, please try again."))

    def deactivate(self, channel):
        config = channel.config
        app_id = config.get(self.CONFIG_APP_ID)
        if app_id:
            requests.delete(
                "https://api.plivo.com/v1/Account/%s/Application/%s/" % (config[self.CONFIG_AUTH_ID], app_id),
                auth=(config[self.CONFIG_AUTH_ID], config[self.CONFIG_AUTH_TOKEN]),
                headers=http_headers(extra={"Content-Type": "application/json"}),
            )

    def get_urls(self):
        return [
            self.get_claim_url(),
            re_path(r"^search/$", SearchView.as_view(channel_type=self), name="search"),
            re_path(r"^connect/$", Connect.as_view(channel_type=self), name="connect"),
        ]
