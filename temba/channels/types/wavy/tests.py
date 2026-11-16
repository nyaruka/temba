from django.urls import reverse

from temba.tests import TembaTest

from ...models import Channel


class WavyTypeTest(TembaTest):
    def test_claim(self):
        Channel.objects.all().delete()

        url = reverse("channels.types.wavy.claim")

        self.login(self.admin)

        self.assertChannelTypeNotOffered(url)

        self.org.timezone = "America/Sao_Paulo"
        self.org.save()

        # the new channel picker offers it
        self.assertChannelTypeOffered(url)

        response = self.client.get(url)
        self.assertEqual(200, response.status_code)
        self.assertEqual(response.context["view"].get_country({}), "Brazil")

        post_data = response.context["form"].initial

        post_data["country"] = "BR"
        post_data["number"] = "5259"
        post_data["username"] = "wavy"
        post_data["token"] = "api-token"

        response = self.client.post(url, post_data)

        channel = Channel.objects.get()

        self.assertEqual("wavy", channel.config[Channel.CONFIG_USERNAME])
        self.assertEqual("api-token", channel.config[Channel.CONFIG_AUTH_TOKEN])
        self.assertEqual("5259", channel.address)
        self.assertEqual("BR", channel.country)
        self.assertEqual("WV", channel.channel_type)

        config_url = reverse("channels.channel_configuration", args=[channel.uuid])
        self.assertRedirect(response, config_url)

        response = self.client.get(config_url)
        self.assertEqual(200, response.status_code)

        self.assertContains(response, f"/c/wv/{channel.uuid}/receive")
        self.assertContains(response, f"/c/wv/{channel.uuid}/sent")
        self.assertContains(response, f"/c/wv/{channel.uuid}/delivered")
