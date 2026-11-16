from django.test import override_settings
from django.urls import reverse

from temba.tests import TembaTest

from ...models import Channel


class DartMediaTypeTest(TembaTest):
    @override_settings(IP_ADDRESSES=("10.10.10.10", "172.16.20.30"))
    def test_claim(self):
        Channel.objects.all().delete()

        url = reverse("channels.types.dartmedia.claim")

        self.login(self.admin)

        self.assertChannelTypeNotOffered(url)

        self.org.timezone = "Asia/Jakarta"
        self.org.save()

        # the new channel picker offers it
        self.assertChannelTypeOffered(url)

        # try to claim a channel
        response = self.client.get(url)
        self.assertEqual(response.context["view"].get_country({}), "Indonesia")

        post_data = response.context["form"].initial

        post_data["username"] = "uname"
        post_data["password"] = "pword"
        post_data["number"] = "5151"
        post_data["country"] = "ID"

        response = self.client.post(url, post_data)

        channel = Channel.objects.get()

        self.assertEqual("ID", channel.country)
        self.assertTrue(channel.uuid)
        self.assertEqual(post_data["number"], channel.address)
        self.assertEqual(post_data["username"], channel.config["username"])
        self.assertEqual(post_data["password"], channel.config["password"])
        self.assertEqual("DA", channel.channel_type)
        self.assertEqual(["tel", "ext"], channel.schemes)

        config_url = reverse("channels.channel_configuration", args=[channel.uuid])
        self.assertRedirect(response, config_url)

        response = self.client.get(config_url)
        self.assertEqual(200, response.status_code)

        self.assertContains(response, f"/c/da/{channel.uuid}/receive")
        self.assertContains(response, f"/c/da/{channel.uuid}/delivered")

        # check we show the IP to whitelist
        self.assertContains(response, "10.10.10.10")
        self.assertContains(response, "172.16.20.30")
