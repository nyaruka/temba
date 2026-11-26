import json
from unittest.mock import patch

from requests import RequestException

from django.urls import reverse

from temba.channels.types.turn.tasks import refresh_turn_whatsapp_tokens
from temba.channels.types.turn.type import (
    CONFIG_FB_ACCESS_TOKEN,
    CONFIG_FB_BUSINESS_ID,
    CONFIG_FB_NAMESPACE,
    CONFIG_FB_TEMPLATE_LIST_DOMAIN,
    CONFIG_WEBHOOK_URL,
)
from temba.request_logs.models import HTTPLog
from temba.templates.models import TemplateTranslation
from temba.tests import CRUDLTestMixin, MockResponse, TembaTest

from ...models import Channel


class TurnTypeTest(CRUDLTestMixin, TembaTest):
    def test_claim(self):
        Channel.objects.all().delete()

        url = reverse("channels.types.turn.claim")
        self.login(self.admin)

        self.assertChannelTypeOffered(url)

        response = self.client.get(url)
        self.assertEqual(200, response.status_code)
        post_data = response.context["form"].initial

        post_data["address"] = "1234"
        post_data["api_token"] = "abc123"
        post_data["country"] = "RW"
        post_data["base_url"] = "https://whatsapp.turn.io"
        post_data["namespace"] = "my-custom-app"
        post_data["access_token"] = "token123"

        # missing fields only get their own errors
        response = self.client.post(url, {**post_data, "access_token": ""})
        self.assertFormError(response.context["form"], "access_token", ["This field is required."])

        # will fail with invalid phone number
        response = self.client.post(url, post_data)
        self.assertFormError(response.context["form"], "address", ["Please enter a valid phone number"])

        # valid number
        post_data["address"] = "0788123123"

        with (
            patch("socket.gethostbyname", return_value="123.123.123.123"),
            patch("requests.post") as mock_post,
            patch("requests.get") as mock_get,
        ):
            # the token is rejected
            mock_get.return_value = MockResponse(401, '{"errors": ["invalid"]}')
            response = self.client.post(url, post_data)

            self.assertEqual(200, response.status_code)
            self.assertFalse(Channel.objects.all())
            self.assertFormError(response.context["form"], "api_token", ["Unable to access Turn.io with this token."])

            self.assertEqual(1, mock_get.call_count)
            self.assertEqual("https://whatsapp.turn.io/v1/settings/application", mock_get.call_args[0][0])
            self.assertEqual({"Authorization": "Bearer abc123"}, mock_get.call_args[1]["headers"])

            # the token is accepted but the templates can't be listed
            mock_get.side_effect = [MockResponse(200, '{"settings": {}}'), MockResponse(400, '{"data": []}')]
            response = self.client.post(url, post_data)

            self.assertEqual(200, response.status_code)
            self.assertFalse(Channel.objects.all())

            self.assertFormError(response.context["form"], None, ["Unable to access Messages templates from turn.io"])

        # registering the webhooks fails
        with (
            patch("socket.gethostbyname", return_value="123.123.123.123"),
            patch("requests.post") as mock_post,
            patch("requests.get") as mock_get,
            patch("requests.patch") as mock_patch,
            patch("requests.delete") as mock_delete,
        ):
            mock_get.return_value = MockResponse(200, '{"data": []}')
            mock_patch.return_value = MockResponse(400, '{"errors": ["invalid"]}')
            mock_delete.return_value = MockResponse(200, "{}")

            response = self.client.post(url, post_data)

            self.assertEqual(200, response.status_code)

            # we tried to register the webhooks, but because that failed we don't try to clear them as the channel is
            # released - the user may have a webhook of their own configured
            self.assertEqual(1, mock_patch.call_count)
            self.assertEqual(0, mock_delete.call_count)

            self.assertFormError(
                response.context["form"], None, ['Unable to register webhooks: {"errors": ["invalid"]}']
            )
            self.assertContains(response, "Unable to register webhooks")
            self.assertFalse(Channel.objects.filter(is_active=True))

        with (
            patch("socket.gethostbyname", return_value="123.123.123.123"),
            patch("requests.post") as mock_post,
            patch("requests.get") as mock_get,
            patch("requests.patch") as mock_patch,
        ):
            mock_get.return_value = MockResponse(200, '{"data": []}')
            mock_patch.return_value = MockResponse(200, '{"webhooks": []}')

            response = self.client.post(url, post_data)
            self.assertEqual(302, response.status_code)

        channel = Channel.objects.get(is_active=True)
        self.assertRedirects(response, reverse("channels.channel_list"))
        self.assertEqual(channel.channel_type, "TRN")

        # check the webhooks were registered with the courier receive URL for this channel
        self.assertEqual("https://whatsapp.turn.io/v1/settings/application", mock_patch.call_args_list[0][0][0])
        self.assertEqual(
            {"webhooks": {"url": f"https://app.rapidpro.io/c/trn/{channel.uuid}/receive"}},
            mock_patch.call_args_list[0][1]["json"],
        )
        self.assertEqual(
            {"Authorization": "Bearer abc123", "Content-Type": "application/json"},
            mock_patch.call_args_list[0][1]["headers"],
        )

        # the token is used as given, without generating one from login credentials which aren't asked for or kept
        mock_post.assert_not_called()
        self.assertEqual("abc123", channel.config[Channel.CONFIG_AUTH_TOKEN])
        self.assertNotIn(Channel.CONFIG_USERNAME, channel.config)
        self.assertNotIn(Channel.CONFIG_PASSWORD, channel.config)
        self.assertEqual("https://whatsapp.turn.io", channel.config[Channel.CONFIG_BASE_URL])

        # the registered webhook is recorded so that we know to clear it when the channel is released
        self.assertEqual(f"https://app.rapidpro.io/c/trn/{channel.uuid}/receive", channel.config[CONFIG_WEBHOOK_URL])

        self.assertEqual("+250788123123", channel.address)
        self.assertEqual("RW", channel.country)
        self.assertEqual("TRN", channel.channel_type)
        self.assertEqual(45, channel.tps)
        self.assertEqual("TRN", channel.type.code)
        self.assertEqual("whatsapp", channel.type.template_type)

        # no configuration page for this type as webhooks are registered automatically
        response = self.client.get(reverse("channels.channel_configuration", args=[channel.uuid]))
        self.assertRedirects(response, reverse("channels.channel_read", args=[channel.uuid]))

    @patch("requests.get")
    def test_update(self, mock_get):
        channel = self.create_channel(
            "TRN",
            "Turn: 1234",
            "+250788123123",
            country="RW",
            config={
                Channel.CONFIG_BASE_URL: "https://whatsapp.turn.io",
                Channel.CONFIG_USERNAME: "temba",
                Channel.CONFIG_PASSWORD: "tembapasswd",
                Channel.CONFIG_AUTH_TOKEN: "authtoken123",
                CONFIG_FB_ACCESS_TOKEN: "token123",
            },
        )
        update_url = reverse("channels.channel_update", args=[channel.id])

        self.assertRequestDisallowed(update_url, [None, self.agent, self.editor, self.admin2])
        self.assertUpdateFetch(
            update_url,
            [self.admin],
            form_fields={"name": "Turn: 1234", "is_enabled": True, "auth_token": ""},
        )

        # a log of a token being generated for the channel from its login credentials
        HTTPLog.objects.create(
            org=self.org,
            channel=channel,
            log_type=HTTPLog.WHATSAPP_TOKENS_SYNCED,
            url="https://whatsapp.turn.io/v1/users/login",
            request="POST /v1/users/login",
            response='{"users": [{"token": "authtoken123"}]}',
            status_code=200,
            is_error=False,
            request_time=10,
        )

        # rejected token
        mock_get.return_value = MockResponse(401, '{"errors": ["invalid"]}')
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "Turn: 1234", "is_enabled": True, "auth_token": "invalid"},
            form_errors={"__all__": "Credentials don't appear to be valid."},
            object_unchanged=channel,
        )

        # unreachable API
        mock_get.side_effect = RequestException("Network is unreachable")
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "Turn: 1234", "is_enabled": True, "auth_token": "newtoken456"},
            form_errors={"__all__": "Credentials don't appear to be valid."},
            object_unchanged=channel,
        )

        # a token that can't be confirmed as valid isn't saved, and the login credentials it would replace are kept
        channel.refresh_from_db()
        self.assertEqual("authtoken123", channel.config[Channel.CONFIG_AUTH_TOKEN])
        self.assertEqual("temba", channel.config[Channel.CONFIG_USERNAME])
        self.assertEqual("tembapasswd", channel.config[Channel.CONFIG_PASSWORD])

        # without a new token nothing is checked, and the current token and login credentials are kept
        mock_get.reset_mock(side_effect=True)
        self.assertUpdateSubmit(update_url, self.admin, {"name": "WhatsApp", "is_enabled": True, "auth_token": ""})
        mock_get.assert_not_called()
        self.assertEqual(1, channel.http_logs.count())

        channel.refresh_from_db()
        self.assertEqual("WhatsApp", channel.name)
        self.assertEqual("authtoken123", channel.config[Channel.CONFIG_AUTH_TOKEN])
        self.assertEqual("temba", channel.config[Channel.CONFIG_USERNAME])
        self.assertEqual("tembapasswd", channel.config[Channel.CONFIG_PASSWORD])

        # a new token replaces the login credentials, so that it isn't itself replaced by the next refresh
        mock_get.return_value = MockResponse(200, '{"settings": {}}')
        self.assertUpdateSubmit(
            update_url, self.admin, {"name": "WhatsApp", "is_enabled": True, "auth_token": "newtoken456"}
        )

        self.assertEqual("https://whatsapp.turn.io/v1/settings/application", mock_get.call_args[0][0])
        self.assertEqual({"Authorization": "Bearer newtoken456"}, mock_get.call_args[1]["headers"])

        channel.refresh_from_db()
        self.assertEqual("newtoken456", channel.config[Channel.CONFIG_AUTH_TOKEN])
        self.assertNotIn(Channel.CONFIG_USERNAME, channel.config)
        self.assertNotIn(Channel.CONFIG_PASSWORD, channel.config)
        self.assertEqual("token123", channel.config[CONFIG_FB_ACCESS_TOKEN])

        # the logs holding tokens generated from those credentials are gone, as only the current token is redacted
        self.assertEqual(0, channel.http_logs.count())

        # the new token isn't shown on the form either
        self.assertUpdateFetch(
            update_url, [self.admin], form_fields={"name": "WhatsApp", "is_enabled": True, "auth_token": ""}
        )
        self.assertEqual(("newtoken456", "token123"), channel.type.get_redact_values(channel))

        with patch("requests.post") as mock_post:
            refresh_turn_whatsapp_tokens()

        mock_post.assert_not_called()

    def test_release(self):
        def create_turn_channel(address, webhook_url="https://app.rapidpro.io/c/trn/1234/receive"):
            config = {
                Channel.CONFIG_BASE_URL: "https://whatsapp.turn.io",
                Channel.CONFIG_USERNAME: "temba",
                Channel.CONFIG_PASSWORD: "tembapasswd",
                Channel.CONFIG_AUTH_TOKEN: "authtoken123",
            }
            if webhook_url:
                config[CONFIG_WEBHOOK_URL] = webhook_url

            return self.create_channel("TRN", "Turn: %s" % address, address, config=config)

        channel = create_turn_channel("1234")

        # releasing the channel clears the webhooks by resetting the application settings
        with patch("requests.delete") as mock_delete:
            mock_delete.return_value = MockResponse(200, "{}")

            channel.release(self.admin, interrupt=False)

        mock_delete.assert_called_once_with(
            "https://whatsapp.turn.io/v1/settings/application",
            headers={"Authorization": "Bearer authtoken123", "Content-Type": "application/json"},
        )

        channel.refresh_from_db()
        self.assertFalse(channel.is_active)

        # a failure to clear the webhooks doesn't prevent the channel being released
        channel = create_turn_channel("1235")

        with patch("requests.delete") as mock_delete:
            mock_delete.return_value = MockResponse(400, '{"errors": ["invalid"]}')

            channel.release(self.admin, interrupt=False)

        self.assertEqual(1, mock_delete.call_count)

        channel.refresh_from_db()
        self.assertFalse(channel.is_active)

        # a channel we never registered a webhook for is released without touching the turn.io settings
        channel = create_turn_channel("1236", webhook_url=None)

        with patch("requests.delete") as mock_delete:
            channel.release(self.admin, interrupt=False)

        self.assertEqual(0, mock_delete.call_count)

        channel.refresh_from_db()
        self.assertFalse(channel.is_active)

    def test_refresh_tokens(self):
        TemplateTranslation.objects.all().delete()
        Channel.objects.all().delete()

        channel = self.create_channel(
            "TRN",
            "Turn: 1234",
            "1234",
            config={
                Channel.CONFIG_BASE_URL: "https://whatsapp.turn.io",
                Channel.CONFIG_USERNAME: "temba",
                Channel.CONFIG_PASSWORD: "tembapasswd",
                Channel.CONFIG_AUTH_TOKEN: "authtoken123",
                CONFIG_FB_BUSINESS_ID: "1234",
                CONFIG_FB_ACCESS_TOKEN: "token123",
                CONFIG_FB_NAMESPACE: "my-custom-app",
                CONFIG_FB_TEMPLATE_LIST_DOMAIN: "whatsapp.turn.io",
            },
        )

        channel2 = self.create_channel(
            "TRN",
            "Turn: 1235",
            "1235",
            config={
                Channel.CONFIG_BASE_URL: "https://whatsapp.turn.io",
                Channel.CONFIG_USERNAME: "temba",
                Channel.CONFIG_PASSWORD: "tembapasswd",
                Channel.CONFIG_AUTH_TOKEN: "authtoken123",
                CONFIG_FB_BUSINESS_ID: "1234",
                CONFIG_FB_ACCESS_TOKEN: "token123",
                CONFIG_FB_NAMESPACE: "my-custom-app",
                CONFIG_FB_TEMPLATE_LIST_DOMAIN: "whatsapp.turn.io",
            },
        )

        # a channel using an API token rather than login credentials
        channel3 = self.create_channel(
            "TRN",
            "Turn: 1236",
            "1236",
            config={
                Channel.CONFIG_BASE_URL: "https://whatsapp.turn.io",
                Channel.CONFIG_AUTH_TOKEN: "apitoken123",
                CONFIG_FB_BUSINESS_ID: "1236",
                CONFIG_FB_ACCESS_TOKEN: "token123",
                CONFIG_FB_NAMESPACE: "my-custom-app",
                CONFIG_FB_TEMPLATE_LIST_DOMAIN: "whatsapp.turn.io",
            },
        )

        # and fetching new tokens
        with patch("requests.post") as mock_post:
            mock_post.return_value = MockResponse(
                200,
                '{"users": [{"token": "abc345"}]}',
                headers={
                    "Authorization": "Basic dGVtYmE6dGVtYmFwYXNzd2Q=",
                    "WA-user": "temba",
                    "WA-pass": "tembapasswd",
                },
            )
            self.assertFalse(channel.http_logs.filter(log_type=HTTPLog.WHATSAPP_TOKENS_SYNCED, is_error=False))
            refresh_turn_whatsapp_tokens()
            self.assertTrue(channel.http_logs.filter(log_type=HTTPLog.WHATSAPP_TOKENS_SYNCED, is_error=False))
            channel.refresh_from_db()
            self.assertEqual("abc345", channel.config[Channel.CONFIG_AUTH_TOKEN])

            # only channels with login credentials have new tokens generated
            self.assertEqual(2, mock_post.call_count)
            channel3.refresh_from_db()
            self.assertEqual("apitoken123", channel3.config[Channel.CONFIG_AUTH_TOKEN])
            self.assertFalse(channel3.http_logs.all())

            # check channel username, password, basic auth and the new token are redacted in HTTP logs
            for log in channel.http_logs.all():
                self.assertIn("temba", json.dumps(log.get_display()))
                self.assertNotIn("abc345", json.dumps(log.get_display()))
                self.assertNotIn("tembapasswd", json.dumps(log.get_display()))
                self.assertNotIn("dGVtYmE6dGVtYmFwYXNzd2Q=", json.dumps(log.get_display()))

        with patch("requests.post") as mock_post:
            mock_post.side_effect = [
                MockResponse(
                    400,
                    '{ "error": true }',
                    headers={
                        "Authorization": "Basic dGVtYmE6dGVtYmFwYXNzd2Q=",
                        "WA-user": "temba",
                        "WA-pass": "tembapasswd",
                    },
                )
            ]
            self.assertFalse(channel.http_logs.filter(log_type=HTTPLog.WHATSAPP_TOKENS_SYNCED, is_error=True))
            refresh_turn_whatsapp_tokens()
            self.assertTrue(channel.http_logs.filter(log_type=HTTPLog.WHATSAPP_TOKENS_SYNCED, is_error=True))
            channel.refresh_from_db()
            self.assertEqual("abc345", channel.config[Channel.CONFIG_AUTH_TOKEN])
            # check channel username, password, basic auth are redacted in HTTP logs
            for log in channel.http_logs.all():
                self.assertIn("temba", json.dumps(log.get_display()))
                self.assertNotIn("tembapasswd", json.dumps(log.get_display()))
                self.assertNotIn("dGVtYmE6dGVtYmFwYXNzd2Q=", json.dumps(log.get_display()))

        with patch("requests.post") as mock_post:
            mock_post.side_effect = [
                MockResponse(
                    200,
                    "",
                    headers={
                        "Authorization": "Basic dGVtYmE6dGVtYmFwYXNzd2Q=",
                        "WA-user": "temba",
                        "WA-pass": "tembapasswd",
                    },
                ),
                MockResponse(
                    200,
                    '{"users": [{"token": "abc098"}]}',
                    headers={
                        "Authorization": "Basic dGVtYmE6dGVtYmFwYXNzd2Q=",
                        "WA-user": "temba",
                        "WA-pass": "tembapasswd",
                    },
                ),
            ]
            refresh_turn_whatsapp_tokens()

            channel.refresh_from_db()
            channel2.refresh_from_db()
            self.assertEqual("abc345", channel.config[Channel.CONFIG_AUTH_TOKEN])
            self.assertEqual("abc098", channel2.config[Channel.CONFIG_AUTH_TOKEN])
            # check channel username, password, basic auth are redacted in HTTP logs
            for log in channel.http_logs.all():
                self.assertIn("temba", json.dumps(log.get_display()))
                self.assertNotIn("tembapasswd", json.dumps(log.get_display()))
                self.assertNotIn("dGVtYmE6dGVtYmFwYXNzd2Q=", json.dumps(log.get_display()))
            for log in channel2.http_logs.all():
                self.assertIn("temba", json.dumps(log.get_display()))
                self.assertNotIn("tembapasswd", json.dumps(log.get_display()))
                self.assertNotIn("dGVtYmE6dGVtYmFwYXNzd2Q=", json.dumps(log.get_display()))
