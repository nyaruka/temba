from django.utils.translation import gettext_lazy as _

from temba.channels.types.twilio.type import TwilioType
from temba.channels.types.twilio.views import SUPPORTED_COUNTRIES
from temba.contacts.models import URN
from temba.utils.timezones import timezone_to_country_code

from ...models import ChannelType, ConfigUI
from .views import ClaimView, UpdateForm


class TwilioMessagingServiceType(ChannelType):
    """
    An Twilio Messaging Service channel
    """

    SESSION_ACCOUNT_SID = TwilioType.SESSION_ACCOUNT_SID
    SESSION_AUTH_TOKEN = TwilioType.SESSION_AUTH_TOKEN
    CONFIG_MESSAGING_SERVICE_SID = "messaging_service_sid"
    CONFIG_SHORTEN_URLS = "link_shortening"

    code = "TMS"
    slug = "twilio_messaging_service"
    name = "Twilio Messaging Service"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]

    claim_view = ClaimView

    claim_blurb = _(
        "A %(link)s sends your messages from a pool of numbers on your Twilio account instead of just one, so you can "
        "send at higher volumes and keep each contact on the same number. It can also shorten links in your messages."
    ) % {
        "link": '<a target="_blank" href="https://www.twilio.com/docs/messaging/services">Twilio Messaging Service</a>'
    }

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to add the following URL in your "
            "Messaging Service Inbound Settings."
        ),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Request URL"),
                help=_(
                    "This endpoint should be called by Twilio when new messages are received by your Messaging Service."
                ),
            ),
        ],
    )

    update_form = UpdateForm

    def is_recommended_to(self, org, user):
        return timezone_to_country_code(org.timezone) in SUPPORTED_COUNTRIES

    def get_error_ref_url(self, channel, code: str) -> str:
        return f"https://www.twilio.com/docs/api/errors/{code}"

    def check_credentials(self, config: dict) -> bool:
        return TwilioType().check_credentials(config)
