from django.utils.translation import gettext_lazy as _

from temba.channels.types.kannel.views import ClaimView
from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI


class KannelType(ChannelType):
    """
    An Kannel channel (http://www.kannel.org/)
    """

    code = "KN"
    name = "Kannel"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]

    claim_blurb = _(
        "%(link)s is an open source SMS gateway you host yourself, connecting directly to mobile operators' SMS "
        "centers. If you run Kannel with your own SMSC connections, connect it to send and receive SMS through them."
    ) % {"link": '<a target="_blank" href="https://www.kannel.org/">Kannel</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI()  # has own template
