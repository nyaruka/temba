from django.urls import reverse

from temba.tests import TembaTest

from ...models import Channel


class GlobeTypeTest(TembaTest):
    def test_claim(self):
        # disassociate all of our channels
        self.org.channels.all().update(is_active=False)

        self.login(self.admin)
        claim_url = reverse("channels.types.globe.claim")

        self.assertChannelTypeNotOffered(claim_url)

        self.org.timezone = "Asia/Manila"
        self.org.save()

        # the new channel picker offers it
        self.assertChannelTypeOffered(claim_url)

        response = self.client.get(claim_url)
        self.assertEqual(200, response.status_code)

        response = self.client.post(
            claim_url,
            dict(number=21586380, app_id="AppId", app_secret="AppSecret", passphrase="Passphrase"),
            follow=True,
        )
        self.assertEqual(200, response.status_code)

        channel = Channel.objects.get(channel_type="GL")
        self.assertEqual("21586380", channel.address)
        self.assertEqual("PH", channel.country)
        config = channel.config
        self.assertEqual(config["app_secret"], "AppSecret")
        self.assertEqual(config["app_id"], "AppId")
        self.assertEqual(config["passphrase"], "Passphrase")
