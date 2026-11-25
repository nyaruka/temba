from django.contrib.auth.models import Group
from django.test.utils import override_settings
from django.urls import reverse

from temba.tests import CRUDLTestMixin, TembaTest, mock_mailroom
from temba.utils.views.mixins import TEMBA_MENU_SELECTION

from ..models import Channel, ChannelLog


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

        # should see all channel types not for beta only and having a category
        self.assertEqual(["AT", "MT", "TG"], [t.code for t in response.context["recommended_channels"]])

        self.assertEqual(response.context["channel_types"]["PHONE"][0].code, "AC")
        self.assertEqual(response.context["channel_types"]["PHONE"][1].code, "BW")
        self.assertEqual(response.context["channel_types"]["PHONE"][2].code, "BS")
        self.assertEqual(response.context["channel_types"]["PHONE"][-1].code, "A")

        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][0].code, "D3C")
        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][1].code, "FBA")
        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][2].code, "IG")
        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][-2].code, "ZVW")
        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][-1].code, "TM")

        self.admin.groups.add(Group.objects.get(name="Beta"))

        response = self.client.get(reverse("channels.channel_claim_all"))
        self.assertEqual(200, response.status_code)

        # should see all channel types having a category including beta only channel types
        self.assertEqual(["AT", "MT", "TG"], [t.code for t in response.context["recommended_channels"]])

        self.assertEqual(response.context["channel_types"]["PHONE"][0].code, "AC")
        self.assertEqual(response.context["channel_types"]["PHONE"][1].code, "BW")
        self.assertEqual(response.context["channel_types"]["PHONE"][2].code, "BS")
        self.assertEqual(response.context["channel_types"]["PHONE"][-1].code, "A")

        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][0].code, "D3C")
        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][1].code, "FBA")
        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][2].code, "IG")
        self.assertEqual(response.context["channel_types"]["SOCIAL_MEDIA"][-1].code, "TM")

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
        vonage_channel = self.create_channel("NX", "My Vonage", "+1234567890", country="US", config={}, role="CASR")
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
            },
        )
        self.assertUpdateFetch(
            telegram_url, [self.editor, self.admin], form_fields={"name": "My Telegram", "is_enabled": True}
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
            },
        )

        # staff users see extra fields
        self.assertUpdateFetch(
            vonage_url,
            [self.customer_support],
            form_fields=["name", "is_enabled", "allow_international", "machine_detection"],
            choose_org=self.org,
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

    @mock_mailroom
    def test_delete(self, mr_mocks):
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
