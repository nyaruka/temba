from twilio.base.exceptions import TwilioRestException

from django.conf import settings
from django.urls import re_path, reverse
from django.utils.translation import gettext_lazy as _

from temba.contacts.models import URN
from temba.utils.timezones import timezone_to_country_code

from ...models import Channel, ChannelType
from .client import TwilioClient
from .views import SUPPORTED_COUNTRIES, ClaimView, Connect, SearchView, UpdateForm


class TwilioType(ChannelType):
    """
    An Twilio channel
    """

    SESSION_ACCOUNT_SID = "TWILIO_ACCOUNT_SID"
    SESSION_AUTH_TOKEN = "TWILIO_AUTH_TOKEN"

    code = "T"
    name = "Twilio"
    category = ChannelType.Category.PHONE

    unique_addresses = True

    schemes = [URN.TEL_SCHEME]
    redact_request_keys = (
        "FromCity",
        "FromState",
        "FromZip",
        "ToCity",
        "ToState",
        "ToZip",
        "CalledCity",
        "CalledState",
        "CalledZip",
    )

    claim_blurb = _(
        "%(link)s offers phone numbers in many countries, and a number from your Twilio account can handle both SMS "
        "and voice calls, so contacts can text it or call it and be answered by your flows. Where the number "
        "supports it, messages can include photos and other media."
    ) % {"link": '<a target="_blank" href="https://www.twilio.com/">Twilio</a>'}
    claim_view = ClaimView
    update_form = UpdateForm

    async_activation = False

    def is_recommended_to(self, org, user):
        return timezone_to_country_code(org.timezone) in SUPPORTED_COUNTRIES

    def activate(self, channel):
        config = channel.config
        client = TwilioClient(config[Channel.CONFIG_ACCOUNT_SID], config[Channel.CONFIG_AUTH_TOKEN])
        callback_domain = channel.callback_domain
        base_url = "https://" + callback_domain

        # create a TwiML app to handle messaging and voice for this channel
        new_app = client.api.applications.create(
            friendly_name="%s/%s" % (callback_domain.lower(), channel.uuid),
            sms_method="POST",
            sms_url=channel.courier_url("receive"),
            voice_method="POST",
            voice_url=base_url + reverse("mailroom.ivr_handler", args=[channel.uuid, "incoming"]),
            status_callback_method="POST",
            status_callback=base_url + reverse("mailroom.ivr_handler", args=[channel.uuid, "status"]),
            voice_fallback_method="GET",
            voice_fallback_url=f"{settings.STORAGE_URL}/voice_unavailable.xml",
        )

        channel.config[Channel.CONFIG_APPLICATION_SID] = new_app.sid
        channel.save(update_fields=("config",))

        number_sid = config[Channel.CONFIG_NUMBER_SID]
        if len(channel.address) <= 6:  # short codes can't use TwiML apps and point directly at our receive URL
            client.api.short_codes.get(number_sid).update(sms_url=channel.courier_url("receive"), sms_method="POST")
        else:
            client.api.incoming_phone_numbers.get(number_sid).update(
                voice_application_sid=new_app.sid, sms_application_sid=new_app.sid
            )

    def deactivate(self, channel):
        config = channel.config
        client = TwilioClient(config[Channel.CONFIG_ACCOUNT_SID], config[Channel.CONFIG_AUTH_TOKEN])
        number_update_args = {"sms_application_sid": ""}

        if channel.supports_ivr():
            number_update_args["voice_application_sid"] = ""

        try:
            try:
                number_sid = channel.config["number_sid"]
                client.api.incoming_phone_numbers.get(number_sid).update(**number_update_args)
            except Exception:
                if client:
                    matching = client.api.incoming_phone_numbers.stream(phone_number=channel.address)
                    first_match = next(matching, None)
                    if first_match:
                        client.api.incoming_phone_numbers.get(first_match.sid).update(**number_update_args)

            if "application_sid" in config:
                try:
                    client.api.applications.get(sid=config["application_sid"]).delete()
                except TwilioRestException:  # pragma: no cover
                    pass

        except TwilioRestException as e:
            # we swallow 20003 which means our twilio key is no longer valid
            if e.code != 20003:
                raise e

    def get_urls(self):
        return [
            self.get_claim_url(),
            re_path(r"^search/$", SearchView.as_view(channel_type=self), name="search"),
            re_path(r"^connect/$", Connect.as_view(channel_type=self), name="connect"),
        ]

    def get_error_ref_url(self, channel, code: str) -> str:
        return f"https://www.twilio.com/docs/api/errors/{code}"

    def check_credentials(self, config: dict) -> bool:
        account_sid = config.get("account_sid", None)
        account_token = config.get("auth_token", None)

        try:
            client = TwilioClient(account_sid, account_token)
            # get the actual primary auth tokens from twilio and use them
            client.api.account.fetch()
        except Exception:  # pragma: needs cover
            return False
        return True
