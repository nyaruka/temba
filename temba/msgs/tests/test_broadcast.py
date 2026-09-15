from django.conf import settings
from django.utils import timezone

from temba import mailroom
from temba.msgs.models import Broadcast, LabelCount, Media, Msg, MsgFolder
from temba.schedules.models import Schedule
from temba.tests import TembaTest, mock_mailroom
from temba.utils.compose import compose_deserialize_attachments


class BroadcastTest(TembaTest):
    def setUp(self):
        super().setUp()

        self.joe = self.create_contact("Joe Blow", phone="123")
        self.frank = self.create_contact("Frank Blow", phone="321")

        self.just_joe = self.create_group("Just Joe", [self.joe])

        self.joe_and_frank = self.create_group("Joe and Frank", [self.joe, self.frank])

        self.kevin = self.create_contact(name="Kevin Durant", phone="987")
        self.lucy = self.create_contact(name="Lucy M", urns=["facebook:123456"])

        # a Facebook channel
        self.facebook_channel = self.create_channel("FBA", "Facebook", "12345")

    def test_delete(self):
        flow = self.create_flow("Test")
        label = self.create_label("Labeled")

        # create some incoming messages
        msg_in1 = self.create_incoming_msg(self.joe, "Hello")
        self.create_incoming_msg(self.frank, "Bonjour")

        # create a broadcast which is a response to an incoming message
        self.create_broadcast(self.admin, {"eng": {"text": "Noted"}}, contacts=[self.joe])

        # create a broadcast which is to several contacts
        broadcast2 = self.create_broadcast(
            self.admin,
            {"eng": {"text": "Very old broadcast"}},
            groups=[self.joe_and_frank],
            contacts=[self.kevin, self.lucy],
        )

        # give joe some flow messages
        self.create_outgoing_msg(self.joe, "what's your fav color?")
        msg_in3 = self.create_incoming_msg(self.joe, "red!", flow=flow)
        self.create_outgoing_msg(self.joe, "red is cool")

        # mark all outgoing messages as sent except broadcast #2 to Joe, with the folder as mailroom and courier do
        Msg.objects.filter(direction="O").update(status="S", folder=Msg.FOLDER_SENT)
        broadcast2.msgs.filter(contact=self.joe).update(status="F", folder=Msg.FOLDER_FAILED)

        # label one of our messages
        self.add_msg_label(msg_in1, label)
        self.assertEqual(LabelCount.get_totals([label])[label], 1)

        msg_counts = MsgFolder.get_counts(self.org)
        self.assertEqual(msg_counts[MsgFolder.INBOX], 2)
        self.assertEqual(msg_counts[MsgFolder.HANDLED], 1)
        self.assertEqual(msg_counts[MsgFolder.SENT], 6)
        self.assertEqual(msg_counts[MsgFolder.FAILED], 1)

        today = timezone.now().date()

        self.assertEqual({(today, "text:in"): 3, (today, "text:out"): 6}, self.channel.counts.day_totals(scoped=True))
        self.assertEqual({(today, "text:out"): 1}, self.facebook_channel.counts.day_totals(scoped=True))

        # delete all our messages save for our flow incoming message
        for m in Msg.objects.exclude(id=msg_in3.id):
            m.delete()

        # broadcasts should be unaffected
        self.assertEqual(2, Broadcast.objects.count())

        # check msg folder counts have been updated
        msg_counts = MsgFolder.get_counts(self.org)
        self.assertEqual(0, msg_counts[MsgFolder.INBOX])
        self.assertEqual(1, msg_counts[MsgFolder.HANDLED])
        self.assertEqual(0, msg_counts[MsgFolder.SENT])
        self.assertEqual(0, msg_counts[MsgFolder.FAILED])

        # check user label
        self.assertEqual(0, LabelCount.get_totals([label])[label])

        # but daily channel counts should be unchanged
        self.assertEqual({(today, "text:in"): 3, (today, "text:out"): 6}, self.channel.counts.day_totals(scoped=True))
        self.assertEqual({(today, "text:out"): 1}, self.facebook_channel.counts.day_totals(scoped=True))

    def test_model(self):
        schedule = Schedule.create(self.org, timezone.now(), Schedule.REPEAT_MONTHLY)

        bcast2 = Broadcast.create(
            self.org,
            self.admin,
            {"eng": {"text": "Hello everyone"}, "spa": {"text": "Hola a todos"}, "fra": {"text": "Salut à tous"}},
            base_language="eng",
            groups=[self.joe_and_frank],
            contacts=[self.kevin, self.lucy],
            schedule=schedule,
        )
        self.assertEqual("P", bcast2.status)
        self.assertTrue(bcast2.is_active)

        bcast2.interrupt(self.editor)

        bcast2.refresh_from_db()
        self.assertEqual(Broadcast.STATUS_INTERRUPTED, bcast2.status)
        self.assertEqual(self.editor, bcast2.modified_by)
        self.assertIsNotNone(bcast2.modified_on)

        # create a broadcast that looks like it has been sent
        bcast3 = self.create_broadcast(self.admin, {"eng": {"text": "Hi everyone"}}, contacts=[self.kevin, self.lucy])

        self.assertEqual(2, bcast3.msgs.count())
        self.assertEqual(2, bcast3.get_message_count())

        # as_json falls back to a per-row count when BroadcastMsgCount.bulk_annotate hasn't run for the page
        self.assertEqual(2, bcast3.as_json()["msg_count"])

        self.assertEqual(2, Broadcast.objects.count())
        self.assertEqual(2, Msg.objects.count())
        self.assertEqual(1, Schedule.objects.count())

        bcast2.delete(self.admin, soft=True)

        self.assertEqual(2, Broadcast.objects.count())
        self.assertEqual(2, Msg.objects.count())
        self.assertEqual(0, Schedule.objects.count())  # schedule actually deleted

        # schedule should also be inactive
        bcast2.delete(self.admin, soft=False)
        bcast3.delete(self.admin, soft=False)

        self.assertEqual(0, Broadcast.objects.count())
        self.assertEqual(0, Msg.objects.count())
        self.assertEqual(0, Schedule.objects.count())

        # can't create broadcast with no recipients
        with self.assertRaises(AssertionError):
            Broadcast.create(self.org, self.admin, {"und": {"text": "no recipients"}}, base_language="und")

    def test_get_exclusions_display(self):
        def display(exclusions) -> list:
            return Broadcast(exclusions=exclusions).get_exclusions_display()

        self.assertEqual([], display(None))
        self.assertEqual(["Not in a flow"], display({"in_a_flow": True}))
        self.assertEqual(["No recent runs"], display({"started_previously": True}))
        self.assertEqual(["Active in the last year"], display({"not_seen_since_days": 365}))
        self.assertEqual(["Active in the last 90 days"], display({"not_seen_since_days": 90}))
        self.assertEqual([], display({"not_seen_since_days": "junk"}))  # bad data from an old row

    @mock_mailroom
    def test_preview(self, mr_mocks):
        contact1 = self.create_contact("Ann", phone="+1234567111")
        contact2 = self.create_contact("Bob", phone="+1234567222")
        doctors = self.create_group("Doctors", contacts=[contact1, contact2])

        mr_mocks.msg_broadcast_preview(query='group = "Doctors" AND status = "active"', total=100)

        query, total = Broadcast.preview(
            self.org,
            include=mailroom.Inclusions(group_uuids=[str(doctors.uuid)]),
            exclude=mailroom.Exclusions(non_active=True),
        )

        self.assertEqual('group = "Doctors" AND status = "active"', query)
        self.assertEqual(100, total)

    def test_get_translation(self):
        # create a broadcast with 3 different languages containing both text and attachments
        eng_text = "Hello everyone"
        spa_text = "Hola a todos"
        fra_text = "Salut à tous"

        # create 3 attachments
        media_attachments = []
        for _ in range(3):
            media = Media.from_upload(
                self.org,
                self.admin,
                self.upload(f"{settings.MEDIA_ROOT}/test_media/steve marten.jpg", "image/jpeg"),
                process=False,
            )
            media_attachments.append({"content_type": media.content_type, "url": media.url})
        attachments = compose_deserialize_attachments(media_attachments)
        eng_attachments = [attachments[0]]
        spa_attachments = [attachments[1]]
        fra_attachments = [attachments[2]]

        broadcast = self.create_broadcast(
            self.admin,
            translations={
                "eng": {"text": eng_text, "attachments": eng_attachments},
                "spa": {"text": spa_text, "attachments": spa_attachments},
                "fra": {"text": fra_text, "attachments": fra_attachments},
            },
            groups=[self.joe_and_frank],
            contacts=[self.kevin, self.lucy],
            schedule=Schedule.create(self.org, timezone.now(), Schedule.REPEAT_MONTHLY),
        )

        self.org.set_flow_languages(self.admin, ["kin"])

        # uses broadcast base language
        self.assertEqual(eng_text, broadcast.get_translation(self.joe)["text"])
        self.assertEqual(eng_attachments, broadcast.get_translation(self.joe)["attachments"])

        self.org.set_flow_languages(self.admin, ["spa", "eng", "fra"])

        # uses org primary language
        self.assertEqual(spa_text, broadcast.get_translation(self.joe)["text"])
        self.assertEqual(spa_attachments, broadcast.get_translation(self.joe)["attachments"])

        self.joe.language = "fra"
        self.joe.save(update_fields=("language",))

        # uses contact language
        self.assertEqual(fra_text, broadcast.get_translation(self.joe)["text"])
        self.assertEqual(fra_attachments, broadcast.get_translation(self.joe)["attachments"])

        self.org.set_flow_languages(self.admin, ["spa", "eng"])

        # but only if it's allowed
        self.assertEqual(spa_text, broadcast.get_translation(self.joe)["text"])
        self.assertEqual(spa_attachments, broadcast.get_translation(self.joe)["attachments"])

        self.assertEqual(f'<Broadcast: id={broadcast.id} text="Hola a todos">', repr(broadcast))
