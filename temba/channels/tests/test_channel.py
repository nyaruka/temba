from datetime import date, datetime, timedelta, timezone as tzone
from unittest.mock import call, patch

from django_valkey import get_valkey_connection

from django.urls import reverse
from django.utils import timezone
from django.utils.formats import date_format

from temba import mailroom
from temba.notifications.incidents.builtin import ChannelDisconnectedIncidentType
from temba.templates.models import TemplateTranslation
from temba.tests import CRUDLTestMixin, MockResponse, TembaTest, cleanup, mock_mailroom
from temba.tests.crudl import StaffRedirect
from temba.triggers.models import Trigger
from temba.utils import json
from temba.utils.views.mixins import TEMBA_MENU_SELECTION

from ..models import COURIER_QUEUE_STATE_KEY, Channel, ChannelTally, SyncEvent
from ..views import ChannelCRUDL


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
        self.assertRedirect(response, "/channels/channel/")

        android.refresh_from_db()
        return android

    def test_deactivate(self):
        self.login(self.admin)
        self.tel_channel.is_active = False
        self.tel_channel.save()
        response = self.client.get(reverse("channels.channel_read", args=[self.tel_channel.uuid]))
        self.assertEqual(404, response.status_code)

    def test_get_speed(self):
        def speed(tps, is_enabled=True):
            self.channel.tps = tps
            self.channel.is_enabled = is_enabled
            return self.channel.get_speed()

        self.assertIsNone(speed(10))
        self.assertEqual("slow", speed(9))
        self.assertEqual("slow", speed(2))
        self.assertEqual("very_slow", speed(1))
        self.assertIsNone(speed(1, is_enabled=False))

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
        # TPS defaults to the value for the channel type, or the default if it has none
        channel = Channel.create(self.org, self.admin, "KE", "AT", None, "+254788123123")
        self.assertEqual(10, channel.tps)

        channel = Channel.create(self.org, self.admin, None, "KWA", None, "1234")
        self.assertEqual(45, channel.tps)

        # unless one is given
        channel = Channel.create(self.org, self.admin, None, "KWA", None, "2345", tps=20)
        self.assertEqual(20, channel.tps)

        # which must be positive
        with self.assertRaises(AssertionError):
            Channel.create(self.org, self.admin, None, "KWA", None, "3456", tps=0)

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

        self.org.org_tallies.create(scope="msgs/text:in@2026-11-03", count=7)
        channel1.tallies.create(scope="text:in@2026-11-04", count=1)
        channel2.tallies.create(scope="text:in@2026-11-04", count=2)

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
        self.assertEqual({"msgs/text:in@2026-11-03"}, set(self.org.org_tallies.values_list("scope", flat=True)))
        self.assertEqual(
            {(channel2.id, "text:in@2026-11-04")}, set(ChannelTally.objects.values_list("channel", "scope"))
        )

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

    def test_activity(self):
        activity_url = reverse("channels.channel_activity", args=[self.tel_channel.uuid])

        self.assertRequestDisallowed(activity_url, [None, self.agent, self.admin2])
        self.assertReadFetch(activity_url, [self.editor, self.admin])

        self.tel_channel.created_on = datetime(2019, 6, 1, 0, 0, 0, 0, tzone.utc)
        self.tel_channel.save(update_fields=("created_on",))

        self.create_channel_tally(self.tel_channel, "text:out", date(2020, 1, 18), 3)
        self.create_channel_tally(self.tel_channel, "text:in", date(2020, 1, 20), 1)
        self.create_channel_tally(self.tel_channel, "text:out", date(2020, 1, 20), 2)
        self.create_channel_tally(self.tel_channel, "text:out", date(2019, 12, 1), 5)
        self.create_channel_tally(self.facebook_channel, "text:out", date(2020, 1, 20), 4)  # other channel

        with patch("django.utils.timezone.now", return_value=datetime(2020, 1, 20, 0, 0, 0, 0, tzone.utc)):
            response = self.requestView(activity_url, self.admin)

            # the chart has every day of the year that can be browsed and the year before it, oldest first
            chart = json.loads(response.context["chart"])
            self.assertEqual(731, len(chart["days"]))
            self.assertEqual("2020-01-20", chart["days"][-1])
            self.assertEqual(["Outgoing", "Incoming"], [s["label"] for s in chart["series"]])
            self.assertEqual([3, 0, 2], chart["series"][0]["values"][-3:])
            self.assertEqual([0, 0, 1], chart["series"][1]["values"][-3:])
            self.assertEqual(10, sum(chart["series"][0]["values"]))

            # monthly counts, most recent first, with each month's share of the busiest
            self.assertFalse(response.context["has_voice"])
            months = response.context["monthly_counts"]
            self.assertEqual(date(2020, 1, 1), months[0]["month_start"])
            self.assertEqual((1, 5, 6, 100), tuple(months[0][k] for k in ("text_in", "text_out", "total", "share")))
            self.assertEqual(date(2019, 12, 1), months[1]["month_start"])
            self.assertEqual(83, months[1]["share"])
            self.assertContains(response, 'class="activity-share"', count=2)  # empty months get no bar

            # voice counts get columns of their own
            self.create_channel_tally(self.tel_channel, "voice:in", date(2020, 1, 20), 6)

            response = self.requestView(activity_url, self.admin)
            self.assertTrue(response.context["has_voice"])
            self.assertEqual(6, response.context["monthly_counts"][0]["voice_in"])

            # calls only get columns on channels which can make or answer them
            self.create_channel_tally(self.tel_channel, "calls:in", date(2020, 1, 20), 2)
            self.create_channel_tally(self.tel_channel, "calls:out", date(2020, 1, 20), 3)

            response = self.requestView(activity_url, self.admin)
            self.assertFalse(response.context["has_calls"])
            self.assertNotContains(response, "Incoming Calls")

            self.tel_channel.role = Channel.DEFAULT_ROLE + Channel.ROLE_CALL + Channel.ROLE_ANSWER
            self.tel_channel.save(update_fields=("role",))

            # and as they aren't messages, they aren't charted or in the totals
            response = self.requestView(activity_url, self.admin)
            self.assertTrue(response.context["has_calls"])
            self.assertContains(response, "Incoming Calls")
            month = response.context["monthly_counts"][0]
            self.assertEqual((6, 2, 3, 12), tuple(month[k] for k in ("voice_in", "calls_in", "calls_out", "total")))
            self.assertEqual([0, 0, 7], json.loads(response.context["chart"])["series"][1]["values"][-3:])

    def test_activity_history_limits(self):
        activity_url = reverse("channels.channel_activity", args=[self.tel_channel.uuid])

        self.tel_channel.created_on = datetime(2024, 3, 15, 0, 0, 0, 0, tzone.utc)
        self.tel_channel.save(update_fields=("created_on",))

        with patch("django.utils.timezone.now", return_value=datetime(2026, 1, 20, 0, 0, 0, 0, tzone.utc)):
            response = self.requestView(activity_url, self.admin)

            # the period can't go back more than a year, and monthly counts are only for the last 13 months
            self.assertEqual(date(2025, 1, 20), response.context["chart_min"])
            self.assertEqual(13, len(response.context["monthly_counts"]))
            self.assertEqual(date(2026, 1, 1), response.context["monthly_counts"][0]["month_start"])
            self.assertEqual(date(2025, 1, 1), response.context["monthly_counts"][-1]["month_start"])

        with patch("django.utils.timezone.now", return_value=datetime(2024, 5, 20, 0, 0, 0, 0, tzone.utc)):
            response = self.requestView(activity_url, self.admin)

            # but are limited by the age of the channel
            self.assertEqual(date(2024, 3, 15), response.context["chart_min"])
            self.assertEqual(3, len(response.context["monthly_counts"]))

    @cleanup(valkey=True)
    def test_read_send_paused(self):
        read_url = reverse("channels.channel_read", args=[self.tel_channel.uuid])
        r = get_valkey_connection()
        state_key = COURIER_QUEUE_STATE_KEY % self.tel_channel.uuid

        # no queue state for this channel
        response = self.requestView(read_url, self.admin)
        self.assertFalse(response.context["send_paused"])
        self.assertEqual("Ready", response.context["status"]["value"])
        self.assertNotContains(response, "Sending is paused")

        # throttled by its TPS but not paused
        r.hset(state_key, mapping={"tps": 10, "sec": 1579478400, "used": 10})
        self.assertFalse(self.tel_channel.is_send_paused())

        with patch("django.utils.timezone.now", return_value=datetime(2020, 1, 20, 0, 0, 0, 0, tzone.utc)):
            # paused until a few seconds from now
            r.hset(state_key, "paused_until", "1579478410.5")
            self.assertTrue(self.tel_channel.is_send_paused())

            response = self.requestView(read_url, self.admin)
            self.assertTrue(response.context["send_paused"])
            self.assertEqual(
                {"tone": "bad", "value": "Paused", "sheet": "logs", "more": "View logs"},
                {k: str(v) for k, v in response.context["status"].items() if k != "note"},
            )
            self.assertContains(response, "Sending is paused")

            # a disabled channel shows as that whether or not it's paused
            self.tel_channel.is_enabled = False
            self.tel_channel.save(update_fields=("is_enabled",))

            response = self.requestView(read_url, self.admin)
            self.assertFalse(response.context["send_paused"])
            self.assertEqual("Disabled", response.context["status"]["value"])
            self.assertNotContains(response, "Sending is paused")

            # pause ended recently so still counts
            r.hset(state_key, "paused_until", "1579478370")
            self.assertTrue(self.tel_channel.is_send_paused())

            # pause ended over a minute ago
            r.hset(state_key, "paused_until", "1579478330")
            self.assertFalse(self.tel_channel.is_send_paused())

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
        self.assertEqual("/settings/channels", response.headers[TEMBA_MENU_SELECTION])

        # org users can
        response = self.requestView(tel_channel_read_url, self.editor)
        self.assertContains(response, self.tel_channel.name)

        # an Android channel shows its phone and can open its syncs, but has no logs, setup or templates
        self.assertEqual(100, response.context["last_sync"].power_level)
        self.assertEqual({"activity", "syncs"}, set(response.context["sheets"]))

        # it hasn't sent anything to have failed, so has no failures card, just the messages card
        self.assertNotIn("failures", response.context)
        self.assertContains(response, "Messages · 30 days")

        test_date = datetime(2020, 1, 20, 0, 0, 0, 0, tzone.utc)
        two_hours_ago = test_date - timedelta(hours=2)
        # make sure our channel is old enough to trigger alerts
        self.tel_channel.created_on = two_hours_ago
        self.tel_channel.save()

        # delayed sync status
        for sync in SyncEvent.objects.all():
            sync.created_on = two_hours_ago
            sync.save()

        self.create_channel_tally(self.tel_channel, "text:out", date(2020, 1, 19), 1)
        self.create_channel_tally(self.tel_channel, "text:in", date(2020, 1, 20), 2)

        with patch("django.utils.timezone.now", return_value=test_date):
            response = self.requestView(tel_channel_read_url, self.admin)
            self.assertTrue(response.context["delayed_sync"])
            self.assertEqual("Not syncing", response.context["status"]["value"])
            self.assertEqual("syncs", response.context["status"]["sheet"])

            # messages over the last 30 days
            activity = response.context["activity"]
            self.assertEqual((2, 1, 3), (activity["received"], activity["sent"], activity["total"]))
            self.assertEqual([1, 2], activity["series"][-2:])

        # as staff
        self.requestView(tel_channel_read_url, self.customer_support, checks=[StaffRedirect()])

    def test_read_statuses(self):
        read_url = reverse("channels.channel_read", args=[self.facebook_channel.uuid])

        # a Facebook channel has no setup to send people to, so its status leads to its logs
        response = self.requestView(read_url, self.admin)
        self.assertEqual(
            ("good", "Ready", "logs"), tuple(str(response.context["status"][k]) for k in ("tone", "value", "sheet"))
        )

        # a channel with setup is waiting until it's received something, and leads to its setup either way
        vonage = self.create_channel("NX", "Vonage", "+12065551212", country="US")
        read_url = reverse("channels.channel_read", args=[vonage.uuid])

        response = self.requestView(read_url, self.admin)
        self.assertEqual(
            ("warn", "Waiting", "setup"), tuple(str(response.context["status"][k]) for k in ("tone", "value", "sheet"))
        )

        # unless it's failing what it sends, which is the bigger problem, though the card still says it's waiting
        yesterday = timezone.now().date() - timedelta(days=1)
        self.create_channel_tally(vonage, "text:out", yesterday, 16)
        self.create_channel_tally(vonage, "text:failed", yesterday, 16)
        response = self.requestView(read_url, self.admin)
        self.assertEqual(
            (
                "Unhealthy",
                f"100% of the 16 messages sent since {date_format(yesterday, 'MONTH_DAY_FORMAT')} have failed. "
                "Nothing has been received from the provider yet.",
            ),
            tuple(str(response.context["status"][k]) for k in ("value", "note")),
        )
        vonage.tallies.all().delete()

        self.create_channel_tally(vonage, "text:in", timezone.now().date(), 1)

        response = self.requestView(read_url, self.admin)
        self.assertEqual(
            ("good", "Ready", "setup"), tuple(str(response.context["status"][k]) for k in ("tone", "value", "sheet"))
        )

        # a channel which only sends never waits to receive
        send_only = self.create_channel("NX", "Send Only", "+12065551213", country="US", role=Channel.ROLE_SEND)
        response = self.requestView(reverse("channels.channel_read", args=[send_only.uuid]), self.admin)
        self.assertEqual("Ready", str(response.context["status"]["value"]))

        # one which has sent and failed too few to judge isn't failing, however many of them failed
        today = timezone.now().date()
        yesterday, day10 = today - timedelta(days=1), today - timedelta(days=10)
        self.create_channel_tally(self.facebook_channel, "text:out", day10, 2)
        self.create_channel_tally(self.facebook_channel, "text:failed", day10, 2)

        def since(day) -> str:
            return date_format(day, "MONTH_DAY_FORMAT")

        fb_read_url = reverse("channels.channel_read", args=[self.facebook_channel.uuid])
        response = self.requestView(fb_read_url, self.admin)
        self.assertEqual("Ready", str(response.context["status"]["value"]))

        # but enough failures are worth judging however few were sent
        self.facebook_channel.tallies.update(count=3)
        response = self.requestView(fb_read_url, self.admin)
        self.assertEqual(
            ("Unhealthy", f"100% of the 3 messages sent since {since(day10)} have failed."),
            tuple(str(response.context["status"][k]) for k in ("value", "note")),
        )

        # one which failed most of what it last sent is failing, however long ago that was, which it says, and leads to
        # its logs
        self.facebook_channel.tallies.filter(scope__endswith=day10.isoformat()).update(count=100)
        self.facebook_channel.tallies.filter(scope__startswith="text:failed@").update(count=80)

        def assert_status(tone, value, note):
            response = self.requestView(fb_read_url, self.admin)
            self.assertEqual(
                (tone, value, "logs", note),
                tuple(str(response.context["status"][k]) for k in ("tone", "value", "sheet", "note")),
            )

        assert_status("bad", "Unhealthy", f"80% of the 100 messages sent since {since(day10)} have failed.")

        # today's sends aren't judged with them, as failures follow their sends by minutes, so a big send today that's
        # failing much less shows it's recovering, still leading to its logs
        self.create_channel_tally(self.facebook_channel, "text:out", today, 5_000)
        self.create_channel_tally(self.facebook_channel, "text:failed", today, 100)
        assert_status(
            "warn",
            "Recovering",
            f"2% of the 5,000 messages sent today have failed, down from 80% of the 100 sent since {since(day10)}.",
        )

        # which says so when none of today's have failed, and rounds up so a few failures don't read as none
        self.facebook_channel.tallies.filter(scope=f"text:failed@{today.isoformat()}").delete()
        assert_status(
            "warn",
            "Recovering",
            f"None of the 5,000 messages sent today have failed, after 80% of the 100 sent since {since(day10)} did.",
        )
        self.create_channel_tally(self.facebook_channel, "text:failed", today, 1)
        assert_status(
            "warn",
            "Recovering",
            f"1% of the 5,000 messages sent today have failed, down from 80% of the 100 sent since {since(day10)}.",
        )

        # but not if today's are failing too
        self.facebook_channel.tallies.filter(scope=f"text:failed@{today.isoformat()}").update(count=1_000)
        assert_status("bad", "Unhealthy", f"80% of the 100 messages sent since {since(day10)} have failed.")

        # nor if too few have been sent today to tell
        self.facebook_channel.tallies.filter(scope__endswith=today.isoformat()).delete()
        self.create_channel_tally(self.facebook_channel, "text:out", today, 19)
        assert_status("bad", "Unhealthy", f"80% of the 100 messages sent since {since(day10)} have failed.")
        self.facebook_channel.tallies.filter(scope__endswith=today.isoformat()).delete()

        # but enough sends since do, as they're all that's judged
        self.create_channel_tally(self.facebook_channel, "text:out", yesterday, 1_000)
        self.create_channel_tally(self.facebook_channel, "text:failed", yesterday, 150)
        assert_status("bad", "Degraded", f"15% of the 1,000 messages sent since {since(yesterday)} have failed.")

        self.facebook_channel.tallies.filter(scope=f"text:failed@{yesterday.isoformat()}").update(count=50)
        response = self.requestView(fb_read_url, self.admin)
        self.assertEqual("Ready", str(response.context["status"]["value"]))  # 5% isn't worth flagging

        # and once enough have been sent, what was sent before that isn't judged, however badly it went
        self.create_channel_tally(self.facebook_channel, "text:out", today - timedelta(days=3), 100)
        self.create_channel_tally(self.facebook_channel, "text:failed", today - timedelta(days=3), 100)
        self.assertEqual((50, 1_000, yesterday, 0, 0), self.facebook_channel.get_recent_failures())
        self.facebook_channel.tallies.filter(scope__endswith=(today - timedelta(days=3)).isoformat()).delete()
        response = self.requestView(fb_read_url, self.admin)

        # the failures card covers the last 30 days, by day for its sparkline, leads to the logs, and is red from the
        # rate that makes a channel degraded
        failures = response.context["failures"]
        self.assertEqual(
            (30, 1_100, 130, "12%", "bad"),
            (failures["days"], failures["sent"], failures["failed"], failures["rate"], failures["tone"]),
        )
        self.assertEqual([80.0, 5.0, 0], [failures["series"][-11], failures["series"][-2], failures["series"][-1]])
        self.assertContains(response, "130 of 1,100 sent")
        self.assertNotContains(response, "Messages · 30 days")  # which it takes the place of
        self.assertNotContains(response, "{#")  # template comments only span one line

        # unless the channel is failing on sends older than that, when it reaches back to them as the evidence
        quiet = self.create_channel("NX", "Quiet", "+12065551217", country="US", role=Channel.ROLE_SEND)
        self.create_channel_tally(quiet, "text:out", today - timedelta(days=44), 100)
        self.create_channel_tally(quiet, "text:failed", today - timedelta(days=44), 80)
        response = self.requestView(reverse("channels.channel_read", args=[quiet.uuid]), self.admin)
        self.assertEqual(
            f"80% of the 100 messages sent since {since(today - timedelta(days=44))} have failed.",
            str(response.context["status"]["note"]),
        )
        failures = response.context["failures"]
        self.assertEqual(
            (45, 100, 80, 45), (failures["days"], failures["sent"], failures["failed"], len(failures["series"]))
        )
        self.assertContains(response, "Failures · 45 days")

        # nor does one older than its counts go back
        old = self.create_channel("NX", "Old", "+12065551214", country="US")
        old.created_on = timezone.now() - timedelta(days=500)
        old.save(update_fields=("created_on",))
        response = self.requestView(reverse("channels.channel_read", args=[old.uuid]), self.admin)
        self.assertEqual("Ready", str(response.context["status"]["value"]))

        # a channel that's slow to send is only pointed out to workspaces big enough for it to matter
        vonage.tps = 1
        vonage.save(update_fields=("tps",))
        response = self.requestView(read_url, self.admin)
        self.assertEqual("Ready", str(response.context["status"]["value"]))

        def assert_speed(value, note):
            response = self.requestView(read_url, self.admin)
            self.assertEqual(
                ("warn", value, note), tuple(str(response.context["status"][k]) for k in ("tone", "value", "note"))
            )

        with patch.object(Channel, "SPEED_MIN_CONTACTS", -1):
            # where it says so in amber however slow, as red is kept for problems with its health
            assert_speed("Very slow", "Sends 1 message a second, so a broadcast to 100k contacts takes about a day.")

            vonage.tps = 5
            vonage.save(update_fields=("tps",))
            assert_speed("Slow", "Sends 5 messages a second, so a broadcast to 100k contacts takes about 6 hours.")

            # but a problem with its health takes its place
            self.create_channel_tally(vonage, "text:out", yesterday, 100)
            self.create_channel_tally(vonage, "text:failed", yesterday, 60)
            response = self.requestView(read_url, self.admin)
            self.assertEqual("Unhealthy", str(response.context["status"]["value"]))

        # below that the failures card is neutral, and below a small share left off as nothing to look into
        rates_url = reverse("channels.channel_read", args=[send_only.uuid])
        self.create_channel_tally(send_only, "text:out", timezone.now().date(), 1_000)
        self.create_channel_tally(send_only, "text:failed", timezone.now().date(), 5)
        response = self.requestView(rates_url, self.admin)
        self.assertNotIn("failures", response.context)

        send_only.tallies.filter(scope__startswith="text:failed@").update(count=50)
        response = self.requestView(rates_url, self.admin)
        self.assertEqual(("5.0%", ""), (response.context["failures"]["rate"], response.context["failures"]["tone"]))

        # a channel which only receives has no failures card
        receive_only = self.create_channel(
            "NX", "Receive Only", "+12065551215", country="US", role=Channel.ROLE_RECEIVE
        )
        response = self.requestView(reverse("channels.channel_read", args=[receive_only.uuid]), self.admin)
        self.assertNotIn("failures", response.context)

    def test_format_rate(self):
        rate = ChannelCRUDL.Read.format_rate

        self.assertEqual("0%", rate(0))
        self.assertEqual("<0.1%", rate(0.0004))
        self.assertEqual("4.2%", rate(0.0421))
        self.assertEqual("38%", rate(0.384))
        self.assertEqual("100%", rate(1.2))

    def test_rough_duration(self):
        duration = ChannelCRUDL.Read.get_rough_duration

        self.assertEqual("a minute", duration(30))
        self.assertEqual("8 minutes", duration(500))
        self.assertEqual("20 minutes", duration(1250))
        self.assertEqual("an hour", duration(3600))
        self.assertEqual("3 hours", duration(10_000))
        self.assertEqual("a day", duration(100_000))
        self.assertEqual("2 days", duration(200_000))

    def test_syncs(self):
        syncs_url = reverse("channels.channel_syncs", args=[self.tel_channel.uuid])

        self.assertRequestDisallowed(syncs_url, [None, self.agent, self.admin2])

        SyncEvent.create(
            self.tel_channel, dict(p_sts="CHA", p_src="BAT", p_lvl="60", net="UMTS", pending=[], retry=[]), []
        )
        response = self.assertReadFetch(syncs_url, [self.editor, self.admin])
        self.assertEqual(1, len(response.context["sync_events"]))

        # only Android channels sync with a phone
        self.assertRequestDisallowed(reverse("channels.channel_syncs", args=[self.facebook_channel.uuid]), [self.admin])

    def test_templates(self):
        wac = self.create_channel("WAC", "WhatsApp", "1234", config={"wa_waba_id": "1234"})
        templates_url = reverse("channels.channel_templates", args=[wac.uuid])

        self.assertRequestDisallowed(templates_url, [None, self.agent, self.admin2])

        self.create_template(
            "hello",
            [
                TemplateTranslation(
                    channel=wac,
                    locale="eng-US",
                    status=TemplateTranslation.STATUS_APPROVED,
                    external_id="1234",
                    external_locale="en_US",
                ),
                TemplateTranslation(
                    channel=wac,
                    locale="spa",
                    status=TemplateTranslation.STATUS_REJECTED,
                    external_id="1235",
                    external_locale="es",
                ),
            ],
        )
        response = self.assertReadFetch(templates_url, [self.editor, self.admin])
        self.assertEqual(2, len(response.context["translations"]))
        self.assertIsNone(response.context["last_sync"])

        # its page summarizes them, noting the ones which aren't approved
        response = self.requestView(reverse("channels.channel_read", args=[wac.uuid]), self.admin)
        self.assertEqual(1, response.context["templates"]["approved"])
        self.assertEqual(2, response.context["templates"]["total"])
        self.assertEqual(["1 rejected"], response.context["templates"]["others"])
        self.assertIn("templates", response.context["sheets"])

        # only types with templates have them
        self.assertRequestDisallowed(
            reverse("channels.channel_templates", args=[self.facebook_channel.uuid]), [self.admin]
        )
