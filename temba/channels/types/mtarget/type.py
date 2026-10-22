from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import Channel, ChannelType, ConfigUI
from .views import ClaimView


class MtargetType(ChannelType):
    """
    An Mtarget channel type (https://www.mtarget.fr/)
    """

    code = "MT"
    name = "Mtarget"
    category = ChannelType.Category.PHONE

    unique_addresses = True

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["Africa/Kigali", "Africa/Yaoundé", "Africa/Porto-Novo", "Africa/Kinshasa", "Europe/Paris"]
    recommended_timezones = ["Africa/Kigali", "Africa/Yaoundé", "Africa/Porto-Novo", "Africa/Kinshasa", "Europe/Paris"]

    claim_view = ClaimView
    credential_fields = {Channel.CONFIG_USERNAME: _("Username"), Channel.CONFIG_PASSWORD: _("Password")}
    claim_blurb = _("If you have an %(link)s account, you can quickly connect it using their APIs.") % {
        "link": '<a target="_blank" href="https://www.mtarget.fr/">Mtarget</a>'
    }

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you need to have Mtarget configure the URLs below for your Service ID."
        ),
        endpoints=[
            ConfigUI.Endpoint(courier="receive", label=_("Receive URL")),
            ConfigUI.Endpoint(courier="status", label=_("Status URL")),
        ],
    )
