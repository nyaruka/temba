import base64
import hashlib
import hmac
import time
from datetime import datetime, timedelta, timezone as tzone
from unittest.mock import call, patch
from urllib.parse import quote

from django.urls import reverse
from django.utils import timezone
from django.utils.encoding import force_bytes

from temba.apks.models import Apk
from temba.contacts.models import URN, Contact
from temba.msgs.models import Msg
from temba.notifications.incidents.builtin import ChannelDisconnectedIncidentType, ChannelOutdatedAppIncidentType
from temba.notifications.models import Incident
from temba.templates.models import TemplateTranslation
from temba.tests import CRUDLTestMixin, MockResponse, TembaTest, mock_mailroom
from temba.tests.crudl import StaffRedirect
from temba.triggers.models import Trigger
from temba.utils import json
from temba.utils.models import generate_uuid
from temba.utils.views.mixins import TEMBA_MENU_SELECTION

from ..models import Channel, ChannelEvent, SyncEvent
from ..tasks import trim_channel_sync_events


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
        cmds = [dict(cmd="fcm", fcm_id=fcm_id, uuid="uuid"), dict(cmd="status", cc="RW", dev="Nexus")]
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

    def assertHasCommand(self, cmd_name, response):
        self.assertEqual(200, response.status_code)
        data = response.json()

        for cmd in data["cmds"]:
            if cmd["cmd"] == cmd_name:
                return

        raise Exception("Did not find '%s' cmd in response: '%s'" % (cmd_name, response.content))

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

    def test_ensure_normalization(self):
        self.tel_channel.country = "RW"
        self.tel_channel.save()

        contact1 = self.create_contact("contact1", phone="0788111222")
        contact2 = self.create_contact("contact2", phone="+250788333444")
        contact3 = self.create_contact("contact3", phone="+18006927753")

        self.org.normalize_contact_tels()

        norm_c1 = Contact.objects.get(pk=contact1.pk)
        norm_c2 = Contact.objects.get(pk=contact2.pk)
        norm_c3 = Contact.objects.get(pk=contact3.pk)

        self.assertEqual(norm_c1.get_urn(URN.TEL_SCHEME).path, "+250788111222")
        self.assertEqual(norm_c2.get_urn(URN.TEL_SCHEME).path, "+250788333444")
        self.assertEqual(norm_c3.get_urn(URN.TEL_SCHEME).path, "+18006927753")

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
        channel2 = Channel.create(self.org, self.admin, "", "T", "Test Channel", "0785553333")

        # add channel trigger
        flow = self.create_flow("Test")
        Trigger.create(self.org, self.admin, Trigger.TYPE_CATCH_ALL, flow, channel=channel1)

        # create some activity on this channel
        contact = self.create_contact("Bob", phone="+593979123456")
        self.create_incoming_msg(contact, "Hi", channel=channel1)
        self.create_outgoing_msg(contact, "Hi", channel=channel1, status="P")
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

    @mock_mailroom
    def test_release_facebook(self, mr_mocks):
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

        # release it
        android.release(self.admin)
        android.refresh_from_db()

        response = self.sync(android, cmds=[])
        self.assertEqual(200, response.status_code)

        # should be a rel cmd to instruct app to reset
        self.assertEqual({"cmds": [{"cmd": "rel", "relayer_id": str(android.id)}]}, response.json())

        self.assertFalse(android.is_active)
        # and FCM ID now kept
        self.assertEqual("FCM111", android.config.get(Channel.CONFIG_FCM_ID))

    def sync(self, channel, *, cmds, signature=None, auto_add_fcm=True):
        # prepend FCM command if not included
        if auto_add_fcm and (not cmds or cmds[0]["cmd"] != "fcm"):
            cmds = [{"cmd": "fcm", "fcm_id": "3256262", "uuid": str(channel.uuid), "p_id": 1}] + cmds

        post_data = json.dumps({"cmds": cmds})
        ts = int(time.time())

        if not signature:
            # sign the request
            key = str(channel.secret) + str(ts)
            signature = hmac.new(key=force_bytes(key), msg=force_bytes(post_data), digestmod=hashlib.sha256).digest()

            # base64 and url sanitize
            signature = quote(base64.urlsafe_b64encode(signature))

        return self.client.post(
            "%s?signature=%s&ts=%d" % (reverse("sync", args=[channel.id]), signature, ts),
            content_type="application/json",
            data=post_data,
        )

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
        # now send the channel's updates
        self.sync(
            self.tel_channel,
            cmds=[
                # device details status
                dict(cmd="status", p_sts="CHA", p_src="BAT", p_lvl="60", net="UMTS", pending=[], retry=[])
            ],
        )

        # now send the channel's updates
        self.sync(
            self.tel_channel,
            cmds=[
                # device details status
                dict(cmd="status", p_sts="FUL", p_src="AC", p_lvl="100", net="WIFI", pending=[], retry=[])
            ],
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

        bob = self.create_contact("Bob", phone="+250785551212")

        # add a message, just sent so shouldn't be delayed
        with patch("django.utils.timezone.now", return_value=two_hours_ago):
            self.create_outgoing_msg(bob, "delayed message", status=Msg.STATUS_QUEUED, channel=self.tel_channel)

        with patch("django.utils.timezone.now", return_value=test_date):
            response = self.requestView(tel_channel_read_url, self.admin)
            self.assertIn("delayed_sync_event", response.context_data.keys())
            self.assertIn("unsent_msgs_count", response.context_data.keys())

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

    def test_invalid(self):
        # Must be POST
        response = self.client.get(
            "%s?signature=sig&ts=123" % (reverse("sync", args=[100])), content_type="application/json"
        )
        self.assertEqual(500, response.status_code)

        # Unknown channel
        response = self.client.post(
            "%s?signature=sig&ts=123" % (reverse("sync", args=[999])), content_type="application/json"
        )
        self.assertEqual(200, response.status_code)
        self.assertEqual("rel", response.json()["cmds"][0]["cmd"])

        # too old
        ts = int(time.time()) - 60 * 16
        response = self.client.post(
            "%s?signature=sig&ts=%d" % (reverse("sync", args=[self.tel_channel.pk]), ts),
            content_type="application/json",
        )
        self.assertEqual(401, response.status_code)
        self.assertEqual(3, response.json()["error_id"])

        # missing initial FCM command
        response = self.sync(self.tel_channel, cmds=[], auto_add_fcm=False)
        self.assertEqual(401, response.status_code)
        self.assertEqual(4, response.json()["error_id"])

    def test_sync_unclaimed(self):
        response = self.sync(self.unclaimed_channel, cmds=[])
        self.assertEqual(401, response.status_code)

        # should be an error response
        self.assertEqual({"error": "Can't sync unclaimed channel", "error_id": 4, "cmds": []}, response.json())

        self.unclaimed_channel.secret = "12345674674"
        self.unclaimed_channel.uuid = generate_uuid()
        self.unclaimed_channel.claim_code = "ABCDEFGH9"
        self.unclaimed_channel.save(update_fields=("secret", "uuid", "claim_code"))

        response = self.sync(self.unclaimed_channel, cmds=[])
        self.assertEqual(200, response.status_code)

        response_json = response.json()
        self.assertEqual(
            response_json,
            dict(
                cmds=[
                    dict(
                        cmd="reg",
                        relayer_claim_code="ABCDEFGH9",
                        relayer_secret="12345674674",
                        relayer_id=self.unclaimed_channel.pk,
                    )
                ]
            ),
        )

        # Not matching UUID should be an error
        response = self.sync(
            self.unclaimed_channel,
            cmds=[{"cmd": "fcm", "fcm_id": "3256262", "uuid": str(generate_uuid()), "p_id": 1}],
            auto_add_fcm=False,
        )
        self.assertEqual(401, response.status_code)

        # should be an error response
        self.assertEqual({"error": "Can't sync unclaimed channel", "error_id": 4, "cmds": []}, response.json())

    @mock_mailroom
    def test_sync_client_reset(self, mr_mocks):
        android = self.claim_new_android()

        response = self.sync(android, cmds=[{"cmd": "reset"}])
        self.assertEqual(200, response.status_code)

        android.refresh_from_db()
        self.assertFalse(android.is_active)

    def test_sync_broadcast_multiple_channels(self):
        channel2 = Channel.create(
            self.org,
            self.admin,
            "RW",
            "A",
            name="Test Channel 2",
            address="+250785551313",
            role="SR",
            secret="12367",
            config={Channel.CONFIG_FCM_ID: "456"},
        )

        contact1 = self.create_contact("John Doe", phone="250788382382")
        contact2 = self.create_contact("John Doe", phone="250788383383")

        contact1_urn = contact1.get_urn()
        contact1_urn.channel = self.tel_channel
        contact1_urn.save()

        contact2_urn = contact2.get_urn()
        contact2_urn.channel = channel2
        contact2_urn.save()

        # send a broadcast to urns that have different preferred channels
        self.create_outgoing_msg(contact1, "How is it going?", status=Msg.STATUS_QUEUED)
        self.create_outgoing_msg(contact2, "How is it going?", status=Msg.STATUS_QUEUED)

        # should contain messages for the channel only
        response = self.sync(self.tel_channel, cmds=[])
        self.assertEqual(200, response.status_code)

        self.tel_channel.refresh_from_db()

        response = response.json()
        cmds = response["cmds"]
        self.assertEqual(1, len(cmds))
        self.assertEqual(len(cmds[0]["to"]), 1)
        self.assertEqual(cmds[0]["to"][0]["phone"], "+250788382382")

        # Should contain messages for the channel only
        response = self.sync(channel2, cmds=[])
        self.assertEqual(200, response.status_code)

        channel2.refresh_from_db()

        response = response.json()
        cmds = response["cmds"]
        self.assertEqual(1, len(cmds))
        self.assertEqual(len(cmds[0]["to"]), 1)
        self.assertEqual(cmds[0]["to"][0]["phone"], "+250788383383")

    @mock_mailroom
    def test_sync(self, mr_mocks):
        date = timezone.now()
        date = int(time.mktime(date.timetuple())) * 1000

        Apk.objects.create(apk_type=Apk.TYPE_RELAYER, version="1.0.0")

        contact1 = self.create_contact("Ann", phone="+250788382382")
        contact2 = self.create_contact("Bob", phone="+250788383383")

        # create a payload from the client
        msg1 = self.create_outgoing_msg(
            contact1, "How is it going?", channel=self.tel_channel, status=Msg.STATUS_QUEUED
        )
        msg2 = self.create_outgoing_msg(
            contact2, "How is it going?", channel=self.tel_channel, status=Msg.STATUS_QUEUED
        )
        msg3 = self.create_outgoing_msg(
            contact2, "What is your name?", channel=self.tel_channel, status=Msg.STATUS_QUEUED
        )
        msg4 = self.create_outgoing_msg(
            contact2, "Do you have any children?", channel=self.tel_channel, status=Msg.STATUS_QUEUED
        )
        msg5 = self.create_outgoing_msg(
            contact2, "What's my dog's name?", channel=self.tel_channel, status=Msg.STATUS_QUEUED
        )
        msg6 = self.create_outgoing_msg(contact2, "from when?", channel=self.tel_channel, status=Msg.STATUS_QUEUED)

        # an incoming message that should not be included even if it is still pending
        incoming_message = self.create_incoming_msg(
            contact2, "hey", channel=self.tel_channel, status=Msg.STATUS_PENDING
        )

        # check our sync point has all three messages queued for delivery
        response = self.sync(self.tel_channel, cmds=[])
        self.assertEqual(200, response.status_code)

        # check last seen and fcm id were updated
        self.tel_channel.refresh_from_db()

        response = response.json()
        cmds = response["cmds"]
        self.assertEqual(5, len(cmds))

        # assert that our first command is the two message broadcast
        cmd = cmds[0]
        self.assertEqual("How is it going?", cmd["msg"])
        self.assertIn("+250788382382", [m["phone"] for m in cmd["to"]])
        self.assertIn("+250788383383", [m["phone"] for m in cmd["to"]])

        self.assertTrue(msg1.pk in [m["id"] for m in cmd["to"]])
        self.assertTrue(msg2.pk in [m["id"] for m in cmd["to"]])

        # add another message we'll pretend is in retry to see that we exclude them from sync
        msg6 = self.create_outgoing_msg(
            contact1,
            "Pretend this message is in retry on the client, don't send it on sync",
            channel=self.tel_channel,
            status=Msg.STATUS_QUEUED,
        )

        # a pending outgoing message should be included
        self.create_outgoing_msg(
            contact1, "Hello, we heard from you.", channel=self.tel_channel, status=Msg.STATUS_QUEUED
        )

        six_mins_ago = timezone.now() - timedelta(minutes=6)
        self.tel_channel.last_seen = six_mins_ago
        self.tel_channel.config["FCM_ID"] = "old_fcm_id"
        self.tel_channel.save(update_fields=["last_seen", "config"])

        cmds = [
            # device fcm data
            dict(cmd="fcm", fcm_id="12345", uuid="abcde"),
            # device details status
            dict(
                cmd="status",
                p_sts="DIS",
                p_src="BAT",
                p_lvl="60",
                net="UMTS",
                app_version="0.9.9",
                org_id=8,
                retry=[msg6.pk],
                pending=[],
            ),
            # pending incoming message that should be acknowledged but not updated
            dict(cmd="mt_sent", msg_id=incoming_message.pk, ts=date),
            # results for the outgoing messages
            dict(cmd="mt_sent", msg_id=msg1.pk, ts=date),
            dict(cmd="mt_sent", msg_id=msg2.pk, ts=date),
            dict(cmd="mt_dlvd", msg_id=msg3.pk, ts=date),
            dict(cmd="mt_error", msg_id=msg4.pk, ts=date),
            dict(cmd="mt_fail", msg_id=msg5.pk, ts=date),
            dict(cmd="mt_fail", msg_id=(msg6.pk - 4294967296), ts=date),  # simulate a negative integer from relayer
            # a missed call
            dict(cmd="call", phone="0788381212", type="mo_miss", ts=date),
            # repeated missed calls should be skipped
            dict(cmd="call", phone="0788381212", type="mo_miss", ts=date),
            dict(cmd="call", phone="0788381212", type="mo_miss", ts=date),
            # incoming
            dict(cmd="call", phone="0788381212", type="mt_call", dur=10, ts=date),
            # repeated calls should be skipped
            dict(cmd="call", phone="0788381212", type="mt_call", dur=10, ts=date),
            # incoming, invalid URN
            dict(cmd="call", phone="*", type="mt_call", dur=10, ts=date),
            # outgoing
            dict(cmd="call", phone="+250788383383", type="mo_call", dur=5, ts=date),
            # a new incoming message
            dict(cmd="mo_sms", phone="+250788383383", msg="This is giving me trouble", p_id="1", ts=date),
            # an incoming message from an empty contact
            dict(cmd="mo_sms", phone="", msg="This is spam", p_id="2", ts=date),
            # an incoming message from an invalid phone number
            dict(cmd="mo_sms", phone="!!@#$%", msg="sender ID invalid", p_id="4", ts=date),
        ]

        # now send the channel's updates
        response = self.sync(self.tel_channel, cmds=cmds)

        self.tel_channel.refresh_from_db()
        self.assertEqual(self.tel_channel.config["FCM_ID"], "12345")
        self.assertTrue(self.tel_channel.last_seen > six_mins_ago)

        # new batch, our ack and our claim command for new org
        self.assertEqual(6, len(response.json()["cmds"]))
        self.assertContains(response, "Hello, we heard from you.")
        self.assertContains(response, "mt_bcast")

        # check that our messages were updated accordingly
        self.assertEqual(2, Msg.objects.filter(channel=self.tel_channel, status="S", direction="O").count())
        self.assertEqual(1, Msg.objects.filter(channel=self.tel_channel, status="D", direction="O").count())
        self.assertEqual(1, Msg.objects.filter(channel=self.tel_channel, status="E", direction="O").count())
        self.assertEqual(2, Msg.objects.filter(channel=self.tel_channel, status="F", direction="O").count())

        # we should now have 4 incoming messages
        self.assertEqual(2, Msg.objects.filter(direction="I").count())
        # We should now have one sync
        self.assertEqual(1, SyncEvent.objects.filter(channel=self.tel_channel).count())

        # We should have 3 channel event
        self.assertEqual(3, ChannelEvent.objects.filter(channel=self.tel_channel).count())

        # We should have an incident for the app version
        self.assertEqual(
            1,
            Incident.objects.filter(
                incident_type=ChannelOutdatedAppIncidentType.slug, ended_on=None, channel=self.tel_channel
            ).count(),
        )

        # check our channel fcm and uuid were updated
        self.tel_channel = Channel.objects.get(pk=self.tel_channel.pk)
        self.assertEqual("12345", self.tel_channel.config["FCM_ID"])
        self.assertEqual("abcde", self.tel_channel.uuid)

        # should ignore incoming messages without text
        msgs_count = Msg.objects.all().count()
        response = self.sync(
            self.tel_channel,
            cmds=[
                # incoming msg without text
                dict(cmd="mo_sms", phone="+250788383383", p_id="1", ts=date)
            ],
        )

        # no new message
        self.assertEqual(Msg.objects.all().count(), msgs_count)

        response = self.sync(
            self.tel_channel,
            cmds=[
                # device details status
                dict(
                    cmd="status",
                    p_sts="DIS",
                    p_src="BAT",
                    p_lvl="15",
                    net="UMTS",
                    app_version="1.0.0",
                    pending=[],
                    retry=[],
                )
            ],
        )

        self.assertEqual(2, SyncEvent.objects.all().count())

        # We should have all incident for the app version ended
        self.assertEqual(
            1,
            Incident.objects.filter(
                incident_type=ChannelOutdatedAppIncidentType.slug, channel=self.tel_channel
            ).count(),
        )
        self.assertEqual(
            0,
            Incident.objects.filter(
                incident_type=ChannelOutdatedAppIncidentType.slug, ended_on=None, channel=self.tel_channel
            ).count(),
        )

        # make our events old so we can test trimming them
        SyncEvent.objects.all().update(created_on=timezone.now() - timedelta(days=45))
        trim_channel_sync_events()

        # should be cleared out
        self.assertEqual(1, SyncEvent.objects.all().count())

        response = self.sync(
            self.tel_channel,
            cmds=[
                # device fcm data
                dict(cmd="fcm", fcm_id="12345", uuid="abcde")
            ],
        )

        self.tel_channel.refresh_from_db()
        self.assertTrue(self.tel_channel.last_seen > six_mins_ago)
        self.assertEqual(self.tel_channel.config[Channel.CONFIG_FCM_ID], "12345")

    def test_signing(self):
        # good signature
        self.assertEqual(200, self.sync(self.tel_channel, cmds=[]).status_code)

        # bad signature, should result in 401 Unauthorized
        self.assertEqual(401, self.sync(self.tel_channel, signature="badsig", cmds=[]).status_code)

    @mock_mailroom
    def test_ignore_android_incoming_msg_invalid_phone(self, mr_mocks):
        date = timezone.now()
        date = int(time.mktime(date.timetuple())) * 1000

        response = self.sync(
            self.tel_channel, cmds=[dict(cmd="mo_sms", phone="_@", msg="First message", p_id="1", ts=date)]
        )
        self.assertEqual(200, response.status_code)

        responses = response.json()
        cmds = responses["cmds"]

        # check the server gave us responses for our message
        r0 = self.get_response(cmds, "1")

        self.assertIsNotNone(r0)
        self.assertEqual(r0["cmd"], "ack")

    def get_response(self, responses, p_id):
        for response in responses:
            if "p_id" in response and response["p_id"] == p_id:
                return response
