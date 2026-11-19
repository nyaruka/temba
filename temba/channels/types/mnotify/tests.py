from django.urls import reverse

from temba.tests import TembaTest

from ...models import Channel


class MNotifyTypeTest(TembaTest):
    def test_claim(self):
        Channel.objects.all().delete()

        url = reverse("channels.types.mnotify.claim")
        self.login(self.admin)

        self.org.timezone = "Africa/Kigali"  # not supported
        self.org.save()

        self.assertChannelTypeNotOffered(url)

        self.org.timezone = "Africa/Accra"
        self.org.save()

        self.assertChannelTypeOffered(url)

        response = self.client.get(url)
        self.assertEqual(200, response.status_code)
        post_data = response.context["form"].initial

        # both fields are required and the number has to be a phone number
        response = self.client.post(url, {"number": "12345"})
        self.assertFormError(response.context["form"], "number", "Not a valid phone number.")
        self.assertFormError(response.context["form"], "api_key", "This field is required.")
        self.assertEqual(0, Channel.objects.count())

        response = self.client.post(url, {"number": "abcd", "api_key": "key123"})
        self.assertFormError(response.context["form"], "number", "Not a valid phone number.")
        self.assertEqual(0, Channel.objects.count())

        # a number in local format is saved in international format
        post_data["number"] = "050 123 4567"
        post_data["api_key"] = "key123"

        response = self.client.post(url, post_data)

        channel = Channel.objects.get()

        self.assertEqual("MN", channel.channel_type)
        self.assertEqual("GH", channel.country)
        self.assertEqual("+233501234567", channel.address)
        self.assertEqual("mNotify: +233501234567", channel.name)
        self.assertEqual("CA", channel.role)
        self.assertEqual("key123", channel.config["api_key"])
        self.assertEqual(32, len(channel.config["secret"]))
        self.assertEqual(self.org.get_brand_domain(), channel.config[Channel.CONFIG_CALLBACK_DOMAIN])
        self.assertEqual(10, channel.config[Channel.CONFIG_MAX_CONCURRENT_CALLS])

        config_url = reverse("channels.channel_configuration", args=[channel.uuid])
        self.assertRedirect(response, config_url)

        # the callback URL to give to mNotify includes the secret
        response = self.client.get(config_url)
        self.assertEqual(200, response.status_code)
        self.assertContains(
            response,
            f"https://{channel.callback_domain}/mr/ivr/c/{channel.uuid}/callback?token={channel.config['secret']}",
        )
