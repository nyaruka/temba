from django.urls import reverse

from temba.tests import TembaTest

from ...models import Channel


class InfobipTypeTest(TembaTest):
    def test_claim(self):
        Channel.objects.all().delete()

        url = reverse("channels.types.infobip.claim")

        self.login(self.admin)

        # check that claim page URL appears on claim list page
        response = self.client.get(reverse("channels.channel_claim"))
        self.assertContains(response, url)

        # try to claim a channel
        response = self.client.get(url)
        post_data = response.context["form"].initial

        post_data["country"] = "NI"
        post_data["number"] = "250788123123"
        post_data["api_key"] = "12345"

        # reject anything that isn't a plain subdomain label
        post_data["subdomain"] = "https://xxxxx.api.infobip.com"
        response = self.client.post(url, post_data)
        self.assertFormError(response.context["form"], "subdomain", "Enter a valid subdomain.")

        post_data["subdomain"] = "abcde"
        response = self.client.post(url, post_data)

        channel = Channel.objects.get()

        self.assertEqual("NI", channel.country)
        self.assertEqual(post_data["api_key"], channel.config["api_key"])
        self.assertEqual("https://abcde.api.infobip.com", channel.config["base_url"])
        self.assertEqual("+250788123123", channel.address)
        self.assertEqual("IB", channel.channel_type)

        config_url = reverse("channels.channel_configuration", args=[channel.uuid])
        self.assertRedirect(response, config_url)

        response = self.client.get(config_url)
        self.assertEqual(200, response.status_code)

        self.assertContains(response, reverse("courier.ib", args=[channel.uuid, "receive"]))
        self.assertContains(response, reverse("courier.ib", args=[channel.uuid, "delivered"]))

        Channel.objects.all().delete()

        response = self.client.get(url)
        post_data = response.context["form"].initial

        post_data["country"] = "NI"
        post_data["number"] = "20050"
        post_data["api_key"] = "12345"
        post_data["subdomain"] = "abcde"

        response = self.client.post(url, post_data)

        channel = Channel.objects.get()

        self.assertEqual("NI", channel.country)
        self.assertEqual(post_data["api_key"], channel.config["api_key"])
        self.assertEqual("https://abcde.api.infobip.com", channel.config["base_url"])
        self.assertEqual("20050", channel.address)
        self.assertEqual("IB", channel.channel_type)
