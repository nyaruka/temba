from django.utils.translation import gettext_lazy as _

from temba.channels.types.globe.views import ClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class GlobeType(ChannelType):
    """
    A Globe Labs channel
    """

    code = "GL"
    name = "Globe Labs"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["Asia/Manila"]

    claim_blurb = _(
        "If you are based in the Phillipines, you can integrate {{ branding.name }} with Globe Labs to send and "
        "receive messages on your short code."
    )
    claim_view = ClaimView

    credentials = (
        ChannelType.Credential("app_id", _("Application Id"), _("The id of your Globe Labs application")),
        ChannelType.Credential(
            "app_secret", _("Application Secret"), _("The secret assigned to your Globe Labs application")
        ),
        ChannelType.Credential(
            "passphrase", _("Passphrase"), _("The passphrase assigned to you by Globe Labs to support sending")
        ),
    )

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to set the following notify URI for SMS on your "
            "application configuration page."
        ),
        endpoints=[
            ConfigUI.Endpoint(courier="receive", label=_("Notify URI")),
        ],
    )

    def is_recommended_to(self, org, user):
        return self.is_available_to(org, user)[0]
