from datetime import datetime, timedelta, timezone as tzone
from unittest.mock import call, patch

from django.urls import reverse

from temba import mailroom
from temba.msgs.models import Msg
from temba.notifications.incidents.builtin import ChannelDisconnectedIncidentType
from temba.templates.models import TemplateTranslation
from temba.tests import CRUDLTestMixin, MockResponse, TembaTest, mock_mailroom
from temba.tests.crudl import StaffRedirect
from temba.triggers.models import Trigger
from temba.utils import json
from temba.utils.views.mixins import TEMBA_MENU_SELECTION

from ..models import Channel, SyncEvent


class ChannelTest(TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        self.channel.delete()

        self.tel_channel = self.create_channel(
            "A", "Test Channel", "+250785551212", country="RW", secret="12345", config={"FCM_ID": "123"}
        )
        self.facebook_channel = self.create_channel(
            "FBA", "Facebook Channel", "12345", config={Channel.CONFIG_PAGE_NAME: "Test page"}
        )

        self.unclaimed_channel = self.create_channel("NX", "Unclaimed Channel", "", config={"FCM_ID": "000"})
        self.unclaimed_channel.org = None
        self.unclaimed_channel.save(update_fields=("org",))

    def claim_new_android(self, fcm_id: str = "FCM111", number: str = "0788123123") -> Channel:
        """
        Helper function to register and claim a new Android channel
        """
        cmds = [
            dict(cmd="fcm", fcm_id=fcm_id, uuid="8a3fa886-8c34-4e0c-97f2-e0c1b3b60ec1"),
            dict(cmd="status", cc="RW", dev="Nexus"),
        ]
        response = self.client.post(reverse("register"), json.dumps({"cmds": cmds}), content_type="application/json")
        self.assertEqual(200, response.status_code)

        android = Channel.objects.order_by("id").last()

        self.login(self.admin)
        response = self.client.post(
            reverse("channels.types.android.claim"), {"claim_code": android.claim_code, "phone_number": number}
        )
        self.assertRedirect(response, "/welcome/")

        android.refresh_from_db()
        return android

    def test_deactivate(self):
        self.login(self.admin)
        self.tel_channel.is_active = False
        self.tel_channel.save()
        response = self.client.get(reverse("channels.channel_read", args=[self.tel_channel.uuid]))
        self.assertEqual(404, response.status_code)

    def test_get_address_display(self):
        self.assertEqual("+250 785 551 212", self.tel_channel.get_address_display())
        self.assertEqual("+250785551212", self.tel_channel.get_address_display(e164=True))

        self.assertEqual("Test page (12345)", self.facebook_channel.get_address_display())

        # make sure it works with alphanumeric numbers
        self.tel_channel.address = "EATRIGHT"
        self.assertEqual("EATRIGHT", self.tel_channel.get_address_display())
        self.assertEqual("EATRIGHT", self.tel_channel.get_address_display(e164=True))

        self.tel_channel.address = ""
        self.assertEqual("", self.tel_channel.get_address_display())

    def test_channel_create(self):
        # can't use an invalid scheme for a fixed-scheme channel type
        with self.assertRaises(ValueError):
            Channel.create(
                self.org,
                self.admin,
                "KE",
                "AT",
                None,
                "+250788123123",
                config=dict(username="at-user", api_key="africa-key"),
                uuid="00000000-0000-0000-0000-000000001234",
                schemes=["fb"],
            )

        # a scheme is required
        with self.assertRaises(ValueError):
            Channel.create(
                self.org,
                self.admin,
                "US",
                "EX",
                None,
                "+12065551212",
                uuid="00000000-0000-0000-0000-000000001234",
                schemes=[],
            )

        # country channels can't have scheme
        with self.assertRaises(ValueError):
            Channel.create(
                self.org,
                self.admin,
                "US",
                "EX",
                None,
                "+12065551212",
                uuid="00000000-0000-0000-0000-000000001234",
                schemes=["fb"],
            )

    @mock_mailroom
    def test_release(self, mr_mocks):
        # create two channels..
        channel1 = Channel.create(
            self.org, self.admin, "RW", "A", "Test Channel", "0785551212", config={Channel.CONFIG_FCM_ID: "123"}
        )
        channel2 = self.create_channel("T", "Test Channel", "0785553333")

        # add channel trigger
        flow = self.create_flow("Test")
        Trigger.create(self.org, self.admin, Trigger.TYPE_CATCH_ALL, flow, channel=channel1)

        # create some activity on this channel
        contact = self.create_contact("Bob", phone="+593979123456")
        self.create_incoming_msg(contact, "Hi", channel=channel1)
        self.create_outgoing_msg(contact, "Hi", channel=channel1, status="Q")
        self.create_outgoing_msg(contact, "Hi", channel=channel1, status="E")
        self.create_outgoing_msg(contact, "Hi", channel=channel1, status="S")
        ChannelDisconnectedIncidentType.get_or_create(channel1)
        SyncEvent.create(
            channel1,
            dict(p_src="AC", p_sts="DIS", p_lvl=80, net="WIFI", pending=[1, 2], retry=[3, 4], cc="RW"),
            [1, 2],
        )
        self.create_template(
            "reminder",
            [
                TemplateTranslation(
                    channel=channel1,
                    locale="eng",
                    status="A",
                    external_locale="en",
                    components=[],
                    variables=[],
                )
            ],
        )

        # and some on another channel
        self.create_outgoing_msg(contact, "Hi", channel=channel2, status="E")
        ChannelDisconnectedIncidentType.get_or_create(channel2)
        SyncEvent.create(
            channel2,
            dict(p_src="AC", p_sts="DIS", p_lvl=80, net="WIFI", pending=[1, 2], retry=[3, 4], cc="RW"),
            [1, 2],
        )
        self.create_template(
            "reminder2",
            [
                TemplateTranslation(
                    channel=channel2,
                    locale="eng",
                    status="A",
                    external_locale="en",
                    components=[],
                    variables=[],
                )
            ],
        )
        Trigger.create(self.org, self.admin, Trigger.TYPE_CATCH_ALL, flow, channel=channel2)

        # add channel to a flow as a dependency
        flow.channel_dependencies.add(channel1)

        channel1.release(self.admin)

        flow.refresh_from_db()
        self.assertTrue(flow.has_issues)
        self.assertNotIn(channel1, flow.channel_dependencies.all())
        self.assertEqual(0, channel1.triggers.filter(is_active=True).count())
        self.assertEqual(0, channel1.incidents.filter(ended_on=None).count())
        self.assertEqual(0, channel1.template_translations.count())

        # check that we called mailroom to interrupt sessions tied to this channel
        self.assertEqual([call(self.org, channel1)], mr_mocks.calls["channel_interrupt"])

        # other channel should be unaffected
        self.assertEqual(1, channel2.msgs.filter(status="E").count())
        self.assertEqual(1, channel2.sync_events.count())
        self.assertEqual(1, channel2.triggers.filter(is_active=True).count())
        self.assertEqual(1, channel2.incidents.filter(ended_on=None).count())
        self.assertEqual(1, channel2.template_translations.count())

        # now do actual delete of channel
        channel1.msgs.all().delete()
        channel1.org.notifications.all().delete()
        channel1.delete()

        self.assertFalse(Channel.objects.filter(id=channel1.id).exists())

    def test_release_facebook(self):
        channel = Channel.create(
            self.org,
            self.admin,
            None,
            "FBA",
            name="Facebook",
            address="12345",
            role="SR",
            schemes=["facebook"],
            config={"auth_token": "09876543"},
        )

        flow = self.create_flow("Test")
        with patch("requests.post") as mock_post:
            mock_post.return_value = MockResponse(200, json.dumps({"success": True}))
            Trigger.create(self.org, self.admin, Trigger.TYPE_NEW_CONVERSATION, flow, channel=channel)
            self.assertEqual(1, channel.triggers.filter(is_active=True).count())

        with patch("requests.delete") as mock_delete:
            mock_delete.return_value = MockResponse(400, "error")

            channel.release(self.admin)
            self.assertEqual(0, channel.triggers.filter(is_active=True).count())
            self.assertEqual(1, channel.triggers.filter(is_active=False).count())
            self.assertFalse(channel.is_active)

    @mock_mailroom
    def test_release_android(self, mr_mocks):
        android = self.claim_new_android()
        self.assertEqual("FCM111", android.config.get(Channel.CONFIG_FCM_ID))
        mr_mocks.calls.clear()

        # release it
        android.release(self.admin)
        android.refresh_from_db()

        self.assertFalse(android.is_active)
        # and FCM ID now kept
        self.assertEqual("FCM111", android.config.get(Channel.CONFIG_FCM_ID))
        self.assertEqual([call(android)], mr_mocks.calls["android_sync"])

        # a sync failure shouldn't prevent the channel being released
        android2 = self.claim_new_android(fcm_id="FCM222", number="0788123124")
        mr_mocks.calls.clear()
        mr_mocks.exception(mailroom.RequestException("android/sync", {}, MockResponse(500, '{"error": "sync failed"}')))
        android2.release(self.admin, interrupt=False)
        android2.refresh_from_db()

        self.assertFalse(android2.is_active)
        self.assertEqual([call(android2)], mr_mocks.calls["android_sync"])

        # a channel without a FCM ID (e.g. registered before FCM) can't be synced so we don't try
        android3 = self.claim_new_android(fcm_id="FCM333", number="0788123125")
        android3.config = {}
        android3.save(update_fields=("config",))
        mr_mocks.calls.clear()

        android3.release(self.admin)
        android3.refresh_from_db()

        self.assertFalse(android3.is_active)
        self.assertEqual([], mr_mocks.calls["android_sync"])

    def test_chart(self):
        chart_url = reverse("channels.channel_chart", args=[self.tel_channel.uuid])

        self.assertRequestDisallowed(chart_url, [None, self.agent, self.admin2])
        self.assertReadFetch(chart_url, [self.editor, self.admin])

        # create some test messages
        test_date = datetime(2020, 1, 20, 0, 0, 0, 0, tzone.utc)
        test_date - timedelta(hours=2)
        bob = self.create_contact("Bob", phone="+250785551212")
        joe = self.create_contact("Joe", phone="+2501234567890")

        with patch("django.utils.timezone.now", return_value=test_date):
            self.create_outgoing_msg(bob, "Hey there Bob", channel=self.tel_channel)
            self.create_incoming_msg(joe, "This incoming message will be counted", channel=self.tel_channel)
            self.create_outgoing_msg(joe, "This outgoing message will be counted", channel=self.tel_channel)

            response = self.requestView(chart_url, self.admin)
            chart = response.json()

            # an entry for each incoming and outgoing
            self.assertEqual(2, len(chart["data"]["datasets"]))

            # one incoming message in the first entry
            self.assertEqual(1, chart["data"]["datasets"][0]["data"][0])

            # two outgoing messages in the second entry
            self.assertEqual(2, chart["data"]["datasets"][1]["data"][0])

    def test_read(self):
        SyncEvent.create(
            self.tel_channel,
            dict(p_sts="CHA", p_src="BAT", p_lvl="60", net="UMTS", pending=[], retry=[]),
            [],
        )
        SyncEvent.create(
            self.tel_channel,
            dict(p_sts="FUL", p_src="AC", p_lvl="100", net="WIFI", pending=[], retry=[]),
            [],
        )
        self.assertEqual(2, SyncEvent.objects.all().count())

        # non-org users can't view our channels
        self.login(self.non_org_user)

        tel_channel_read_url = reverse("channels.channel_read", args=[self.tel_channel.uuid])
        response = self.client.get(tel_channel_read_url)
        self.assertRedirect(response, reverse("orgs.org_choose"))

        self.login(self.editor)

        response = self.client.get(tel_channel_read_url)
        self.assertEqual(f"/settings/channels/{self.tel_channel.uuid}", response.headers[TEMBA_MENU_SELECTION])

        # org users can
        response = self.requestView(tel_channel_read_url, self.editor)

        self.assertTrue(len(response.context["latest_sync_events"]) <= 5)

        response = self.requestView(tel_channel_read_url, self.admin)
        self.assertContains(response, self.tel_channel.name)

        test_date = datetime(2020, 1, 20, 0, 0, 0, 0, tzone.utc)
        two_hours_ago = test_date - timedelta(hours=2)
        # make sure our channel is old enough to trigger alerts
        self.tel_channel.created_on = two_hours_ago
        self.tel_channel.save()

        # delayed sync status
        for sync in SyncEvent.objects.all():
            sync.created_on = two_hours_ago
            sync.save()

        # an outgoing message from a couple of hours ago, which counts in this month's chart below
        bob = self.create_contact("Bob", phone="+250785551212")
        with patch("django.utils.timezone.now", return_value=two_hours_ago):
            self.create_outgoing_msg(bob, "hello", status=Msg.STATUS_QUEUED, channel=self.tel_channel)

        with patch("django.utils.timezone.now", return_value=test_date):
            response = self.requestView(tel_channel_read_url, self.admin)
            self.assertIn("delayed_sync_event", response.context_data.keys())

            # now that we can access the channel, which messages do we display in the chart?
            joe = self.create_contact("Joe", phone="+2501234567890")

            # we have one row for the message stats table
            self.assertEqual(1, len(response.context["monthly_counts"]))
            # only one outgoing message
            self.assertEqual(0, response.context["monthly_counts"][0]["text_in"])
            self.assertEqual(1, response.context["monthly_counts"][0]["text_out"])
            self.assertEqual(0, response.context["monthly_counts"][0]["voice_in"])
            self.assertEqual(0, response.context["monthly_counts"][0]["voice_out"])

            # send messages
            self.create_incoming_msg(joe, "This incoming message will be counted", channel=self.tel_channel)
            self.create_outgoing_msg(joe, "This outgoing message will be counted", channel=self.tel_channel)

            # now we have an inbound message and two outbounds
            response = self.requestView(tel_channel_read_url, self.admin)
            self.assertEqual(200, response.status_code)

            # message stats table have an inbound and two outbounds in the last month
            self.assertEqual(1, len(response.context["monthly_counts"]))
            self.assertEqual(1, response.context["monthly_counts"][0]["text_in"])
            self.assertEqual(2, response.context["monthly_counts"][0]["text_out"])
            self.assertEqual(0, response.context["monthly_counts"][0]["voice_in"])
            self.assertEqual(0, response.context["monthly_counts"][0]["voice_out"])

            # test cases for IVR messaging, make our relayer accept calls
            self.tel_channel.role = "SCAR"
            self.tel_channel.save()

            # now let's create an ivr interaction
            self.create_incoming_msg(joe, "incoming ivr", channel=self.tel_channel, voice=True)
            self.create_outgoing_msg(joe, "outgoing ivr", channel=self.tel_channel, voice=True)
            response = self.requestView(tel_channel_read_url, self.admin)

            self.assertEqual(1, len(response.context["monthly_counts"]))
            self.assertEqual(1, response.context["monthly_counts"][0]["text_in"])
            self.assertEqual(2, response.context["monthly_counts"][0]["text_out"])
            self.assertEqual(1, response.context["monthly_counts"][0]["voice_in"])
            self.assertEqual(1, response.context["monthly_counts"][0]["voice_out"])

            # look at the chart for our messages
            chart_url = reverse("channels.channel_chart", args=[self.tel_channel.uuid])
            response = self.requestView(chart_url, self.admin)

            # incoming, outgoing for both text and our ivr messages
            self.assertEqual(4, len(response.json()["data"]["datasets"]))

        # as staff
        self.requestView(tel_channel_read_url, self.customer_support, checks=[StaffRedirect()])
