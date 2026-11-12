from datetime import date, datetime, timedelta, timezone as tzone
from unittest.mock import call, patch

from django_valkey import get_valkey_connection

from django.urls import reverse
from django.utils import timezone

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

        self.assertIsNone(speed(None))  # no limit
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
        # TPS defaults to the value for the channel type
        channel = Channel.create(self.org, self.admin, "KE", "AT", None, "+254788123123")
        self.assertIsNone(channel.tps)

        channel = Channel.create(self.org, self.admin, None, "KWA", None, "1234")
        self.assertEqual(45, channel.tps)

        # unless one is given
        channel = Channel.create(self.org, self.admin, None, "KWA", None, "2345", tps=20)
        self.assertEqual(20, channel.tps)

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

        channel1_id = channel1.id
        self.org.org_tallies.create(scope=f"channels/{channel1_id}/text:in@2026-11-03", count=3)
        self.org.org_tallies.create(scope=f"channels/{channel2.id}/text:in@2026-11-03", count=4)
        self.org.org_tallies.create(scope=f"channels/{channel1_id}0/text:in@2026-11-03", count=5)
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
        self.assertEqual(
            {
                f"channels/{channel2.id}/text:in@2026-11-03",
                f"channels/{channel1_id}0/text:in@2026-11-03",
                "msgs/text:in@2026-11-03",
            },
            set(self.org.org_tallies.values_list("scope", flat=True)),
        )
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

            # voice counts get columns of their own
            self.create_channel_tally(self.tel_channel, "voice:in", date(2020, 1, 20), 6)

            response = self.requestView(activity_url, self.admin)
            self.assertTrue(response.context["has_voice"])
            self.assertEqual(6, response.context["monthly_counts"][0]["voice_in"])

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

        # with the default limit, it sends at 10 a second, so a broadcast to 100k takes about 3 hours
        self.assertEqual(
            {"tps": 10, "duration": "3 hours", "tone": ""},
            {k: response.context["speed"][k] for k in ("tps", "duration", "tone")},
        )

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

        self.create_channel_tally(vonage, "text:in", timezone.now().date(), 1)

        response = self.requestView(read_url, self.admin)
        self.assertEqual(
            ("good", "Ready", "setup"), tuple(str(response.context["status"][k]) for k in ("tone", "value", "sheet"))
        )

        # a very slow channel's speed is a problem, a slow one worth a look
        vonage.tps = 1
        vonage.save(update_fields=("tps",))
        response = self.requestView(read_url, self.admin)
        self.assertEqual(("bad", "a day"), (response.context["speed"]["tone"], response.context["speed"]["duration"]))

        vonage.tps = 5
        vonage.save(update_fields=("tps",))
        response = self.requestView(read_url, self.admin)
        self.assertEqual(
            ("warn", "6 hours"), (response.context["speed"]["tone"], response.context["speed"]["duration"])
        )

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
            ],
        )
        response = self.assertReadFetch(templates_url, [self.editor, self.admin])
        self.assertEqual(1, len(response.context["translations"]))
        self.assertIsNone(response.context["last_sync"])

        # its page summarizes them
        response = self.requestView(reverse("channels.channel_read", args=[wac.uuid]), self.admin)
        self.assertEqual(1, response.context["templates"]["approved"])
        self.assertIn("templates", response.context["sheets"])

        # only types with templates have them
        self.assertRequestDisallowed(
            reverse("channels.channel_templates", args=[self.facebook_channel.uuid]), [self.admin]
        )
