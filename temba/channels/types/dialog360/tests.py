import json
from unittest.mock import patch

from requests import RequestException

from django.forms import ValidationError
from django.urls import reverse

from temba.request_logs.models import HTTPLog
from temba.tests import CRUDLTestMixin, MockResponse, TembaTest

from ...models import Channel
from .type import Dialog360Type


class Dialog360TypeTest(CRUDLTestMixin, TembaTest):
    def test_claim(self):
        Channel.objects.all().delete()

        url = reverse("channels.types.dialog360.claim")
        self.login(self.admin)

        # make sure 360dialog Cloud is on the claim page
        response = self.client.get(reverse("channels.channel_claim"), follow=True)
        self.assertContains(response, url)

        # should see the general channel claim page
        response = self.client.get(reverse("channels.channel_claim"))
        self.assertContains(response, url)

        response = self.client.get(url)
        self.assertEqual(200, response.status_code)
        post_data = response.context["form"].initial

        post_data["address"] = "1234"
        post_data["country"] = "RW"
        post_data["api_key"] = "123456789"

        # will fail with invalid phone number
        response = self.client.post(url, post_data)
        self.assertFormError(response.context["form"], None, ["Please enter a valid phone number"])

        # valid number
        post_data["address"] = "0788123123"

        # then success
        with patch("socket.gethostbyname", return_value="123.123.123.123"), patch("requests.post") as mock_post:
            mock_post.side_effect = [MockResponse(200, '{ "url": "https://waba-v2.360dialog.io" }')]

            response = self.client.post(url, post_data)
            self.assertEqual(302, response.status_code)

        channel = Channel.objects.get()

        self.assertEqual("123456789", channel.config[Channel.CONFIG_AUTH_TOKEN])
        self.assertEqual("https://waba-v2.360dialog.io", channel.config[Channel.CONFIG_BASE_URL])

        self.assertEqual("+250788123123", channel.address)
        self.assertEqual("RW", channel.country)
        self.assertEqual("D3C", channel.channel_type)
        self.assertEqual(45, channel.tps)
        self.assertEqual("D3C", channel.type.code)
        self.assertEqual("whatsapp", channel.template_type.slug)

        # test activating the channel
        with patch("requests.post") as mock_post:
            mock_post.side_effect = [MockResponse(200, '{ "url": "https://waba-v2.360dialog.io" }')]

            Dialog360Type().activate(channel)
            self.assertEqual(
                mock_post.call_args_list[0][1]["json"]["url"],
                "https://%s%s" % (channel.org.get_brand_domain(), f"/c/d3c/{channel.uuid}/receive"),
            )

        with patch("requests.post") as mock_post:
            mock_post.side_effect = [MockResponse(400, '{ "meta": { "success": false } }')]

            try:
                Dialog360Type().activate(channel)
                self.fail("Should have thrown error activating channel")
            except ValidationError:
                pass

        # deactivate our channel
        channel.release(self.admin, interrupt=False)

    @patch("requests.get")
    def test_fetch_templates(self, mock_get):
        channel = self.create_channel(
            "D3C",
            "360Dialog channel",
            address="1234",
            country="BR",
            config={
                Channel.CONFIG_BASE_URL: "https://waba-v2.360dialog.io",
                Channel.CONFIG_AUTH_TOKEN: "123456789",
            },
        )

        mock_get.side_effect = [
            RequestException("Network is unreachable", response=MockResponse(100, "")),
            MockResponse(400, '{ "meta": { "success": false } }', headers={"D360-API-KEY": "123456789"}),
            MockResponse(200, '{"waba_templates": ["foo", "bar"]}', headers={"D360-API-KEY": "123456789"}),
        ]

        with self.assertRaises(RequestException):
            channel.type.fetch_templates(channel)

        self.assertEqual(1, HTTPLog.objects.filter(log_type=HTTPLog.WHATSAPP_TEMPLATES_SYNCED, is_error=True).count())

        with self.assertRaises(RequestException):
            channel.type.fetch_templates(channel)

        self.assertEqual(2, HTTPLog.objects.filter(log_type=HTTPLog.WHATSAPP_TEMPLATES_SYNCED, is_error=True).count())

        templates = channel.type.fetch_templates(channel)
        self.assertEqual(["foo", "bar"], templates)

        self.assertEqual(2, HTTPLog.objects.filter(log_type=HTTPLog.WHATSAPP_TEMPLATES_SYNCED, is_error=True).count())
        self.assertEqual(1, HTTPLog.objects.filter(log_type=HTTPLog.WHATSAPP_TEMPLATES_SYNCED, is_error=False).count())

        # check auth token is redacted in HTTP logs
        for log in HTTPLog.objects.all():
            self.assertNotIn("123456789", json.dumps(log.get_display()))

        mock_get.assert_called_with(
            "https://waba-v2.360dialog.io/v1/configs/templates",
            headers={
                "D360-API-KEY": channel.config[Channel.CONFIG_AUTH_TOKEN],
                "Content-Type": "application/json",
            },
        )

    @patch("requests.get")
    def test_update(self, mock_get):
        channel = self.create_channel(
            "D3C",
            "360Dialog channel",
            address="+250788123123",
            country="RW",
            config={
                Channel.CONFIG_BASE_URL: "https://waba-v2.360dialog.io",
                Channel.CONFIG_AUTH_TOKEN: "123456789",
            },
        )
        update_url = reverse("channels.channel_update", args=[channel.id])

        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])
        self.assertUpdateFetch(
            update_url,
            [self.editor, self.admin],
            form_fields={"name": "360Dialog channel", "is_enabled": True, "auth_token": "123456789"},
        )

        # rejected API key
        mock_get.return_value = MockResponse(401, '{"meta": {"success": false}}')
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "360Dialog channel", "is_enabled": True, "auth_token": "invalid"},
            form_errors={"__all__": "Credentials don't appear to be valid."},
            object_unchanged=channel,
        )

        # unreachable API
        mock_get.side_effect = RequestException("Network is unreachable")
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "360Dialog channel", "is_enabled": True, "auth_token": "987654321"},
            form_errors={"__all__": "Credentials don't appear to be valid."},
            object_unchanged=channel,
        )

        mock_get.side_effect = None
        mock_get.return_value = MockResponse(200, '{"waba_templates": []}')
        self.assertUpdateSubmit(
            update_url, self.admin, {"name": "WhatsApp", "is_enabled": True, "auth_token": "987654321"}
        )

        self.assertEqual("https://waba-v2.360dialog.io/v1/configs/templates", mock_get.call_args[0][0])
        self.assertEqual({"D360-API-KEY": "987654321"}, mock_get.call_args[1]["headers"])

        channel.refresh_from_db()
        self.assertEqual("WhatsApp", channel.name)
        self.assertEqual("987654321", channel.config[Channel.CONFIG_AUTH_TOKEN])
        self.assertEqual("https://waba-v2.360dialog.io", channel.config[Channel.CONFIG_BASE_URL])
