from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import ChannelType
from .views import ClaimView


class AndroidType(ChannelType):
    """
    An Android relayer app channel type
    """

    code = "A"
    name = "Android"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]

    claim_blurb = _(
        "An Android phone can send and receive messages for you using the SIM card and plan it already has, so you can "
        "get started in any country without an account with a messaging provider. Contacts text the phone's number, "
        "and messages are charged to its plan."
    )
    claim_view = ClaimView

    def is_recommended_to(self, org, user):
        return False
