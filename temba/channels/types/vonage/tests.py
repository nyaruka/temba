from unittest.mock import call, patch

import requests
from vonage_application.responses import ApplicationData
from vonage_http_client.errors import AuthenticationError, HttpRequestError, NotFoundError, RateLimitedError
from vonage_numbers.requests import (
    ListOwnedNumbersFilter,
    NumberParams,
    SearchAvailableNumbersFilter,
    UpdateNumberParams,
)
from vonage_numbers.responses import AvailableNumber, OwnedNumber

from django.urls import reverse

from temba.channels.models import Channel
from temba.tests import MockResponse, TembaTest

from .client import VonageClient
from .type import VonageType


class VonageTypeTest(TembaTest):
    @patch("temba.channels.types.vonage.client.VonageClient.create_application")
    @patch("temba.channels.types.vonage.client.VonageClient.get_numbers")
    @patch("temba.channels.types.vonage.client.VonageClient.buy_number")
    @patch("temba.channels.types.vonage.client.VonageClient.update_number")
    def test_claim(self, mock_update_number, mock_buy_number, mock_get_numbers, mock_create_application):
        self.login(self.admin)

        claim_url = reverse("channels.types.vonage.claim")

        # remove any existing channels
        self.org.channels.update(is_active=False)

        # make sure Vonage is on the claim page
        response = self.client.get(reverse("channels.channel_claim"))
        self.assertContains(response, "Vonage")

        response = self.client.get(claim_url)
        self.assertEqual(response.status_code, 302)
        response = self.client.get(claim_url, follow=True)
        self.assertEqual(response.request["PATH_INFO"], reverse("channels.types.vonage.connect"))

        # check the connect view has no initial set
        response = self.client.get(reverse("channels.types.vonage.connect"))
        self.assertEqual(200, response.status_code)
        self.assertEqual(list(response.context["form"].fields.keys()), ["api_key", "api_secret", "loc"])
        self.assertFalse(response.context["form"].initial)

        # attach a Vonage account to the session
        session = self.client.session
        session[VonageType.SESSION_API_KEY] = "key123"
        session[VonageType.SESSION_API_SECRET] = "sesame"
        session.save()

        # hit the claim page, should now have a claim link
        response = self.client.get(reverse("channels.channel_claim"))
        self.assertContains(response, claim_url)

        # try adding a shortcode
        mock_get_numbers.side_effect = [
            [],
            [{"features": ["SMS"], "type": "mobile-lvn", "country": "US", "msisdn": "8080"}],
            [{"features": ["SMS"], "type": "mobile-lvn", "country": "US", "msisdn": "8080"}],
        ]

        response = self.client.post(claim_url, {"country": "US", "phone_number": "8080"})
        self.assertRedirects(response, reverse("public.public_welcome") + "?success")
        channel = Channel.objects.filter(address="8080").first()
        self.assertIn(Channel.ROLE_SEND, channel.role)
        self.assertIn(Channel.ROLE_RECEIVE, channel.role)
        self.assertNotIn(Channel.ROLE_ANSWER, channel.role)
        self.assertNotIn(Channel.ROLE_CALL, channel.role)
        Channel.objects.all().delete()

        # try buying a number not on the account
        mock_get_numbers.side_effect = [
            [],
            [],
            [{"features": ["SMS"], "type": "mobile", "country": "US", "msisdn": "+12065551212"}],
        ]

        response = self.client.post(claim_url, {"country": "US", "phone_number": "+12065551212"})
        self.assertRedirects(response, reverse("public.public_welcome") + "?success")

        channel = Channel.objects.filter(address="+12065551212").first()
        self.assertIn(Channel.ROLE_SEND, channel.role)
        self.assertIn(Channel.ROLE_RECEIVE, channel.role)
        Channel.objects.all().delete()

        # try failing to buy a number not on the account
        mock_get_numbers.side_effect = [[], []]
        mock_buy_number.side_effect = HttpRequestError(MockResponse(400, '{"error": "nope"}'))

        response = self.client.post(claim_url, {"country": "US", "phone_number": "+12065551212"})
        self.assertTrue(response.context["form"].errors)
        self.assertContains(
            response,
            "There was a problem claiming that number, "
            "please check the balance on your account. "
            "Note that you can only claim numbers after "
            "adding credit to your Vonage account.",
        )
        Channel.objects.all().delete()

        # let's add a number already connected to the account
        mock_get_numbers.side_effect = [
            [{"features": ["SMS", "VOICE"], "type": "mobile-lvn", "country": "US", "msisdn": "13607884540"}],
            [{"features": ["SMS", "VOICE"], "type": "mobile-lvn", "country": "US", "msisdn": "13607884540"}],
        ]
        mock_create_application.return_value = ("myappid", "private")

        # make sure our number appears on the claim page
        response = self.client.get(claim_url)
        self.assertNotIn("account_trial", response.context)
        self.assertContains(response, "360-788-4540")

        # claim it
        response = self.client.post(claim_url, {"country": "US", "phone_number": "13607884540"})
        self.assertRedirects(response, reverse("public.public_welcome") + "?success")

        # make sure it is actually connected
        channel = Channel.objects.get(channel_type="NX", org=self.org)
        self.assertIn(Channel.ROLE_SEND, channel.role)
        self.assertIn(Channel.ROLE_RECEIVE, channel.role)
        self.assertIn(Channel.ROLE_ANSWER, channel.role)
        self.assertIn(Channel.ROLE_CALL, channel.role)

        self.assertEqual(channel.config[VonageType.CONFIG_API_KEY], "key123")
        self.assertEqual(channel.config[VonageType.CONFIG_API_SECRET], "sesame")
        self.assertEqual(channel.config[VonageType.CONFIG_APP_ID], "myappid")
        self.assertEqual(channel.config[VonageType.CONFIG_APP_PRIVATE_KEY], "private")

        # check the connect view has no initial set
        response = self.client.get(reverse("channels.types.vonage.connect"))
        self.assertEqual(302, response.status_code)
        self.assertRedirects(response, reverse("channels.types.vonage.claim"))

        response = self.client.get(reverse("channels.types.vonage.connect") + "?reset_creds=reset")
        self.assertEqual(200, response.status_code)
        self.assertEqual(list(response.context["form"].fields.keys()), ["api_key", "api_secret", "loc"])

        # test the update page for vonage
        update_url = reverse("channels.channel_update", args=[channel.pk])
        response = self.client.get(update_url)

        # try changing our address
        updated = response.context["form"].initial

        response = self.client.post(update_url, updated)
        channel = Channel.objects.get(pk=channel.id)

        self.assertEqual("+13607884540", channel.address)

        # add a canada number
        mock_get_numbers.side_effect = None
        mock_get_numbers.return_value = [
            {"features": ["SMS"], "type": "mobile-lvn", "country": "CA", "msisdn": "15797884540"}
        ]

        # make sure our number appears on the claim page
        response = self.client.get(claim_url)
        self.assertNotIn("account_trial", response.context)
        self.assertContains(response, "579-788-4540")

        # claim it
        response = self.client.post(claim_url, {"country": "CA", "phone_number": "15797884540"})
        self.assertRedirects(response, reverse("public.public_welcome") + "?success")

        # make sure it is actually connected
        self.assertTrue(Channel.objects.filter(channel_type="NX", org=self.org, address="+15797884540").first())

        # as is our old one
        self.assertTrue(Channel.objects.filter(channel_type="NX", org=self.org, address="+13607884540").first())

        config_url = reverse("channels.channel_configuration", args=[channel.uuid])
        response = self.client.get(config_url)
        self.assertEqual(200, response.status_code)

        self.assertContains(response, f"/c/nx/{channel.uuid}/receive")
        self.assertContains(response, f"/c/nx/{channel.uuid}/status")
        self.assertContains(response, reverse("mailroom.ivr_handler", args=[channel.uuid, "incoming"]))

    @patch("temba.channels.types.vonage.client.VonageClient.check_credentials")
    def test_vonage_connect(self, mock_check_credentials):
        self.login(self.admin)

        connect_url = reverse("channels.types.vonage.connect")

        self.assertNotIn(VonageType.SESSION_API_KEY, self.client.session)
        self.assertNotIn(VonageType.SESSION_API_SECRET, self.client.session)

        response = self.client.get(connect_url)
        self.assertEqual(200, response.status_code)
        self.assertEqual(list(response.context["form"].fields.keys()), ["api_key", "api_secret", "loc"])
        self.assertFalse(response.context["form"].initial)

        # try posting without an account token
        post_data = {"api_key": "key"}
        response = self.client.post(connect_url, post_data)
        self.assertFormError(response.context["form"], "api_secret", "This field is required.")

        # simulate invalid credentials on both pages
        mock_check_credentials.return_value = False

        response = self.client.post(connect_url, {"api_key": "key", "api_secret": "secret"})
        self.assertContains(response, "Your API key and secret seem invalid.")
        self.assertNotIn(VonageType.SESSION_API_KEY, self.client.session)
        self.assertNotIn(VonageType.SESSION_API_SECRET, self.client.session)

        # ok, now with a success
        mock_check_credentials.return_value = True

        response = self.client.post(connect_url, {"api_key": "key", "api_secret": "secret"})
        self.assertEqual(response.status_code, 302)

        response = self.client.post(connect_url, {"api_key": "key", "api_secret": "secret"}, follow=True)
        self.assertEqual(response.request["PATH_INFO"], reverse("channels.types.vonage.claim"))

        self.assertIn(VonageType.SESSION_API_KEY, self.client.session)
        self.assertIn(VonageType.SESSION_API_SECRET, self.client.session)
        self.assertEqual(self.client.session[VonageType.SESSION_API_KEY], "key")
        self.assertEqual(self.client.session[VonageType.SESSION_API_SECRET], "secret")

    @patch("temba.channels.types.vonage.client.VonageClient.search_numbers")
    def test_search(self, mock_search_numbers):
        self.login(self.admin)
        self.org.channels.update(is_active=False)
        self.channel = self.create_channel(
            "NX",
            "Vonage",
            "+250788123123",
            country="RW",
            config={VonageType.CONFIG_API_KEY: "1234", VonageType.CONFIG_API_SECRET: "secret"},
        )

        # attach a Vonage account to the session
        session = self.client.session
        session[VonageType.SESSION_API_KEY] = "1234"
        session[VonageType.SESSION_API_SECRET] = "secret"
        session.save()

        search_url = reverse("channels.types.vonage.search")

        response = self.client.get(search_url)
        self.assertEqual(["country", "pattern", "loc"], list(response.context["form"].fields.keys()))

        mock_search_numbers.return_value = [
            {"features": ["SMS", "VOICE"], "type": "mobile-lvn", "country": "US", "msisdn": "13607884540"},
            {"features": ["SMS", "VOICE"], "type": "mobile-lvn", "country": "US", "msisdn": "13607884550"},
        ]

        response = self.client.post(search_url, {"country": "US", "pattern": "360"})

        self.assertEqual(["+1 360-788-4540", "+1 360-788-4550"], response.json())

    def test_deactivate(self):
        channel = self.org.channels.all().first()
        channel.channel_type = "NX"
        channel.config = {
            VonageType.CONFIG_APP_ID: "myappid",
            VonageType.CONFIG_API_KEY: "api_key",
            VonageType.CONFIG_API_SECRET: "api_secret",
            VonageType.CONFIG_APP_PRIVATE_KEY: "secret",
        }
        channel.save(update_fields=("channel_type", "config"))

        # mock a 404 response from Vonage during deactivation
        with patch("vonage_application.Application.delete_application") as mock_delete_application:
            mock_delete_application.side_effect = NotFoundError(MockResponse(404, '{"error": "not found"}'))

            # releasing shouldn't blow up on auth failures
            channel.release(self.admin, interrupt=False)
            channel.refresh_from_db()

            self.assertFalse(channel.is_active)

            mock_delete_application.assert_called_once_with("myappid")

    def test_update(self):
        update_url = reverse("channels.channel_update", args=[self.channel.id])

        self.login(self.admin)
        response = self.client.get(update_url)
        self.assertEqual(
            ["name", "is_enabled", "allow_international", "loc"], list(response.context["form"].fields.keys())
        )

    def test_get_error_ref_url(self):
        self.assertEqual(
            "https://developer.vonage.com/messaging/sms/guides/troubleshooting-sms",
            VonageType().get_error_ref_url(None, "send:7"),
        )
        self.assertEqual(
            "https://developer.vonage.com/messaging/sms/guides/delivery-receipts",
            VonageType().get_error_ref_url(None, "dlr:8"),
        )
        self.assertIsNone(VonageType().get_error_ref_url(None, "x:9"))

    @patch("temba.channels.types.vonage.client.VonageClient.check_credentials")
    def test_check_credentials(self, mock_check_credentials):
        config = {"nexmo_api_key": "1234", "nexmo_api_secret": "secret"}

        mock_check_credentials.return_value = True
        self.assertTrue(VonageType().check_credentials(config))

        mock_check_credentials.return_value = False
        self.assertFalse(VonageType().check_credentials(config))

        # provider errors are treated as invalid rather than raised
        mock_check_credentials.side_effect = HttpRequestError(MockResponse(500, "Server Error"))
        self.assertFalse(VonageType().check_credentials(config))

        mock_check_credentials.side_effect = RateLimitedError(MockResponse(429, "Too Many Requests"))
        self.assertFalse(VonageType().check_credentials(config))

        mock_check_credentials.side_effect = requests.ConnectionError("Network is unreachable")
        self.assertFalse(VonageType().check_credentials(config))


class ClientTest(TembaTest):
    def setUp(self):
        super().setUp()

        self.client = VonageClient("abc123", "asecret")

    @patch("vonage_account.Account.get_balance")
    def test_check_credentials(self, mock_get_balance):
        mock_get_balance.side_effect = AuthenticationError(MockResponse(401, '{"error": "not allowed"}'))

        self.assertFalse(self.client.check_credentials())

        mock_get_balance.side_effect = None
        mock_get_balance.return_value = "12.35"

        self.assertTrue(self.client.check_credentials())

    @patch("vonage_numbers.Numbers.list_owned_numbers")
    def test_get_numbers(self, mock_list_owned_numbers):
        # as the client library parses them from the API response
        mock_list_owned_numbers.return_value = (
            [
                OwnedNumber(
                    **{
                        "country": "EC",
                        "msisdn": "23463",
                        "type": "mobile-lvn",
                        "features": ["SMS", "VOICE"],
                        "moHttpUrl": "http://acme.com/mo",
                    }
                ),
                OwnedNumber(**{"country": "EC", "msisdn": "568658", "type": "mobile-shortcode", "features": ["SMS"]}),
            ],
            2,
            None,
        )

        numbers = self.client.get_numbers(pattern="+593")

        self.assertEqual(["23463", "568658"], [n["msisdn"] for n in numbers])

        # claiming reads these keys off each number so check they survive being parsed and dumped again
        self.assertEqual("EC", numbers[0]["country"])
        self.assertEqual("mobile-lvn", numbers[0]["type"])
        self.assertEqual(["SMS", "VOICE"], numbers[0]["features"])
        self.assertEqual("mobile-shortcode", numbers[1]["type"])
        self.assertEqual(["SMS"], numbers[1]["features"])

        mock_list_owned_numbers.assert_called_once_with(
            ListOwnedNumbersFilter(size=10, pattern="593", search_pattern=0)
        )

    @patch("vonage_numbers.Numbers.search_available_numbers")
    def test_search_numbers(self, mock_search_available_numbers):
        mock_search_available_numbers.side_effect = [
            ([AvailableNumber(msisdn="23463"), AvailableNumber(msisdn="568658")], 2, None),
            ([AvailableNumber(msisdn="34636")], 1, None),
        ]

        self.assertEqual(
            ["23463", "568658", "34636"],
            [n["msisdn"] for n in self.client.search_numbers(country="EC", pattern="+593")],
        )

        mock_search_available_numbers.assert_has_calls(
            [
                call(SearchAvailableNumbersFilter(country="EC", pattern="+593", search_pattern=1, features="SMS")),
                call(SearchAvailableNumbersFilter(country="EC", pattern="+593", search_pattern=1, features="VOICE")),
            ]
        )

    @patch("vonage_numbers.Numbers.buy_number")
    def test_buy_number(self, mock_buy_number):
        self.client.buy_number(country="US", number="+12065551212")

        mock_buy_number.assert_called_once_with(NumberParams(country="US", msisdn="12065551212"))

    @patch("vonage_numbers.Numbers.update_number")
    def test_update_number(self, mock_update_number):
        self.client.update_number(country="US", number="+12345", mo_url="http://test", app_id="ID123")

        mock_update_number.assert_called_once_with(
            UpdateNumberParams(country="US", msisdn="12345", mo_http_url="http://test", app_id="ID123")
        )

        # short codes are fine to update even though they're too short to buy
        self.client.update_number(country="US", number="8080", mo_url="http://test", app_id=None)

        mock_update_number.assert_called_with(
            UpdateNumberParams(country="US", msisdn="8080", mo_http_url="http://test")
        )

    @patch("vonage_application.Application.create_application")
    def test_create_application(self, mock_create_application):
        mock_create_application.return_value = ApplicationData(
            id="myappid", name="rapidpro.io/702cb3b5", keys={"private_key": "tejh42gf3"}
        )

        app_id, app_private_key = self.client.create_application("rapidpro.io", "702cb3b5-8fec-4974-a87a-75234117c768")
        self.assertEqual(app_id, "myappid")
        self.assertEqual(app_private_key, "tejh42gf3")

        config = mock_create_application.call_args[0][0]

        self.assertEqual("rapidpro.io/702cb3b5-8fec-4974-a87a-75234117c768", config.name)
        self.assertEqual(
            "https://rapidpro.io/mr/ivr/c/702cb3b5-8fec-4974-a87a-75234117c768/incoming",
            config.capabilities.voice.webhooks.answer_url.address,
        )
        self.assertEqual("POST", config.capabilities.voice.webhooks.answer_url.http_method)
        self.assertEqual(
            "https://rapidpro.io/mr/ivr/c/702cb3b5-8fec-4974-a87a-75234117c768/status",
            config.capabilities.voice.webhooks.event_url.address,
        )
        self.assertEqual("POST", config.capabilities.voice.webhooks.event_url.http_method)

    @patch("vonage_application.Application.delete_application")
    def test_delete_application(self, mock_delete_application):
        self.client.delete_application("myappid")

        mock_delete_application.assert_called_once_with("myappid")

    @patch("temba.channels.types.vonage.client.VonageClient.RATE_LIMIT_BACKOFFS", [0.1, 0.1])
    @patch("requests.sessions.Session.request")
    def test_retry(self, mock_request):
        def rate_limited():
            return MockResponse(429, "<html>429 Too Many Requests</html>", headers={"Content-Type": "text/html"})

        def numbers(msisdn):
            return MockResponse(
                200,
                '{"count": 1, "numbers": [{"msisdn": "%s"}]}' % msisdn,
                headers={"Content-Type": "application/json"},
            )

        mock_request.side_effect = [
            rate_limited(),
            rate_limited(),
            rate_limited(),
            rate_limited(),
            numbers("12345"),
            numbers("23456"),
        ]

        # should retry twice and give up
        with self.assertRaises(RateLimitedError):
            self.client.get_numbers()

        self.assertEqual(3, mock_request.call_count)
        mock_request.reset_mock()

        # should retry once and then succeed
        self.assertEqual(["12345"], [n["msisdn"] for n in self.client.get_numbers()])
        self.assertEqual(2, mock_request.call_count)
        mock_request.reset_mock()

        # should succeed without any retries
        self.assertEqual(["23456"], [n["msisdn"] for n in self.client.get_numbers()])
        self.assertEqual(1, mock_request.call_count)
