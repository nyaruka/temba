from django.urls import reverse

from temba.channels.models import Channel
from temba.tests import CRUDLTestMixin, TembaTest

from .views import CONFIG_ALLOWED_DOMAINS


class ChipTypeTest(CRUDLTestMixin, TembaTest):
    def test_claim(self):
        claim_url = reverse("channels.types.chip.claim")

        # not available to regular users
        self.login(self.admin)

        response = self.client.get(reverse("channels.channel_claim_all"))
        self.assertNotContains(response, claim_url)

        # and can't be claimed by them directly either
        response = self.client.post(claim_url, {})
        self.assertEqual(404, response.status_code)

        # but is available to staff
        self.login(self.customer_support, choose_org=self.org)

        response = self.client.get(reverse("channels.channel_claim_all"))
        self.assertContains(response, claim_url)

        response = self.client.post(claim_url, {})
        self.assertEqual(302, response.status_code)

        channel = Channel.objects.get(channel_type="CHP")
        self.assertEqual("WebChat", channel.name)
        self.assertIsNone(channel.address)
        self.assertEqual(["webchat"], channel.schemes)
        self.assertEqual({}, channel.config)
        self.assertEqual(reverse("channels.channel_configuration", args=[channel.uuid]), response.url)

        # config page shows the channel UUID that the embedded widget connects with, and an embed snippet pointing
        # the widget at the host the page was served from
        response = self.client.get(reverse("channels.channel_configuration", args=[channel.uuid]))
        self.assertContains(response, str(channel.uuid))
        self.assertContains(response, f'&lt;temba-webchat channel="{channel.uuid}" host="https://testserver"&gt;')

        # and explains that without allowed domains, any website can embed the widget
        self.assertContains(response, "any website can embed")

    def test_update(self):
        channel = self.create_channel("CHP", "WebChat", "123")
        update_url = reverse("channels.channel_update", args=[channel.id])
        config_url = reverse("channels.channel_configuration", args=[channel.uuid])

        self.assertRequestDisallowed(update_url, [None, self.agent, self.editor, self.admin2])
        self.assertUpdateFetch(
            update_url,
            [self.admin],
            form_fields={"name": "WebChat", "is_enabled": True, "allowed_domains": ""},
        )

        # domains can be one per line or comma separated, and are normalized to lowercase host[:port] entries with
        # blanks and duplicates dropped
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "name": "WebChat",
                "is_enabled": True,
                "allowed_domains": "Example.com\n www.example.com:8080, example.com,\n",
            },
        )

        channel.refresh_from_db()
        self.assertEqual(["example.com", "www.example.com:8080"], channel.config.get(CONFIG_ALLOWED_DOMAINS))

        # saved domains are shown back one per line
        self.assertUpdateFetch(
            update_url,
            [self.admin],
            form_fields={"name": "WebChat", "is_enabled": True, "allowed_domains": "example.com\nwww.example.com:8080"},
        )

        # and on the configuration page
        self.login(self.admin)
        response = self.client.get(config_url)
        self.assertContains(response, "example.com, www.example.com:8080")

        # entries with schemes, paths, other invalid characters or out-of-range ports are rejected
        for invalid in (
            "https://example.com",
            "example.com/chat",
            "example com",
            "example.com:port",
            "-example.com",
            "example.com:0",
            "example.com:99999",
        ):
            self.assertUpdateSubmit(
                update_url,
                self.admin,
                {"name": "WebChat", "is_enabled": True, "allowed_domains": f"example.com\n{invalid}"},
                form_errors={
                    "allowed_domains": f"{invalid.lower()} is not a valid domain. "
                    "Enter domains without schemes or paths, e.g. example.com."
                },
                object_unchanged=channel,
            )

        # clearing the field removes the restriction
        self.assertUpdateSubmit(update_url, self.admin, {"name": "WebChat", "is_enabled": True, "allowed_domains": ""})

        channel.refresh_from_db()
        self.assertEqual([], channel.config.get(CONFIG_ALLOWED_DOMAINS))
