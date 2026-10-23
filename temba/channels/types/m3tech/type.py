from django.utils.translation import gettext_lazy as _

from temba.channels.views import AuthenticatedExternalClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class M3TechType(ChannelType):
    """
    An M3 Tech channel (http://m3techservice.com)
    """

    code = "M3"
    name = "M3 Tech"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]

    claim_blurb = _("Easily add a two way number you have configured with %(link)s using their APIs.") % {
        "link": '<a target="_blank" href="http://m3techservice.com">M3 Tech</a>'
    }
    claim_view = AuthenticatedExternalClaimView

    credentials = (
        ChannelType.Credential("username", _("Username"), _("The username provided by the provider to use their API")),
        ChannelType.Credential("password", _("Password"), _("The password provided by the provider to use their API")),
    )

    config_ui = ConfigUI(
        blurb=_("To finish configuring this channel, you'll need to notify M3Tech of the following callback URLs."),
        endpoints=[
            ConfigUI.Endpoint(courier="receive", label=_("Received URL")),
            ConfigUI.Endpoint(courier="sent", label=_("Sent URL")),
            ConfigUI.Endpoint(courier="delivered", label=_("Delivered URL")),
            ConfigUI.Endpoint(courier="failed", label=_("Failed URL")),
        ],
    )

    available_timezones = ["Asia/Karachi"]
