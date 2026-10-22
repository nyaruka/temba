from unittest.mock import patch

from requests import RequestException

from django.forms import ValidationError
from django.urls import reverse

from temba.tests import MockResponse, TembaTest

from ...models import Channel
from .type import ZENVIA_MESSAGE_SUBSCRIPTION_ID, ZENVIA_STATUS_SUBSCRIPTION_ID, ZenviaWhatsAppType


class ZenviaWhatsAppTypeTest(TembaTest):
    def test_claim(self):
        Channel.objects.all().delete()

        self.login(self.admin)

        url = reverse("channels.types.zenvia_whatsapp.claim")

        # should see the general channel claim page
        response = self.client.get(reverse("channels.channel_claim"))
        self.assertContains(response, url)

        # try to claim a channel
        response = self.client.get(url)
        post_data = response.context["form"].initial

        post_data["token"] = "12345"
        post_data["country"] = "US"
        post_data["number"] = "(206) 555-1212"

        with patch("requests.get") as mock_get:
            mock_get.return_value = MockResponse(400, "Error")
            with patch("requests.post") as mock_post:
                mock_post.side_effect = [MockResponse(400, '{ "error": true }')]

                response = self.client.post(url, post_data)
                self.assertContains(response, "Please check your Zenvia account settings")

        with patch("requests.get") as mock_get:
            mock_get.return_value = MockResponse(200, "Success")
            with patch("requests.post") as mock_post:
                mock_post.side_effect = [MockResponse(400, '{ "error": true }')]

                with self.assertRaises(ValidationError):
                    self.client.post(url, post_data)

        with patch("requests.get") as mock_get:
            mock_get.return_value = MockResponse(200, "Success")
            with patch("requests.post") as mock_post:
                mock_post.side_effect = [
                    MockResponse(200, '{"id": "message_123"}'),
                    MockResponse(400, '{"error": "failed"}'),
                ]

                with self.assertRaises(ValidationError):
                    self.client.post(url, post_data)

                self.assertEqual("12345", mock_post.call_args_list[0][1]["headers"]["X-API-TOKEN"])

        with patch("requests.get") as mock_get:
            mock_get.return_value = MockResponse(200, "Success")
            with patch("requests.post") as mock_post:
                mock_post.side_effect = [
                    MockResponse(200, '{"id": "message_123"}'),
                    MockResponse(200, '{"id": "status_123"}'),
                ]

                self.client.post(url, post_data)

        channel = Channel.objects.get()

        self.assertEqual("US", channel.country)
        self.assertTrue(channel.uuid)
        self.assertEqual("+12065551212", channel.address)
        self.assertEqual("12345", channel.config["api_key"])
        self.assertEqual("ZVW", channel.channel_type)
        self.assertEqual("Zenvia WhatsApp: +12065551212", channel.name)

        with patch("requests.delete") as mock_delete:
            mock_delete.return_value = MockResponse(204, "")

            # deactivate our channel
            channel.release(self.admin, interrupt=False)

            self.assertEqual(2, mock_delete.call_count)
            self.assertEqual("https://api.zenvia.com/v2/subscriptions/message_123", mock_delete.call_args_list[0][0][0])
            self.assertEqual("12345", mock_delete.call_args_list[0][1]["headers"]["X-API-TOKEN"])
            self.assertEqual("https://api.zenvia.com/v2/subscriptions/status_123", mock_delete.call_args_list[1][0][0])

        # try to claim a channel
        response = self.client.get(url)
        post_data = response.context["form"].initial

        post_data["token"] = "12345"
        post_data["country"] = "US"
        post_data["number"] = "(206) 555-1212"

        with patch("requests.get") as mock_get:
            mock_get.return_value = MockResponse(200, "Success")
            with patch("requests.post") as mock_post:
                mock_post.side_effect = [
                    MockResponse(200, '{"id": "message_123"}'),
                    MockResponse(200, '{"id": "status_123"}'),
                ]

                self.client.post(url, post_data)

        channel = Channel.objects.filter(is_active=True).first()

        self.assertEqual("12345", mock_post.call_args_list[0][1]["headers"]["X-API-TOKEN"])

        self.assertEqual("message_123", channel.config.get(ZENVIA_MESSAGE_SUBSCRIPTION_ID))
        self.assertEqual("status_123", channel.config.get(ZENVIA_STATUS_SUBSCRIPTION_ID))

        with patch("requests.delete") as mock_delete:
            mock_delete.return_value = MockResponse(400, "Error")

            # deactivate our channel
            channel.release(self.admin, interrupt=False)

            self.assertEqual(2, mock_delete.call_count)
            self.assertEqual("https://api.zenvia.com/v2/subscriptions/message_123", mock_delete.call_args_list[0][0][0])
            self.assertEqual("12345", mock_delete.call_args_list[0][1]["headers"]["X-API-TOKEN"])
            self.assertEqual("https://api.zenvia.com/v2/subscriptions/status_123", mock_delete.call_args_list[1][0][0])
            self.assertEqual("12345", mock_delete.call_args_list[1][1]["headers"]["X-API-TOKEN"])

    @patch("requests.get")
    def test_check_credentials(self, mock_get):
        config = {"api_key": "zv-token"}
        mock_get.side_effect = [
            MockResponse(200, "[]"),
            MockResponse(401, "{}"),
            RequestException("Network is unreachable"),
        ]

        self.assertTrue(ZenviaWhatsAppType().check_credentials(config))
        self.assertFalse(ZenviaWhatsAppType().check_credentials(config))
        self.assertFalse(ZenviaWhatsAppType().check_credentials(config))

        self.assertEqual("https://api.zenvia.com/v2/subscriptions", mock_get.call_args[0][0])
