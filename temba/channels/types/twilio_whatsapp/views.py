import phonenumbers
from phonenumbers.phonenumberutil import region_code_for_number
from smartmin.views import SmartFormView
from twilio.base.exceptions import TwilioRestException
from twilio.rest import Client as TwilioClient

from django import forms
from django.http import HttpResponseRedirect
from django.urls import reverse
from django.utils.translation import gettext_lazy as _

from temba.channels.types.twilio.views import SUPPORTED_COUNTRIES, UpdateForm as TwilioUpdateForm
from temba.contacts.models import URN
from temba.utils.fields import InputWidget, SelectWidget
from temba.utils.uuid import uuid4

from ...models import Channel
from ...views import ALL_COUNTRIES, BaseClaimNumberMixin, ClaimViewMixin


class ClaimView(BaseClaimNumberMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        country = forms.ChoiceField(choices=ALL_COUNTRIES, widget=SelectWidget(attrs={"searchable": True}))
        phone_number = forms.CharField(help_text=_("The phone number being added"))

        def clean_phone_number(self):
            phone = self.cleaned_data["phone_number"]
            phone = phonenumbers.parse(phone, self.cleaned_data["country"])
            return phonenumbers.format_number(phone, phonenumbers.PhoneNumberFormat.E164)

        def clean(self):
            self.cleaned_data["address"] = self.cleaned_data["phone_number"]
            return super().clean()

    form_class = Form

    def __init__(self, channel_type):
        super().__init__(channel_type)
        self.account = None
        self.client = None

    def get_twilio_client(self):
        account_sid = self.request.session.get(self.channel_type.SESSION_ACCOUNT_SID, None)
        account_token = self.request.session.get(self.channel_type.SESSION_AUTH_TOKEN, None)

        if account_sid and account_token:
            return TwilioClient(account_sid, account_token)
        return None

    def get_whatsapp_senders(self):
        """
        Fetches the ONLINE WhatsApp senders registered on the account via Twilio's Senders API. These are not
        necessarily incoming phone numbers on the account, so they won't show up in incoming_phone_numbers.
        """
        client = self.get_twilio_client()
        if not client:
            return []

        senders = []
        for sender in client.messaging.v2.channels_senders.stream(channel="whatsapp"):
            if sender.status != "ONLINE":
                continue

            # sender_id looks like "whatsapp:+1234567890"
            sender_id = sender.sender_id or ""
            if not sender_id.startswith("whatsapp:"):
                continue
            phone = sender_id.split(":", 1)[-1]
            try:
                parsed = phonenumbers.parse(phone, None)
            except phonenumbers.NumberParseException:
                continue

            senders.append(
                dict(
                    e164=phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164),
                    number=phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.INTERNATIONAL),
                    country=region_code_for_number(parsed),
                    sid=sender.sid,
                )
            )

        return senders

    def pre_process(self, request, *args, **kwargs):
        try:
            self.client = self.get_twilio_client()
            if not self.client:
                return HttpResponseRedirect(
                    f"{reverse('channels.types.twilio.connect')}?claim_type={self.channel_type.slug}"
                )
            self.account = self.client.api.account.fetch()
        except TwilioRestException:
            return HttpResponseRedirect(
                f"{reverse('channels.types.twilio.connect')}?claim_type={self.channel_type.slug}"
            )

        return super().pre_process(request, *args, **kwargs)

    def get_search_countries_tuple(self):
        return []

    def get_supported_countries_tuple(self):
        return ALL_COUNTRIES

    def get_search_url(self):
        return ""

    def get_claim_url(self):
        return reverse("channels.types.twilio_whatsapp.claim")

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)

        account_trial = False
        if self.account:
            account_trial = self.account.type.lower() == "trial"

        context["account_trial"] = account_trial

        context["current_creds_account"] = self.request.session.get(self.channel_type.SESSION_ACCOUNT_SID, None)
        return context

    def get_existing_numbers(self, org):
        client = self.get_twilio_client()
        if not client:
            return []

        numbers = []
        seen = set()
        for number in client.api.incoming_phone_numbers.stream(page_size=1000):
            parsed = phonenumbers.parse(number.phone_number, None)
            seen.add(phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164))
            numbers.append(
                dict(
                    number=phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.INTERNATIONAL),
                    country=region_code_for_number(parsed),
                )
            )

        # also offer WhatsApp senders that aren't incoming numbers on the account
        try:
            for sender in self.get_whatsapp_senders():
                if sender["e164"] in seen:
                    continue
                seen.add(sender["e164"])
                numbers.append(dict(number=sender["number"], country=sender["country"]))
        except TwilioRestException:
            # don't let a senders API failure hide the account's incoming numbers
            pass

        return numbers

    def is_valid_country(self, calling_code: int) -> bool:
        return True

    def is_messaging_country(self, country_code: str) -> bool:
        return country_code in SUPPORTED_COUNTRIES

    def claim_number(self, user, phone_number, country, role):
        org = self.request.org
        client = self.get_twilio_client()
        twilio_phones = client.api.incoming_phone_numbers.stream(phone_number=phone_number)
        channel_uuid = uuid4()

        callback_domain = org.get_brand_domain()

        twilio_phone = next(twilio_phones, None)
        if twilio_phone:
            number_sid = twilio_phone.sid
        else:
            # not an incoming number on the account, see if it's a registered WhatsApp sender
            try:
                senders = self.get_whatsapp_senders()
            except TwilioRestException:
                raise Exception(_("Unable to verify WhatsApp sender, please try again."))
            sender = next((s for s in senders if s["e164"] == phone_number), None)
            if not sender:
                raise Exception(_("Only existing Twilio WhatsApp number are supported"))
            number_sid = sender["sid"]

        phone = phonenumbers.format_number(
            phonenumbers.parse(phone_number, None), phonenumbers.PhoneNumberFormat.NATIONAL
        )

        config = {
            Channel.CONFIG_NUMBER_SID: number_sid,
            Channel.CONFIG_ACCOUNT_SID: self.request.session.get(self.channel_type.SESSION_ACCOUNT_SID),
            Channel.CONFIG_AUTH_TOKEN: self.request.session.get(self.channel_type.SESSION_AUTH_TOKEN),
            Channel.CONFIG_CALLBACK_DOMAIN: callback_domain,
        }

        role = Channel.ROLE_SEND + Channel.ROLE_RECEIVE

        channel = Channel.create(
            org,
            user,
            country,
            self.channel_type,
            name=phone,
            address=phone_number,
            role=role,
            config=config,
            uuid=channel_uuid,
            schemes=[URN.WHATSAPP_SCHEME],
        )

        return channel

    def remove_api_credentials_from_session(self):
        if self.channel_type.SESSION_ACCOUNT_SID in self.request.session:
            del self.request.session[self.channel_type.SESSION_ACCOUNT_SID]
        if self.channel_type.SESSION_AUTH_TOKEN in self.request.session:
            del self.request.session[self.channel_type.SESSION_AUTH_TOKEN]


class UpdateForm(TwilioUpdateForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.add_config_field(
            "messaging_service_sid",
            forms.CharField(
                max_length=34,
                label=_("Twilio Messaging Service SID"),
                required=False,
                widget=InputWidget(),
            ),
            default="",
        )
