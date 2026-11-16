from django.utils.translation import gettext_lazy as _

from temba.channels.types.jasmin.views import ClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class JasminType(ChannelType):
    """
    An Jasmin channel (http://www.jasminsms.com/)
    """

    code = "JS"
    name = "Jasmin"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]

    claim_blurb = _(
        "%(link)s is an open source SMS gateway you host yourself, routing messages to mobile operators over SMPP. "
        "If you run Jasmin with your own SMSC connections, connect it to send and receive SMS through them."
    ) % {"link": '<a target="_blank" href="https://docs.jasminsms.com/">Jasmin</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to configure Jasmin to call the following URL for MO (incoming) messages."
        ),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Push Message URL"),
                help=_(
                    "This endpoint will be called by Jasmin when new messages are received to your number, "
                    "it must be configured to be called as a POST."
                ),
            ),
        ],
    )
