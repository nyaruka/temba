from unittest.mock import patch

from django.urls import reverse

from temba.tests import MockResponse, TembaTest

from ...models import Channel
from .type import ZENVIA_MESSAGE_SUBSCRIPTION_ID, ZENVIA_STATUS_SUBSCRIPTION_ID


class ZenviaWhatsAppTypeTest(TembaTest):
    def test_claim(self):
        Channel.objects.all().delete()

        self.login(self.admin)

        url = reverse("channels.types.zenvia_whatsapp.claim")

        # should be offered by the new channel picker
        self.assertChannelTypeOffered(url)

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

                # failing to subscribe to its webhooks is shown on the form, and nothing is added
                response = self.client.post(url, post_data)
                self.assertEqual(200, response.status_code)
                self.assertTrue(response.context["form"].non_field_errors())
                self.assertFalse(self.org.channels.filter(channel_type__in=("ZVS", "ZVW"), is_active=True))

        with patch("requests.get") as mock_get:
            mock_get.return_value = MockResponse(200, "Success")
            with patch("requests.post") as mock_post:
                mock_post.side_effect = [
                    MockResponse(200, '{"id": "message_123"}'),
                    MockResponse(400, '{"error": "failed"}'),
                ]

                # failing to subscribe to its webhooks is shown on the form, and nothing is added
                response = self.client.post(url, post_data)
                self.assertEqual(200, response.status_code)
                self.assertTrue(response.context["form"].non_field_errors())
                self.assertFalse(self.org.channels.filter(channel_type__in=("ZVS", "ZVW"), is_active=True))

                self.assertEqual("12345", mock_post.call_args_list[0][1]["headers"]["X-API-TOKEN"])

        with patch("requests.get") as mock_get:
            mock_get.return_value = MockResponse(200, "Success")
            with patch("requests.post") as mock_post:
                mock_post.side_effect = [
                    MockResponse(200, '{"id": "message_123"}'),
                    MockResponse(200, '{"id": "status_123"}'),
                ]

                self.client.post(url, post_data)

        # the channels which failed to activate were removed again
        channel = Channel.objects.get(is_active=True)

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
