from unittest.mock import patch

from django.conf import settings
from django.test.utils import override_settings
from django.urls import reverse

from temba.tests import CRUDLTestMixin, MockResponse, TembaTest
from temba.utils.views.mixins import TEMBA_MENU_SELECTION

from ..models import Channel, ChannelLog
from ..types.external.type import ExternalType
from ..views import get_channel_help_links


class ChannelCRUDLTest(TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        self.ex_channel = Channel.create(
            self.org,
            self.admin,
            "RW",
            "EX",
            name="External Channel",
            address="+250785551313",
            role="SR",
            schemes=("tel",),
            config={"send_url": "http://send.com"},
        )
        self.other_org_channel = Channel.create(
            self.org2,
            self.admin2,
            "RW",
            "EX",
            name="Other Channel",
            address="+250785551414",
            role="SR",
            secret="45473",
            schemes=("tel",),
            config={"send_url": "http://send.com"},
        )

    def test_list(self):
        list_url = reverse("channels.channel_list")
        self.assertRequestDisallowed(list_url, [None, self.agent])

        # editors can see the list but can't add channels
        response = self.assertListFetch(list_url, [self.editor], context_objects=[])
        self.assertEqual("/api/internal/channels.json", response.context["list_url"])
        self.assertEqual("/settings/channels", response.context[TEMBA_MENU_SELECTION])
        self.assertFalse(response.context["can_claim"])
        self.assertNotIn("claimable_types", response.context)
        self.assertContentMenu(list_url, self.editor, [])

        response = self.assertListFetch(list_url, [self.admin], context_objects=[])
        self.assertTrue(response.context["can_claim"])
        self.assertFalse(response.context["open_picker"])  # the workspace has channels
        self.assertEqual(settings.HELP_LINKS["channels"], response.context["help_links"]["channels"])
        self.assertContentMenu(list_url, self.admin, ["New Channel"])

        types = response.context["claimable_types"]
        # the most used types come first (External API has channels here, Bandwidth has none), then by name, except
        # that Android comes last of the rest and the WhatsApp types come last of all - WhatsApp itself and then its
        # providers
        names = [t["name"] for t in types]
        first_whatsapp = names.index("WhatsApp")
        self.assertEqual("External API", names[0])
        self.assertLess(names.index("Bandwidth"), names.index("Clickatell"))
        self.assertEqual("Android", names[first_whatsapp - 1])
        self.assertEqual(
            [
                "WhatsApp",
                "360Dialog WhatsApp",
                "Kaleyra WhatsApp",
                "Turn.io WhatsApp",
                "Twilio WhatsApp",
                "Zenvia WhatsApp",
            ],
            names[first_whatsapp:],
        )

        by_code = {t["code"]: t for t in types}
        self.assertEqual(
            {
                "code": "TG",
                "slug": "telegram",
                "name": "Telegram",
                "category": "social",
                "claim_url": "/channels/types/telegram/claim/",
                "in_modal": True,
                "in_region": True,
                "recommended": True,
            },
            by_code["TG"],
        )
        self.assertEqual("social", by_code["D3C"]["category"])
        self.assertEqual("api", by_code["EX"]["category"])
        self.assertTrue(by_code["EX"]["in_modal"])
        self.assertTrue(by_code["WAC"]["in_modal"])  # signing into Facebook happens in a popup
        self.assertEqual("api", by_code["FC"]["category"])
        self.assertNotIn("FCM", by_code)  # only available to staff

        # 3 recommended channels for Rwanda
        self.assertEqual(["AT", "MT", "TG"], sorted(t["code"] for t in types if t["recommended"]))

        # e.g. Macrokiosk is only available in Malaysia, so is listed as out of region
        self.assertFalse(by_code["MK"]["in_region"])

        # types without a claim view aren't listed
        self.assertNotIn("FB", by_code)

        self.org.timezone = "Canada/Central"
        self.org.save(update_fields=("timezone",))

        response = self.client.get(list_url)
        self.assertEqual(
            ["NX", "T", "TG", "TMS"],
            sorted(t["code"] for t in response.context["claimable_types"] if t["recommended"]),
        )

        # asking for a new channel opens the picker
        response = self.client.get(list_url + "?new=1")
        self.assertTrue(response.context["open_picker"])

        # as does a workspace with no channels
        self.org.channels.update(is_active=False)
        response = self.client.get(list_url)
        self.assertTrue(response.context["open_picker"])
        self.assertContains(response, "<temba-channel-picker")

        # only channel help is given, and none at all for a brand which doesn't share in our support
        help_links = get_channel_help_links(self.org.branding)
        self.assertTrue(all(k == "channels" or k.startswith("channels.") for k in help_links))
        self.assertIn("channels.types.telegram", help_links)

        with override_settings(BRAND={**self.org.branding, "features": ["sso"]}):
            response = self.client.get(list_url)
            self.assertEqual({}, response.context["help_links"])

        # once the workspace is at its limit, it can't add more
        with override_settings(ORG_LIMIT_DEFAULTS={"channels": 0}):
            response = self.client.get(list_url)
            self.assertTrue(response.context["limit_reached"])
            self.assertFalse(response.context["can_claim"])
            self.assertContains(response, "Channel limit reached")
            self.assertNotContains(response, "<temba-channel-picker")
            self.assertContentMenu(list_url, self.admin, [])

    def test_claim(self):
        # the old claim pages open the picker on the list page
        for claim_url in (reverse("channels.channel_claim"), reverse("channels.channel_claim_all")):
            self.assertRequestDisallowed(claim_url, [None, self.agent, self.editor])

            self.login(self.admin)
            response = self.client.get(claim_url)
            self.assertEqual(302, response.status_code)
            self.assertEqual(reverse("channels.channel_list") + "?new=1", response.url)

    def test_claim_in_modal(self):
        claim_url = reverse("channels.types.telegram.claim")
        modal = {"HTTP_X_TEMBA_CLAIM_MODAL": "1"}

        self.login(self.admin)

        # in the picker's modal only the form is rendered
        response = self.client.get(claim_url, **modal)
        self.assertEqual(200, response.status_code)
        self.assertEqual("channels/claim_modal.html", response.context["base_template"])
        self.assertContains(response, 'name="auth_token"')
        self.assertNotContains(response, "<html")

        # otherwise it's a page
        response = self.client.get(claim_url)
        self.assertNotEqual("channels/claim_modal.html", response.context["base_template"])

        # errors come back as the form
        with patch("requests.get") as mock_get:
            mock_get.return_value = MockResponse(404, '{"ok": false, "error_code": 404, "description": "Not Found"}')
            response = self.client.post(claim_url, {"auth_token": "123:abc"}, **modal)
            self.assertEqual(200, response.status_code)
            self.assertFalse(response.has_header("X-Temba-Success"))
            self.assertContains(response, "Your authentication token is invalid")

        # and success, which would have redirected to the channel list, hands the picker where to go and what it added
        bot = '{"ok": true, "result": {"id": 123, "is_bot": true, "first_name": "Rapid", "username": "rapidbot"}}'
        with patch("requests.get") as mock_get, patch("requests.post") as mock_post:
            mock_get.return_value = MockResponse(200, bot)
            mock_post.return_value = MockResponse(200, '{"ok": true, "result": "SUCCESS"}')
            response = self.client.post(claim_url, {"auth_token": "123:abc"}, **modal)

        channel = self.org.channels.get(channel_type="TG", is_active=True, address="rapidbot")
        self.assertEqual(200, response.status_code)
        self.assertEqual(reverse("channels.channel_list"), response["X-Temba-Success"])
        self.assertEqual(str(channel.uuid), response["X-Temba-Channel"])
        self.assertEqual("Rapid", response["X-Temba-Channel-Name"])

    def test_claim_view_availability(self):
        claim_url = reverse("channels.types.external.claim")

        self.login(self.admin)

        num_channels = self.org.channels.count()

        # a type which isn't available to the org at all can't be claimed
        with patch.object(ExternalType, "is_available_to", lambda self, org, user: (False, False)):
            self.assertEqual(404, self.client.get(claim_url).status_code)
            self.assertEqual(404, self.client.post(claim_url, {}).status_code)

        self.assertEqual(num_channels, self.org.channels.count())

        # but a type which is only unavailable because of the org's region is still claimable, because the claim all
        # page lists those
        with patch.object(ExternalType, "is_available_to", lambda self, org, user: (False, True)):
            self.assertEqual(200, self.client.get(claim_url).status_code)

        # e.g. M3 Tech is only available to orgs in Pakistan but this org is in Rwanda
        self.assertEqual("Africa/Kigali", str(self.org.timezone))
        self.assertEqual(200, self.client.get(reverse("channels.types.m3tech.claim")).status_code)

    def test_configuration(self):
        config_url = reverse("channels.channel_configuration", args=[self.ex_channel.uuid])

        # can't view configuration if not logged in
        self.assertRequestDisallowed(config_url, [None, self.agent, self.editor])

        self.login(self.admin)

        response = self.client.get(config_url)
        self.assertContains(response, "Your service connects to this channel over HTTP")
        self.assertContains(response, "Waiting for first message")
        self.assertEqual("/settings/channels", response.context[TEMBA_MENU_SELECTION])

        # the page checks whether the channel is receiving yet
        response = self.client.get(config_url + "?status=1")
        self.assertEqual({"receiving": False}, response.json())

        # in a sheet over the channel's page it's a single column without the channel's details
        response = self.client.get(config_url, HTTP_X_TEMBA_SPA="1", HTTP_X_TEMBA_SHEET="1")
        self.assertEqual("sheet.html", response.context["base_template"])
        self.assertContains(response, 'class="setup single"')
        self.assertNotContains(response, '<aside class="setup-aside">')

        # can't view configuration of channel whose type doesn't support it
        response = self.client.get(reverse("channels.channel_configuration", args=[self.channel.uuid]))
        self.assertRedirect(response, reverse("channels.channel_read", args=[self.channel.uuid]))

        # can't view configuration of channel in other org
        response = self.client.get(reverse("channels.channel_configuration", args=[self.other_org_channel.uuid]))
        self.assertEqual(response.status_code, 404)

    def test_update(self):
        android_channel = self.create_channel(
            "A", "My Android", "+250785551212", country="RW", secret="sesame", config={"FCM_ID": "123"}
        )
        vonage_channel = self.create_channel("NX", "My Vonage", "+1234567890", country="US", config={}, role="CASR")
        telegram_channel = self.create_channel("TG", "My Telegram", "75474745", config={})

        android_url = reverse("channels.channel_update", args=[android_channel.id])
        vonage_url = reverse("channels.channel_update", args=[vonage_channel.id])
        telegram_url = reverse("channels.channel_update", args=[telegram_channel.id])

        self.assertRequestDisallowed(android_url, [None, self.agent, self.editor, self.admin2])

        # fields shown depend on scheme and role
        self.assertUpdateFetch(
            android_url,
            [self.admin],
            form_fields={
                "name": "My Android",
                "is_enabled": True,
                "allow_international": False,
            },
        )
        self.assertUpdateFetch(
            vonage_url,
            [self.admin],
            form_fields={
                "name": "My Vonage",
                "is_enabled": True,
                "allow_international": False,
                "machine_detection": False,
            },
        )
        self.assertUpdateFetch(telegram_url, [self.admin], form_fields={"name": "My Telegram", "is_enabled": True})

        # name can't be empty
        self.assertUpdateSubmit(
            android_url,
            self.admin,
            {"name": ""},
            form_errors={"name": "This field is required."},
            object_unchanged=android_channel,
        )

        # make some changes
        self.assertUpdateSubmit(
            vonage_url,
            self.admin,
            {
                "name": "Updated Name",
                "is_enabled": True,
                "allow_international": True,
                "machine_detection": True,
            },
        )

        vonage_channel.refresh_from_db()
        self.assertEqual("Updated Name", vonage_channel.name)
        self.assertEqual("+1234567890", vonage_channel.address)
        self.assertTrue(vonage_channel.config.get("allow_international"))
        self.assertTrue(vonage_channel.config.get("machine_detection"))

        self.assertUpdateFetch(
            vonage_url,
            [self.admin],
            form_fields={
                "name": "Updated Name",
                "is_enabled": True,
                "allow_international": True,
                "machine_detection": True,
            },
        )

        # staff users also see the TPS field
        self.assertUpdateFetch(
            vonage_url,
            [self.customer_support],
            form_fields={
                "name": "Updated Name",
                "is_enabled": True,
                "allow_international": True,
                "machine_detection": True,
                "tps": None,
            },
            choose_org=self.org,
        )

        # but can only change it if they're also superusers
        response = self.requestView(
            vonage_url, self.customer_support, post_data={"name": "Updated Name", "tps": "25"}, choose_org=self.org
        )
        self.assertEqual(403, response.status_code)

        self.customer_support.is_superuser = True
        self.customer_support.save(update_fields=("is_superuser",))

        # TPS must be in range
        self.assertUpdateSubmit(
            vonage_url,
            self.customer_support,
            {"name": "Updated Name", "is_enabled": True, "tps": "0"},
            form_errors={"tps": "Ensure this value is greater than or equal to 1."},
            object_unchanged=vonage_channel,
        )
        self.assertUpdateSubmit(
            vonage_url,
            self.customer_support,
            {"name": "Updated Name", "is_enabled": True, "tps": "1001"},
            form_errors={"tps": "Ensure this value is less than or equal to 1000."},
            object_unchanged=vonage_channel,
        )

        self.assertUpdateSubmit(
            vonage_url, self.customer_support, {"name": "Updated Name", "is_enabled": True, "tps": "25"}
        )

        vonage_channel.refresh_from_db()
        self.assertEqual(25, vonage_channel.tps)

        # non-staff saving the form leave it alone
        self.assertUpdateSubmit(vonage_url, self.admin, {"name": "Updated Name", "is_enabled": True})

        vonage_channel.refresh_from_db()
        self.assertEqual(25, vonage_channel.tps)

        # blank leaves it unchanged
        self.assertUpdateSubmit(
            vonage_url, self.customer_support, {"name": "Updated Name", "is_enabled": True, "tps": ""}
        )

        vonage_channel.refresh_from_db()
        self.assertEqual(25, vonage_channel.tps)

    def test_read_menu(self):
        # the read page has no menu, just buttons for what can be done to the channel - deleting is in the edit dialog
        self.assertContentMenu(reverse("channels.channel_read", args=[self.ex_channel.uuid]), self.admin, ["Edit"])

        # and editors can't manage channels
        self.assertContentMenu(reverse("channels.channel_read", args=[self.ex_channel.uuid]), self.editor, [])

        # types can add their own management buttons
        fb_channel = self.create_channel("FBA", "Facebook", "12345")
        fb_read_url = reverse("channels.channel_read", args=[fb_channel.uuid])
        self.assertContentMenu(fb_read_url, self.admin, ["Reconnect Facebook Page", "Edit"])
        self.assertContentMenu(fb_read_url, self.editor, [])

    def test_logs_list(self):
        channel = self.create_channel("T", "My Channel", "+250785551212")
        log = self.create_channel_log(
            channel, ChannelLog.LOG_TYPE_MSG_SEND, http_logs=[{"request": "GET https://foo.bar/send1"}], errors=[]
        )

        logs_url = reverse("channels.channel_logs_list", args=[channel.uuid])
        log_url = reverse("channels.channel_logs_read", args=[channel.uuid, "log", log.uuid])

        self.assertRequestDisallowed(logs_url, [None, self.agent, self.editor, self.admin2])

        # the page is a shell for the log list, which fetches the logs itself
        response = self.assertReadFetch(logs_url, [self.admin], context_object=channel)
        self.assertEqual(f"/api/internal/channel_logs.json?channel={channel.uuid}", response.context["list_url"])
        self.assertContains(response, "<temba-log-list")
        self.assertNotIn("selected", response.context)

        # it can open with one of the channel's logs selected, but not anything else
        response = self.requestView(logs_url + f"?selected={log_url}", self.admin)
        self.assertEqual(log_url, response.context["selected"])

        response = self.requestView(logs_url + "?selected=/org/home/", self.admin)
        self.assertNotIn("selected", response.context)

        # channels of types that don't have logs return a 404
        webchat_channel = self.create_channel("CHP", "WebChat", "123")
        self.login(self.admin)
        response = self.client.get(reverse("channels.channel_logs_list", args=[webchat_channel.uuid]))
        self.assertEqual(404, response.status_code)

    def test_logs_read(self):
        log1 = self.create_channel_log(
            self.channel,
            ChannelLog.LOG_TYPE_MSG_SEND,
            http_logs=[{"request": "GET https://foo.bar/send1"}],
            errors=[{"code": "bad_response", "message": "response not right"}],
        )
        self.create_channel_log(
            self.channel,
            ChannelLog.LOG_TYPE_MSG_STATUS,
            http_logs=[{"request": "GET https://foo.bar/send2"}],
            errors=[],
        )

        log1_url = reverse("channels.channel_logs_read", args=[self.channel.uuid, "log", log1.uuid])

        self.assertRequestDisallowed(log1_url, [None, self.agent, self.editor, self.admin2])
        response = self.assertReadFetch(log1_url, [self.admin], context_object=self.channel)
        self.assertIsNone(response.context["msg"])
        self.assertIsNone(response.context["call"])
        self.assertEqual(1, len(response.context["logs"]))
        self.assertContains(response, "GET https://foo.bar/send1")

        # channels of types that don't have logs return a 404
        webchat_channel = self.create_channel("CHP", "WebChat", "123")
        self.login(self.admin)
        response = self.client.get(reverse("channels.channel_logs_read", args=[webchat_channel.uuid, "log", log1.uuid]))
        self.assertEqual(404, response.status_code)

    def test_logs_msg(self):
        contact = self.create_contact("Fred", phone="+12067799191")

        log1 = self.create_channel_log(
            self.channel,
            ChannelLog.LOG_TYPE_MSG_SEND,
            http_logs=[
                {
                    "url": "https://foo.bar/send1",
                    "status_code": 200,
                    "request": "POST https://foo.bar/send1\r\n\r\n{}",
                    "response": "HTTP/1.0 200 OK\r\r\r\n",
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2024-09-16T00:00:00Z",
                }
            ],
        )
        log2 = self.create_channel_log(
            self.channel,
            ChannelLog.LOG_TYPE_MSG_SEND,
            http_logs=[
                {
                    "url": "https://foo.bar/send2",
                    "status_code": 200,
                    "request": "POST https://foo.bar/send2\r\n\r\n{}",
                    "response": "HTTP/1.0 200 OK\r\r\r\n",
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2024-09-16T00:00:00Z",
                }
            ],
        )
        msg1 = self.create_outgoing_msg(contact, "Message 1", channel=self.channel, status="D", logs=[log1, log2])

        # create another msg and log that shouldn't be included
        log3 = self.create_channel_log(
            self.channel,
            ChannelLog.LOG_TYPE_MSG_SEND,
            http_logs=[
                {
                    "url": "https://foo.bar/send3",
                    "status_code": 200,
                    "request": "POST https://foo.bar/send3\r\n\r\n{}",
                    "response": "HTTP/1.0 200 OK\r\r\r\n",
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2024-09-16T00:00:00Z",
                }
            ],
        )
        self.create_outgoing_msg(contact, "Message 2", status="D", logs=[log3])

        logs_url = reverse("channels.channel_logs_read", args=[self.channel.uuid, "msg", msg1.uuid])

        self.assertRequestDisallowed(logs_url, [None, self.editor, self.agent, self.admin2])
        response = self.assertReadFetch(logs_url, [self.admin], context_object=self.channel)
        self.assertEqual(2, len(response.context["logs"]))
        self.assertEqual("https://foo.bar/send1", response.context["logs"][0]["http_logs"][0]["url"])
        self.assertEqual("https://foo.bar/send2", response.context["logs"][1]["http_logs"][0]["url"])

        response = self.client.get(logs_url)
        self.assertEqual("/settings/channels", response.headers[TEMBA_MENU_SELECTION])

        # try to lookup log from different org using channel from this org
        org2_contact = self.create_contact("Alice", phone="+250788382382", org=self.org2)
        org2_channel = self.create_channel("A", "Other Channel", "+250785551212", org=self.org2)
        org2_log = self.create_channel_log(org2_channel, ChannelLog.LOG_TYPE_MSG_SEND, http_logs=[])
        org2_msg2 = self.create_outgoing_msg(
            org2_contact, "Message 3", status="D", channel=org2_channel, logs=[org2_log]
        )

        logs_url = reverse("channels.channel_logs_read", args=[self.channel.uuid, "msg", org2_msg2.uuid])
        self.assertRequestDisallowed(logs_url, [None, self.editor, self.agent, self.admin, self.admin2])

    def test_logs_call(self):
        contact = self.create_contact("Fred", phone="+12067799191")
        flow = self.create_flow("IVR")

        log1 = self.create_channel_log(
            self.channel,
            ChannelLog.LOG_TYPE_MSG_SEND,
            http_logs=[
                {
                    "url": "https://foo.bar/call1",
                    "status_code": 200,
                    "request": "POST https://foo.bar/send1\r\n\r\n{}",
                    "response": "HTTP/1.0 200 OK\r\r\r\n",
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2024-09-16T00:00:00Z",
                }
            ],
        )
        log2 = self.create_channel_log(
            self.channel,
            ChannelLog.LOG_TYPE_IVR_START,
            http_logs=[
                {
                    "url": "https://foo.bar/call2",
                    "status_code": 200,
                    "request": "POST /send2\r\n\r\n{}",
                    "response": "HTTP/1.0 200 OK\r\r\r\n",
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2022-01-01T00:00:00Z",
                }
            ],
        )
        call1 = self.create_incoming_call(flow, contact, logs=[log1, log2])

        # create another call and log that shouldn't be included
        log3 = self.create_channel_log(
            self.channel,
            ChannelLog.LOG_TYPE_IVR_START,
            http_logs=[
                {
                    "url": "https://foo.bar/call3",
                    "status_code": 200,
                    "request": "POST /send2\r\n\r\n{}",
                    "response": "HTTP/1.0 200 OK\r\r\r\n",
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2022-01-01T00:00:00Z",
                }
            ],
        )
        self.create_incoming_call(flow, contact, logs=[log3])

        logs_url = reverse("channels.channel_logs_read", args=[self.channel.uuid, "call", call1.uuid])

        self.assertRequestDisallowed(logs_url, [None, self.editor, self.agent, self.admin2])
        response = self.assertReadFetch(logs_url, [self.admin], context_object=self.channel)
        self.assertEqual(2, len(response.context["logs"]))
        self.assertEqual("https://foo.bar/call1", response.context["logs"][0]["http_logs"][0]["url"])
        self.assertEqual("https://foo.bar/call2", response.context["logs"][1]["http_logs"][0]["url"])

    def test_delete(self):
        delete_url = reverse("channels.channel_delete", args=[self.ex_channel.uuid])
        update_url = reverse("channels.channel_update", args=[self.ex_channel.id])

        # it's deleted from its edit dialog
        self.assertContains(self.requestView(update_url, self.admin), delete_url)

        self.assertRequestDisallowed(delete_url, [None, self.agent, self.editor, self.admin2])

        response = self.assertDeleteFetch(delete_url, [self.admin])
        self.assertContains(response, "You are about to delete")

        # submit to delete it
        response = self.assertDeleteSubmit(
            delete_url, self.admin, object_deactivated=self.ex_channel, success_status=200
        )
        self.assertEqual("/channels/channel/", response["X-Temba-Success"])

        # reactivate
        self.ex_channel.is_active = True
        self.ex_channel.save()

        # add a dependency and try again
        flow = self.create_flow("Color Flow")
        flow.channel_dependencies.add(self.ex_channel)
        self.assertFalse(flow.has_issues)

        response = self.assertDeleteFetch(delete_url, [self.admin])
        self.assertContains(response, "is used by the following items but can still be deleted:")
        self.assertContains(response, "Color Flow")

        self.assertDeleteSubmit(delete_url, self.admin, object_deactivated=self.ex_channel, success_status=200)

        flow.refresh_from_db()
        self.assertTrue(flow.has_issues)
        self.assertNotIn(self.ex_channel, flow.channel_dependencies.all())
