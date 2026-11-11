from django.utils.translation import gettext_lazy as _

from temba.channels.views import AuthenticatedExternalClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class MbloxType(ChannelType):
    """
    A Sinch SMS channel, formerly Mblox (https://developers.sinch.com/docs/sms/api-reference)
    """

    code = "MB"
    name = "Sinch SMS"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]

    claim_blurb = _(
        "If you have a number on an existing %(link)s SMS service plan, formerly Mblox, you can connect it using "
        "their APIs."
    ) % {"link": '<a target="_blank" href="https://sinch.com/">Sinch</a>'}
    claim_view = AuthenticatedExternalClaimView
    claim_view_kwargs = {
        "username_label": _("Service Plan ID"),
        "username_help": _("Found on your Sinch dashboard."),
        "password_label": _("API Token"),
        "password_help": _("Found on your Sinch dashboard."),
        "form_blurb": _("You can connect your Sinch number by entering the settings below."),
    }

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to set the following callback URL on your Sinch SMS "
            "service plan."
        ),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Callback URL"),
                help=_(
                    "This endpoint will be called by Sinch when new messages are received to your number and for delivery "
                    "reports."
                ),
            ),
        ],
    )
