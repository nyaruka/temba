from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN

from ...models import Channel, ChannelType, ConfigUI
from .views import ClaimView


class CallbackEndpoint(ConfigUI.Endpoint):
    """
    Callbacks aren't signed, so the URL given to mNotify carries the channel's secret.
    """

    def get_url(self, channel) -> str:
        return f"{super().get_url(channel)}?token={channel.config[Channel.CONFIG_SECRET]}"


class MNotifyType(ChannelType):
    """
    An mNotify IVR channel (https://www.mnotify.com/)
    """

    code = "MN"
    name = "mNotify"
    category = ChannelType.Category.PHONE

    schemes = [URN.TEL_SCHEME]
    available_timezones = ["Africa/Accra"]

    claim_blurb = _(
        "%(link)s provides voice numbers in Ghana. If you have an IVR number with them, connect it to make and "
        "receive calls. Calls can only play recorded audio, so every message in your voice flows needs a recording."
    ) % {"link": '<a target="_blank" href="https://www.mnotify.com/">mNotify</a>'}
    claim_view = ClaimView

    config_ui = ConfigUI(
        blurb=_(
            "To finish configuring this channel, you'll need to have mNotify set the following callback URL for your "
            "number. Voice flows on this channel need a recording for every message as text can't be read out."
        ),
        endpoints=[
            CallbackEndpoint(
                mailroom="callback",
                label=_("Callback URL"),
                help=_(
                    "All call events for your number are sent to this URL. Keep it private as it includes a secret."
                ),
            ),
        ],
    )

    def is_recommended_to(self, org, user):
        return self.is_available_to(org, user)[0]
