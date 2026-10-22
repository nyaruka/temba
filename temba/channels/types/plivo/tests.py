from unittest.mock import patch

from requests import RequestException

from django.urls import reverse

from temba.channels.models import Channel
from temba.tests import MockJsonResponse, MockResponse, TembaTest

from .type import PlivoType


class PlivoTypeTest(TembaTest):
    def test_claim(self):
        self.login(self.admin)

        # remove any existing channels
        self.org.channels.update(is_active=False)

        connect_plivo_url = reverse("channels.types.plivo.connect")
        claim_plivo_url = reverse("channels.types.plivo.claim")

        # make sure plivo is on the claim page
        response = self.client.get(reverse("channels.channel_claim"))
        self.assertContains(response, "Plivo")
        self.assertContains(response, claim_plivo_url)

        with patch("requests.get") as plivo_get:
            plivo_get.return_value = MockJsonResponse(400, {})
            response = self.client.get(claim_plivo_url)

            self.assertEqual(response.status_code, 302)

            response = self.client.get(claim_plivo_url, follow=True)

            self.assertEqual(response.request["PATH_INFO"], connect_plivo_url)

        with patch("requests.get") as plivo_get:
            plivo_get.return_value = MockJsonResponse(400, {})

            # try hit the claim page, should be redirected; no credentials in session
            response = self.client.get(claim_plivo_url, follow=True)
            self.assertNotIn("account_trial", response.context)
            self.assertEqual(response.request["PATH_INFO"], connect_plivo_url)

        # let's add a number already connected to the account
        with patch("requests.get") as plivo_get:
            with patch("requests.post") as plivo_post:
                plivo_get.return_value = MockJsonResponse(
                    200,
                    dict(
                        objects=[
                            dict(number="16062681435", region="California, UNITED STATES"),
                            dict(number="8080", region="GUADALAJARA, MEXICO"),
                            dict(number="420601123456", region="PRAGUE, CZECH REPUBLIC"),
                            dict(number="88160000000", region="XANADU"),  # not a real country
                        ]
                    ),
                )
                plivo_post.return_value = MockJsonResponse(202, dict(status="changed", app_id="app-id"))

                # make sure our numbers appear on the claim page
                response = self.client.get(claim_plivo_url)
                self.assertContains(response, "+1 606-268-1435")
                self.assertContains(response, "8080")
                self.assertContains(response, "US")
                self.assertContains(response, "MX")

                # region names which aren't the ISO name for the country still match
                self.assertContains(response, "+420 601 123 456")
                self.assertContains(response, "CZ")

                # the number whose region doesn't match a country is ignored rather than erroring
                self.assertNotContains(response, "88160000000")
                self.assertNotIn("error", response.context)

                # claim it the US number
                session = self.client.session
                session[PlivoType.CONFIG_AUTH_ID] = "auth-id"
                session[PlivoType.CONFIG_AUTH_TOKEN] = "auth-token"
                session.save()

                self.assertTrue(PlivoType.CONFIG_AUTH_ID in self.client.session)
                self.assertTrue(PlivoType.CONFIG_AUTH_TOKEN in self.client.session)

                response = self.client.post(claim_plivo_url, dict(phone_number="+1 606-268-1435", country="US"))
                self.assertRedirects(response, reverse("public.public_welcome") + "?success")

                # make sure it is actually connected
                channel = Channel.objects.get(channel_type="PL", org=self.org)
                self.assertEqual(channel.role, Channel.ROLE_SEND + Channel.ROLE_RECEIVE)
                self.assertEqual(
                    channel.config,
                    {
                        PlivoType.CONFIG_AUTH_ID: "auth-id",
                        PlivoType.CONFIG_AUTH_TOKEN: "auth-token",
                        PlivoType.CONFIG_APP_ID: "app-id",
                        Channel.CONFIG_CALLBACK_DOMAIN: "app.rapidpro.io",
                    },
                )
                self.assertEqual(channel.address, "+16062681435")
                # no more credential in the session
                self.assertFalse(PlivoType.CONFIG_AUTH_ID in self.client.session)
                self.assertFalse(PlivoType.CONFIG_AUTH_TOKEN in self.client.session)

                response = self.client.get(reverse("channels.types.plivo.connect"))
                self.assertEqual(302, response.status_code)
                self.assertRedirects(response, reverse("channels.types.plivo.claim"))

                response = self.client.get(reverse("channels.types.plivo.connect") + "?reset_creds=reset")
                self.assertEqual(200, response.status_code)
                self.assertEqual(list(response.context["form"].fields.keys()), ["auth_id", "auth_token", "loc"])

        # delete existing channels
        Channel.objects.all().delete()

        with patch("temba.channels.views.requests.get") as mock_get:
            with patch("temba.channels.views.requests.post") as mock_post:
                response_body = {
                    "status": "fulfilled",
                    "message": "created",
                    "numbers": [{"status": "Success", "number": "27816855210"}],
                    "api_id": "4334c747-9e83-11e5-9147-22000acb8094",
                }

                mock_get.side_effect = [
                    MockJsonResponse(200, {}),  # get account
                    MockJsonResponse(400, {}),  # failed get number
                ]
                mock_post.side_effect = [
                    MockJsonResponse(201, {}),  # buy number
                    MockJsonResponse(200, {"app_id": "app-id"}),  # create application
                    MockJsonResponse(202, response_body),  # update number
                ]

                # claim it the US number
                session = self.client.session
                session[PlivoType.CONFIG_AUTH_ID] = "auth-id"
                session[PlivoType.CONFIG_AUTH_TOKEN] = "auth-token"
                session.save()

                self.assertTrue(PlivoType.CONFIG_AUTH_ID in self.client.session)
                self.assertTrue(PlivoType.CONFIG_AUTH_TOKEN in self.client.session)

                response = self.client.post(claim_plivo_url, dict(phone_number="+1 606-268-1440", country="US"))
                self.assertRedirects(response, reverse("public.public_welcome") + "?success")

                # make sure it is actually connected
                channel = Channel.objects.get(channel_type="PL", org=self.org)
                self.assertEqual(
                    channel.config,
                    {
                        PlivoType.CONFIG_AUTH_ID: "auth-id",
                        PlivoType.CONFIG_AUTH_TOKEN: "auth-token",
                        PlivoType.CONFIG_APP_ID: "app-id",
                        Channel.CONFIG_CALLBACK_DOMAIN: "app.rapidpro.io",
                    },
                )

                self.assertEqual(channel.address, "+16062681440")
                # no more credential in the session
                self.assertFalse(PlivoType.CONFIG_AUTH_ID in self.client.session)
                self.assertFalse(PlivoType.CONFIG_AUTH_TOKEN in self.client.session)

                self.assertEqual(mock_get.call_args_list[0][0][0], "https://api.plivo.com/v1/Account/auth-id/")
                self.assertEqual(
                    mock_get.call_args_list[1][0][0], "https://api.plivo.com/v1/Account/auth-id/Number/16062681440/"
                )

                self.assertEqual(
                    mock_post.call_args_list[0][0][0],
                    "https://api.plivo.com/v1/Account/auth-id/PhoneNumber/16062681440/",
                )
                self.assertEqual(
                    mock_post.call_args_list[1][0][0], "https://api.plivo.com/v1/Account/auth-id/Application/"
                )
                self.assertEqual(
                    mock_post.call_args_list[2][0][0], "https://api.plivo.com/v1/Account/auth-id/Number/16062681440/"
                )

        with patch("requests.delete") as mock_delete:
            channel.type.deactivate(channel)
            mock_delete.assert_called_once()

        # if activation fails after the application is created, the channel is released and the app deleted
        Channel.objects.all().delete()

        with (
            patch("temba.channels.views.requests.get") as mock_get,
            patch("temba.channels.views.requests.post") as mock_post,
            patch("requests.delete") as mock_delete,
        ):
            mock_get.side_effect = [
                MockJsonResponse(200, {}),  # get account
                MockJsonResponse(200, {}),  # get number
            ]
            mock_post.side_effect = [
                MockJsonResponse(200, {"app_id": "app-id"}),  # create application
                MockJsonResponse(400, {}),  # failed number link
            ]
            mock_delete.return_value = MockJsonResponse(204, {})

            session = self.client.session
            session[PlivoType.CONFIG_AUTH_ID] = "auth-id"
            session[PlivoType.CONFIG_AUTH_TOKEN] = "auth-token"
            session.save()

            response = self.client.post(claim_plivo_url, dict(phone_number="+1 606-268-1440", country="US"))
            self.assertContains(response, "There was a problem updating that number, please try again.")
            self.assertNotContains(response, "[&#x27;")  # message should not be wrapped in list repr
            self.assertFalse(Channel.objects.filter(is_active=True).exists())

            # the just-created application was deleted during release
            self.assertEqual(
                mock_delete.call_args_list[0][0][0], "https://api.plivo.com/v1/Account/auth-id/Application/app-id/"
            )

        # if creating the application fails, the channel is released and there's no app to clean up
        Channel.objects.all().delete()

        with (
            patch("temba.channels.views.requests.get") as mock_get,
            patch("temba.channels.views.requests.post") as mock_post,
            patch("requests.delete") as mock_delete,
        ):
            mock_get.side_effect = [
                MockJsonResponse(200, {}),  # get account
                MockJsonResponse(200, {}),  # get number
            ]
            mock_post.side_effect = [
                MockJsonResponse(400, {}),  # failed application creation
            ]

            session = self.client.session
            session[PlivoType.CONFIG_AUTH_ID] = "auth-id"
            session[PlivoType.CONFIG_AUTH_TOKEN] = "auth-token"
            session.save()

            response = self.client.post(claim_plivo_url, dict(phone_number="+1 606-268-1440", country="US"))
            self.assertContains(response, "Unable to create a Plivo application for that number, please try again.")
            self.assertFalse(Channel.objects.filter(is_active=True).exists())
            mock_delete.assert_not_called()

    @patch("requests.get")
    def test_search(self, mock_get):
        self.login(self.admin)

        search_url = reverse("channels.types.plivo.search")

        mock_get.return_value = MockJsonResponse(
            200, {"objects": [{"number": "16331111111"}, {"number": "16332222222"}]}
        )

        response = self.client.post(search_url, {"country": "US", "pattern": ""})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(["+1 633-111-1111", "+1 633-222-2222"], response.json())

        # missing key to throw exception
        mock_get.return_value = MockJsonResponse(200, {})
        response = self.client.post(search_url, {"country": "US", "pattern": ""})

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "error")

        mock_get.return_value = MockResponse(400, "Bad request")
        response = self.client.post(search_url, {"country": "US", "pattern": ""})

        self.assertContains(response, "Bad request")

    def test_connect_plivo(self):
        self.login(self.admin)

        # connect plivo
        connect_url = reverse("channels.types.plivo.connect")

        # simulate invalid credentials
        with patch("requests.get") as mock_get:
            mock_get.return_value = MockResponse(
                401, "Could not verify your access level for that URL.\nYou have to login with proper credentials"
            )
            response = self.client.post(connect_url, dict(auth_id="auth-id", auth_token="auth-token"))
            self.assertContains(
                response, "Your Plivo auth ID and auth token seem invalid. Please check them again and retry."
            )
            self.assertFalse(PlivoType.CONFIG_AUTH_ID in self.client.session)
            self.assertFalse(PlivoType.CONFIG_AUTH_TOKEN in self.client.session)

        # ok, now with a success
        with patch("requests.get") as mock_get:
            mock_get.return_value = MockJsonResponse(200, {})
            response = self.client.post(connect_url, dict(auth_id="auth-id", auth_token="auth-token"))

            # plivo should be added to the session
            self.assertEqual(self.client.session[PlivoType.CONFIG_AUTH_ID], "auth-id")
            self.assertEqual(self.client.session[PlivoType.CONFIG_AUTH_TOKEN], "auth-token")

            self.assertRedirect(response, reverse("channels.types.plivo.claim"))

    @patch("requests.get")
    def test_check_credentials(self, mock_get):
        config = {"PLIVO_AUTH_ID": "auth-id", "PLIVO_AUTH_TOKEN": "auth-token"}
        mock_get.side_effect = [
            MockResponse(200, "{}"),
            MockResponse(401, "{}"),
            RequestException("Network is unreachable"),
        ]

        self.assertTrue(PlivoType().check_credentials(config))
        self.assertFalse(PlivoType().check_credentials(config))
        self.assertFalse(PlivoType().check_credentials(config))

        self.assertEqual("https://api.plivo.com/v1/Account/auth-id/", mock_get.call_args[0][0])
