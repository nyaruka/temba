from unittest.mock import patch

from django.urls import reverse

from temba.tests import MockResponse, TembaTest

from ...models import Channel


class BandwidthTypeTest(TembaTest):
    @patch("requests.post")
    def test_claim_voice(self, mock_post):
        mock_post.return_value = MockResponse(
            200,
            "<ApplicationProvisioningResponse><Application><ApplicationId>e5a9e103-application_id</ApplicationId></Application></ApplicationProvisioningResponse>",
        )

        Channel.objects.all().delete()

        url = reverse("channels.types.bandwidth.claim")

        self.login(self.admin)

        # check that claim page URL appears on claim list page
        response = self.client.get(reverse("channels.channel_claim"))
        self.assertContains(response, url)

        response = self.client.get(url)
        self.assertEqual(200, response.status_code)
        post_data = response.context["form"].initial

        post_data["country"] = "US"
        post_data["number"] = "250788123123"
        post_data["username"] = "user1"
        post_data["password"] = "pass1"
        post_data["account_id"] = "account-id"
        post_data["role"] = "CA"

        response = self.client.post(url, post_data)

        channel = Channel.objects.get()

        self.assertEqual("US", channel.country)
        self.assertEqual(post_data["username"], channel.config["username"])
        self.assertEqual(post_data["password"], channel.config["password"])
        self.assertEqual(post_data["account_id"], channel.config["account_id"])
        self.assertEqual("e5a9e103-application_id", channel.config["voice_application_id"])
        self.assertEqual("250788123123", channel.address)
        self.assertEqual("BW", channel.channel_type)
        self.assertEqual("CA", channel.role)

        read_url = reverse("channels.channel_read", args=[channel.uuid])

        self.assertRedirect(response, read_url)

        self.assertRedirect(response, read_url)

        self.assertEqual(
            mock_post.call_args_list[0][0][0], "https://dashboard.bandwidth.com/api/accounts/account-id/applications"
        )

        self.assertEqual(mock_post.call_args_list[0][1]["auth"][0], "user1")
        self.assertEqual(mock_post.call_args_list[0][1]["auth"][1], "pass1")
        self.assertEqual(
            mock_post.call_args_list[0][1]["data"],
            f"<Application><ServiceType>Voice-V2</ServiceType><AppName>app.rapidpro.io/{channel.uuid}/voice</AppName><CallInitiatedCallbackUrl>https://app.rapidpro.io/mr/ivr/c/{channel.uuid}/incoming</CallInitiatedCallbackUrl><CallStatusCallbackUrl>https://app.rapidpro.io/mr/ivr/c/{channel.uuid}/status</CallStatusCallbackUrl></Application>",
        )

        with patch("requests.delete") as mock_delete:
            mock_delete.side_effect = [MockResponse(200, "")]
            channel.release(self.admin, interrupt=False)

            self.assertEqual(
                mock_delete.call_args[0][0],
                "https://dashboard.bandwidth.com/api/accounts/account-id/applications/e5a9e103-application_id",
            )

    @patch("requests.post")
    def test_claim(self, mock_post):
        mock_post.return_value = MockResponse(
            200,
            "<ApplicationProvisioningResponse><Application><ApplicationId>e5a9e103-application_id</ApplicationId></Application></ApplicationProvisioningResponse>",
        )

        Channel.objects.all().delete()

        url = reverse("channels.types.bandwidth.claim")

        self.login(self.admin)

        # check that claim page URL appears on claim list page
        response = self.client.get(reverse("channels.channel_claim"))
        self.assertContains(response, url)

        response = self.client.get(url)
        self.assertEqual(200, response.status_code)
        post_data = response.context["form"].initial

        post_data["country"] = "US"
        post_data["number"] = "250788123123"
        post_data["username"] = "user1"
        post_data["password"] = "pass1"
        post_data["account_id"] = "account-id"
        post_data["role"] = "SR"

        response = self.client.post(url, post_data)

        channel = Channel.objects.get()

        self.assertEqual("US", channel.country)
        self.assertEqual(post_data["username"], channel.config["username"])
        self.assertEqual(post_data["password"], channel.config["password"])
        self.assertEqual(post_data["account_id"], channel.config["account_id"])
        self.assertEqual("e5a9e103-application_id", channel.config["messaging_application_id"])
        self.assertEqual(channel.config[Channel.CONFIG_CALLBACK_DOMAIN], self.org.get_brand_domain())
        self.assertEqual(channel.config[Channel.CONFIG_MAX_CONCURRENT_CALLS], 100)
        self.assertEqual("250788123123", channel.address)
        self.assertEqual("BW", channel.channel_type)
        self.assertEqual("SR", channel.role)

        read_url = reverse("channels.channel_read", args=[channel.uuid])

        self.assertRedirect(response, read_url)

        self.assertEqual(
            mock_post.call_args_list[0][0][0], "https://dashboard.bandwidth.com/api/accounts/account-id/applications"
        )

        self.assertEqual(mock_post.call_args_list[0][1]["auth"][0], "user1")
        self.assertEqual(mock_post.call_args_list[0][1]["auth"][1], "pass1")
        self.assertEqual(
            mock_post.call_args_list[0][1]["data"],
            f"<Application><ServiceType>Messaging-V2</ServiceType><AppName>app.rapidpro.io/{channel.uuid}/messaging</AppName><InboundCallbackUrl>https://app.rapidpro.io/c/bw/{channel.uuid}/receive</InboundCallbackUrl><OutboundCallbackUrl>https://app.rapidpro.io/c/bw/{channel.uuid}/status</OutboundCallbackUrl><RequestedCallbackTypes><CallbackType>message-delivered</CallbackType><CallbackType>message-failed</CallbackType><CallbackType>message-sending</CallbackType></RequestedCallbackTypes></Application>",
        )

        with patch("requests.delete") as mock_delete:
            mock_delete.side_effect = [MockResponse(200, "")]
            channel.release(self.admin, interrupt=False)

            self.assertEqual(
                mock_delete.call_args[0][0],
                "https://dashboard.bandwidth.com/api/accounts/account-id/applications/e5a9e103-application_id",
            )
