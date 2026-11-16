from unittest.mock import patch

from django.urls import reverse

from temba.tests import CRUDLTestMixin, MockResponse, TembaTest

from ..models import Channel


class FacebookWhitelistTest(TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        self.channel.delete()
        self.channel = Channel.create(
            self.org,
            self.admin,
            None,
            "FB",
            "Facebook",
            "1234",
            config={Channel.CONFIG_AUTH_TOKEN: "auth"},
            uuid="00000000-0000-0000-0000-000000001234",
        )

    def test_whitelist(self):
        read_url = reverse("channels.channel_read", args=[self.channel.uuid])
        whitelist_url = reverse("channels.channel_facebook_whitelist", args=[self.channel.uuid])

        response = self.client.get(whitelist_url)
        self.assertLoginRedirect(response)

        self.login(self.admin)
        response = self.client.get(read_url)
        self.assertContains(response, self.channel.name)
        self.assertContentMenu(read_url, self.admin, ["Whitelist Domain", "Edit"])

        with patch("requests.post") as mock:
            mock.return_value = MockResponse(400, '{"error": { "message": "FB Error" } }')
            response = self.client.post(whitelist_url, dict(whitelisted_domain="https://foo.bar"))
            self.assertFormError(response.context["form"], None, "FB Error")

        with patch("requests.post") as mock:
            mock.return_value = MockResponse(200, '{ "ok": "true" }')
            response = self.client.post(whitelist_url, dict(whitelisted_domain="https://foo.bar"))

            mock.assert_called_once_with(
                "https://graph.facebook.com/v3.3/me/thread_settings?access_token=auth",
                json=dict(
                    setting_type="domain_whitelisting",
                    whitelisted_domains=["https://foo.bar"],
                    domain_action_type="add",
                ),
            )

            self.assertNoFormErrors(response)
