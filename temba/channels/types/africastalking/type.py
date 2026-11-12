from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import ChannelType, ConfigUI
from .views import ClaimView


class AfricasTalkingType(ChannelType):
    """
    An Africa's Talking channel (https://africastalking.com/)
    """

    code = "AT"
    name = "Africa's Talking"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]

    claim_blurb = _(
        "%(link)s offers SMS short codes in over 20 countries across Africa through a single account, connected "
        "directly to each country's mobile networks. Connect a short code you have with them to message contacts "
        "throughout the region."
    ) % {"link": """<a target="_blank" href="https://africastalking.com">Africa's Talking</a>"""}
    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to add the following callback URLs to your account on the "
            "Africa's Talking website."
        ),
        endpoints=[
            ConfigUI.Endpoint(
                courier="receive",
                label=_("Callback URL"),
                help=_(
                    "You can set the callback URL on your Africa's Talking account by visiting the SMS Dashboard page, "
                    "then clicking on Callback URL."
                ),
            ),
            ConfigUI.Endpoint(
                courier="status",
                label=_("Delivery URL"),
                help=_(
                    "You can set the delivery URL on your Africa's Talking account by visiting the SMS Dashboard page, "
                    "then clicking on Delivery Reports."
                ),
            ),
        ],
    )

    available_timezones = [
        "Africa/Abidjan",
        "Africa/Accra",
        "Africa/Addis_Ababa",
        "Africa/Blantyre",
        "Africa/Dakar",
        "Africa/Dar_es_Salaam",
        "Africa/Douala",
        "Africa/Gabarone",
        "Africa/Harare",
        "Africa/Johannesburg",
        "Africa/Kampala",
        "Africa/Kigali",
        "Africa/Lagos",
        "Africa/Lusaka",
        "Africa/Maseru",
        "Africa/Mbabane",
        "Africa/Nairobi",
        "Africa/Ouagadougou",
        "Africa/Porto-Novo",
        "Africa/Windhoek",
    ]

    def is_recommended_to(self, org, user):
        return self.is_available_to(org, user)[0]
