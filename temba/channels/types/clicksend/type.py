from django.utils.translation import gettext_lazy as _

from temba.channels.views import AuthenticatedExternalClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class ClickSendType(ChannelType):
    """
    A ClickSend channel (https://www.clicksend.com/)
    """

    code = "CS"
    name = "ClickSend"
    category = ChannelType.Category.PHONE

    available_timezones = [
        "America/New_York",
        "America/Detroit",
        "America/Kentucky/Louisville",
        "America/Kentucky/Monticello",
        "America/Indiana/Indianapolis",
        "America/Indiana/Vincennes",
        "America/Indiana/Winamac",
        "America/Indiana/Marengo",
        "America/Indiana/Petersburg",
        "America/Indiana/Vevay",
        "America/Chicago",
        "America/Indiana/Tell_City",
        "America/Indiana/Knox",
        "America/Menominee",
        "America/North_Dakota/Center",
        "America/North_Dakota/New_Salem",
        "America/North_Dakota/Beulah",
        "America/Denver",
        "America/Boise",
        "America/Phoenix",
        "America/Los_Angeles",
        "America/Anchorage",
        "America/Juneau",
        "America/Sitka",
        "America/Metlakatla",
        "America/Yakutat",
        "America/Nome",
        "America/Adak",
        "Pacific/Honolulu",
        "US/Alaska",
        "US/Aleutian",
        "US/Arizona",
        "US/Central",
        "US/East-Indiana",
        "US/Eastern",
        "US/Hawaii",
        "US/Indiana-Starke",
        "US/Michigan",
        "US/Mountain",
        "US/Pacific",
    ]
    schemes = [URN.TEL_SCHEME]

    claim_view = AuthenticatedExternalClaimView
    claim_view_kwargs = {
        "username_label": _("Username"),
        "password_label": _("API Key"),
    }
    claim_blurb = _(
        "%(link)s offers business SMS on dedicated numbers, used by businesses large and small through its dashboard "
        "and API. Connect a ClickSend number, and an inbound rule on it forwards contacts' replies to your workspace."
    ) % {"link": '<a target="_blank" href="https://www.clicksend.com/">ClickSend</a>'}

    config_ui = ConfigUI(
        blurb=_("To finish configuring this channel, you need to set your inbound SMS URL below for your number."),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Receive URL"),
                help=_(
                    "This URL should be called by ClickSend when new messages are received. "
                    "On your ClickSend dashboard, you can set this URL by going to SMS, then Settings, "
                    "then the Inbound SMS Settings menu. "
                    "Add a new rule, select action URL, and use the URL above, then click save."
                ),
            ),
        ],
    )
