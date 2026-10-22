from unittest.mock import patch

from django.test.utils import override_settings
from django.urls import reverse

from temba.tests import CRUDLTestMixin, TembaTest
from temba.utils.views.mixins import TEMBA_MENU_SELECTION

from ..models import Channel, ChannelLog
from ..types.external.type import ExternalType


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

    def test_claim(self):
        claim_url = reverse("channels.channel_claim")
        self.assertRequestDisallowed(claim_url, [None, self.agent])
        response = self.assertReadFetch(claim_url, [self.editor, self.admin])

        # 3 recommended channels for Rwanda
        self.assertEqual(["AT", "MT", "TG"], [t.code for t in response.context["recommended_channels"]])

        self.assertEqual(response.context["channel_types"]["PHONE"][0].code, "BW")
        self.assertEqual(response.context["channel_types"]["PHONE"][1].code, "CT")
        self.assertEqual(response.context["channel_types"]["PHONE"][2].code, "EX")
        self.assertEqual(response.context["channel_types"]["PHONE"][3].code, "I2")
        self.assertEqual(response.context["channel_types"]["PHONE"][-1].code, "A")

        self.org.timezone = "Canada/Central"
        self.org.save()

        response = self.client.get(reverse("channels.channel_claim"))
        self.assertEqual(200, response.status_code)

        self.assertEqual(["TG", "TMS", "T", "NX"], [t.code for t in response.context["recommended_channels"]])

        self.assertEqual(response.context["channel_types"]["PHONE"][0].code, "BW")
        self.assertEqual(response.context["channel_types"]["PHONE"][1].code, "CT")
        self.assertEqual(response.context["channel_types"]["PHONE"][2].code, "EX")
        self.assertEqual(response.context["channel_types"]["PHONE"][3].code, "I2")
        self.assertEqual(response.context["channel_types"]["PHONE"][-1].code, "A")

        with override_settings(ORG_LIMIT_DEFAULTS={"channels": 2}):
            response = self.client.get(reverse("channels.channel_claim"))
            self.assertEqual(200, response.status_code)
            self.assertTrue(response.context["limit_reached"])
            self.assertContains(response, "You have reached the per-workspace limit")

    def test_claim_all(self):
        claim_url = reverse("channels.channel_claim_all")
        self.assertRequestDisallowed(claim_url, [None, self.agent])
        response = self.assertReadFetch(claim_url, [self.editor, self.admin])

        # should see all channel types having a category
        self.assertEqual(["AT", "MT", "TG"], [t.code for t in response.context["recommended_channels"]])

        self.assertEqual(response.context["channel_types"]["PHONE"][0].code, "AC")
        self.assertEqual(response.context["channel_types"]["PHONE"][1].code, "BW")
        self.assertEqual(response.context["channel_types"]["PHONE"][2].code, "BS")
        self.assertEqual(response.context["channel_types"]["PHONE"][-1].code, "A")

        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][0].code, "D3C")
        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][1].code, "FBA")
        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][2].code, "IG")
        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][-2].code, "WAC")
        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][-1].code, "ZVW")

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

        # e.g. SMSCentral is only available to orgs in Nepal but this org is in Rwanda
        self.assertEqual("Africa/Kigali", str(self.org.timezone))
        self.assertEqual(200, self.client.get(reverse("channels.types.smscentral.claim")).status_code)

    def test_configuration(self):
        config_url = reverse("channels.channel_configuration", args=[self.ex_channel.uuid])

        # can't view configuration if not logged in
        self.assertRequestDisallowed(config_url, [None, self.agent])

        self.login(self.admin)

        response = self.client.get(config_url)
        self.assertContains(response, "To finish configuring your connection")
        self.assertEqual(f"/settings/channels/{self.ex_channel.uuid}", response.context[TEMBA_MENU_SELECTION])

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
        vonage_channel = self.create_channel(
            "NX",
            "My Vonage",
            "+1234567890",
            country="US",
            config={"nexmo_api_key": "1234", "nexmo_api_secret": "secret"},
            role="CASR",
        )
        telegram_channel = self.create_channel("TG", "My Telegram", "75474745", config={})

        android_url = reverse("channels.channel_update", args=[android_channel.id])
        vonage_url = reverse("channels.channel_update", args=[vonage_channel.id])
        telegram_url = reverse("channels.channel_update", args=[telegram_channel.id])

        self.assertRequestDisallowed(android_url, [None, self.agent, self.admin2])

        # fields shown depend on scheme and role
        self.assertUpdateFetch(
            android_url,
            [self.editor, self.admin],
            form_fields={
                "name": "My Android",
                "is_enabled": True,
                "allow_international": False,
            },
        )
        self.assertUpdateFetch(
            vonage_url,
            [self.editor, self.admin],
            form_fields={
                "name": "My Vonage",
                "is_enabled": True,
                "allow_international": False,
                "machine_detection": False,
                "nexmo_api_key": "1234",
                "nexmo_api_secret": "secret",
            },
        )
        self.assertUpdateFetch(
            telegram_url,
            [self.editor, self.admin],
            form_fields={"name": "My Telegram", "is_enabled": True, "auth_token": ""},
        )

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
                "nexmo_api_key": "1234",
                "nexmo_api_secret": "secret",
            },
        )

        vonage_channel.refresh_from_db()
        self.assertEqual("Updated Name", vonage_channel.name)
        self.assertEqual("+1234567890", vonage_channel.address)
        self.assertTrue(vonage_channel.config.get("allow_international"))
        self.assertTrue(vonage_channel.config.get("machine_detection"))

        self.assertUpdateFetch(
            vonage_url,
            [self.editor, self.admin],
            form_fields={
                "name": "Updated Name",
                "is_enabled": True,
                "allow_international": True,
                "machine_detection": True,
                "nexmo_api_key": "1234",
                "nexmo_api_secret": "secret",
            },
        )

        # staff users see extra fields
        self.assertUpdateFetch(
            vonage_url,
            [self.customer_support],
            form_fields=[
                "name",
                "is_enabled",
                "allow_international",
                "machine_detection",
                "nexmo_api_key",
                "nexmo_api_secret",
            ],
            choose_org=self.org,
        )

    def test_update_credentials(self):
        self.login(self.admin)

        types = [t for t in Channel.get_types() if t.credentials]
        self.assertIn("D3C", [t.code for t in types])

        for channel_type in types:
            with self.subTest(channel_type=channel_type.code):
                channel = self.create_channel(
                    channel_type.code,
                    "Old Name",
                    "1234",
                    schemes=channel_type.schemes or ["tel"],
                    config={c.key: f"old-{c.key}" for c in channel_type.credentials},
                )
                update_url = reverse("channels.channel_update", args=[channel.id])

                # form shows the current credentials
                response = self.client.get(update_url)
                form = response.context["form"]
                for credential in channel_type.credentials:
                    self.assertEqual(f"old-{credential.key}", form.fields[credential.key].initial)
                    self.assertEqual(credential.required, form.fields[credential.key].required)

                with patch.object(type(channel_type), "check_credentials", return_value=False) as mock_check:
                    # changed credentials are checked and rejected if invalid
                    data = {"name": "New Name", "is_enabled": True}
                    data |= {c.key: f"new-{c.key}" for c in channel_type.credentials}
                    if "role" in form.fields:
                        data["role"] = list(channel.role)
                    response = self.client.post(update_url, data)
                    self.assertFormError(response.context["form"], None, "Credentials don't appear to be valid.")
                    self.assertEqual(1, mock_check.call_count)

                    channel.refresh_from_db()
                    self.assertEqual("Old Name", channel.name)

                    # and saved if valid
                    mock_check.return_value = True
                    response = self.client.post(update_url, data)
                    self.assertEqual(302, response.status_code)
                    self.assertEqual(2, mock_check.call_count)

                    updated_config = mock_check.call_args[0][0]
                    for credential in channel_type.credentials:
                        self.assertEqual(f"new-{credential.key}", updated_config[credential.key])

                    channel.refresh_from_db()
                    self.assertEqual("New Name", channel.name)
                    for credential in channel_type.credentials:
                        self.assertEqual(f"new-{credential.key}", channel.config[credential.key])

                    # unchanged credentials aren't checked, so a channel with revoked credentials can be disabled
                    mock_check.return_value = False
                    response = self.client.post(update_url, data | {"is_enabled": False})
                    self.assertEqual(302, response.status_code)
                    self.assertEqual(2, mock_check.call_count)

                    channel.refresh_from_db()
                    self.assertFalse(channel.is_enabled)

    def test_read_menu(self):
        # normal channel types get a logs menu item on their read page
        self.assertContentMenu(
            reverse("channels.channel_read", args=[self.ex_channel.uuid]),
            self.admin,
            ["Configuration", "Logs", "Edit", "Delete"],
        )

        # but not types whose channels don't have logs
        webchat_channel = self.create_channel("CHP", "WebChat", "123")
        self.assertContentMenu(
            reverse("channels.channel_read", args=[webchat_channel.uuid]),
            self.admin,
            ["Configuration", "Edit", "Delete"],
        )

        # and not for users without permission to view logs
        self.assertContentMenu(
            reverse("channels.channel_read", args=[self.ex_channel.uuid]),
            self.editor,
            ["Configuration", "Edit", "Delete"],
        )

    def test_logs_list(self):
        channel = self.create_channel("T", "My Channel", "+250785551212")

        logs = []
        for i in range(55):
            logs.append(
                self.create_channel_log(
                    channel,
                    ChannelLog.LOG_TYPE_MSG_SEND,
                    http_logs=[{"request": f"GET https://foo.bar/send{i}"}],
                    errors=[],
                )
            )

        self.create_channel_log(  # other channel
            self.channel,
            ChannelLog.LOG_TYPE_MSG_STATUS,
            http_logs=[{"request": "GET https://foo.bar/send3"}],
            errors=[],
        )

        log1_url = reverse("channels.channel_logs_list", args=[channel.uuid])

        self.assertRequestDisallowed(log1_url, [None, self.agent, self.editor, self.admin2])
        response = self.assertReadFetch(log1_url, [self.admin], context_object=channel)
        self.assertEqual(logs[54].uuid, response.context["logs"][0].uuid)
        self.assertEqual(logs[5].uuid, response.context["logs"][-1].uuid)
        self.assertContains(response, "Message Send")
        self.assertContains(response, f"after={logs[5].uuid}")

        response = self.assertReadFetch(log1_url + f"?after={logs[5].uuid}", [self.admin], context_object=channel)
        self.assertEqual(logs[4].uuid, response.context["logs"][0].uuid)
        self.assertEqual(logs[0].uuid, response.context["logs"][-1].uuid)

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
        self.assertEqual(f"/settings/channels/{self.channel.uuid}", response.headers[TEMBA_MENU_SELECTION])

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

        self.assertRequestDisallowed(delete_url, [None, self.agent, self.admin2])

        response = self.assertDeleteFetch(delete_url, [self.editor, self.admin])
        self.assertContains(response, "You are about to delete")

        # submit to delete it
        response = self.assertDeleteSubmit(
            delete_url, self.admin, object_deactivated=self.ex_channel, success_status=200
        )
        self.assertEqual("/org/workspace/", response["X-Temba-Success"])

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
