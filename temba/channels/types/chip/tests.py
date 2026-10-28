from django.urls import reverse

from temba.channels.models import Channel
from temba.tests import CRUDLTestMixin, TembaTest

from .views import CONFIG_ALLOWED_DOMAINS, CONFIG_EMAIL_FROM, CONFIG_MAILGUN_API_KEY, CONFIG_MAILGUN_DOMAIN


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
            form_fields={
                "name": "WebChat",
                "is_enabled": True,
                "allowed_domains": "",
                "email_from": "",
                "mailgun_domain": "",
                "mailgun_region": "us",
                "mailgun_api_key": "",
            },
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
                "mailgun_region": "us",
            },
        )

        channel.refresh_from_db()
        self.assertEqual(["example.com", "www.example.com:8080"], channel.config.get(CONFIG_ALLOWED_DOMAINS))

        # saved domains are shown back one per line
        self.assertUpdateFetch(
            update_url,
            [self.admin],
            form_fields={
                "name": "WebChat",
                "is_enabled": True,
                "allowed_domains": "example.com\nwww.example.com:8080",
                "email_from": "",
                "mailgun_domain": "",
                "mailgun_region": "us",
                "mailgun_api_key": "",
            },
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
                {
                    "name": "WebChat",
                    "is_enabled": True,
                    "allowed_domains": f"example.com\n{invalid}",
                    "mailgun_region": "us",
                },
                form_errors={
                    "allowed_domains": f"{invalid.lower()} is not a valid domain. "
                    "Enter domains without schemes or paths, e.g. example.com."
                },
                object_unchanged=channel,
            )

        # clearing the field removes the restriction
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "WebChat", "is_enabled": True, "allowed_domains": "", "mailgun_region": "us"},
        )

        channel.refresh_from_db()
        self.assertEqual([], channel.config.get(CONFIG_ALLOWED_DOMAINS))

    def test_update_email(self):
        channel = self.create_channel("CHP", "WebChat", "123")
        update_url = reverse("channels.channel_update", args=[channel.id])
        config_url = reverse("channels.channel_configuration", args=[channel.uuid])

        def submit(**kwargs):
            return {"name": "WebChat", "is_enabled": True, "mailgun_region": "us"} | kwargs

        self.login(self.admin)
        response = self.client.get(config_url)
        self.assertContains(response, "Emails can't be sent to contacts until a Mailgun domain is set")

        # a domain needs a from address and an API key
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            submit(mailgun_domain="mg.example.com"),
            form_errors={"email_from": "Required to send emails.", "mailgun_api_key": "Required to send emails."},
            object_unchanged=channel,
        )

        # and must be a bare domain
        for invalid in ("https://mg.example.com", "mg.example.com/x", "mg.example.com:443"):
            self.assertUpdateSubmit(
                update_url,
                self.admin,
                submit(email_from="support@example.com", mailgun_domain=invalid, mailgun_api_key="key-1"),
                form_errors={"mailgun_domain": "Enter a domain without a scheme, path or port, e.g. mg.example.com."},
                object_unchanged=channel,
            )

        self.assertUpdateSubmit(
            update_url,
            self.admin,
            submit(
                email_from="support@example.com",
                mailgun_domain="MG.example.com",
                mailgun_region="eu",
                mailgun_api_key="key-1",
            ),
        )

        channel.refresh_from_db()
        self.assertEqual("support@example.com", channel.config[CONFIG_EMAIL_FROM])
        self.assertEqual("mg.example.com", channel.config[CONFIG_MAILGUN_DOMAIN])
        self.assertEqual("eu", channel.config["mailgun_region"])
        self.assertEqual("key-1", channel.config[CONFIG_MAILGUN_API_KEY])

        # the key isn't shown back
        self.assertUpdateFetch(
            update_url,
            [self.admin],
            form_fields={
                "name": "WebChat",
                "is_enabled": True,
                "allowed_domains": "",
                "email_from": "support@example.com",
                "mailgun_domain": "mg.example.com",
                "mailgun_region": "eu",
                "mailgun_api_key": "",
            },
        )
        response = self.client.get(update_url)
        self.assertNotContains(response, "key-1")

        response = self.client.get(config_url)
        self.assertContains(response, "mg.example.com")

        # leaving the key empty keeps the existing one
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            submit(email_from="help@example.com", mailgun_domain="mg.example.com", mailgun_region="eu"),
        )

        channel.refresh_from_db()
        self.assertEqual("help@example.com", channel.config[CONFIG_EMAIL_FROM])
        self.assertEqual("key-1", channel.config[CONFIG_MAILGUN_API_KEY])

        # but not when the domain or region changes, as the saved key is scoped to them
        for domain, region in (("mg2.example.com", "eu"), ("mg.example.com", "us")):
            self.assertUpdateSubmit(
                update_url,
                self.admin,
                submit(email_from="help@example.com", mailgun_domain=domain, mailgun_region=region),
                form_errors={"mailgun_api_key": "Required to send emails."},
                object_unchanged=channel,
            )

        self.assertUpdateSubmit(
            update_url,
            self.admin,
            submit(email_from="help@example.com", mailgun_domain="mg2.example.com", mailgun_api_key="key-2"),
        )

        channel.refresh_from_db()
        self.assertEqual("mg2.example.com", channel.config[CONFIG_MAILGUN_DOMAIN])
        self.assertEqual("us", channel.config["mailgun_region"])
        self.assertEqual("key-2", channel.config[CONFIG_MAILGUN_API_KEY])

        # clearing the domain stops emails and drops the from address and key
        self.assertUpdateSubmit(update_url, self.admin, submit(email_from="help@example.com"))

        channel.refresh_from_db()
        self.assertEqual("", channel.config[CONFIG_MAILGUN_DOMAIN])
        self.assertEqual("", channel.config[CONFIG_EMAIL_FROM])
        self.assertEqual("", channel.config[CONFIG_MAILGUN_API_KEY])
