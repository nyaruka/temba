from datetime import date, timedelta

from django.utils import timezone

from temba.msgs.models import Label, LabelCount, MessageExport, Msg
from temba.msgs.tasks import squash_msg_counts
from temba.tests import TembaTest


class LabelTest(TembaTest):
    def setUp(self):
        super().setUp()

        self.joe = self.create_contact("Joe Blow", phone="073835001")
        self.frank = self.create_contact("Frank", phone="073835002")

    def test_create(self):
        label1 = Label.create(self.org, self.editor, "Spam")
        self.assertEqual("Spam", label1.name)

        # don't allow invalid name
        self.assertRaises(AssertionError, Label.create, self.org, self.editor, '"Hi"')

        # don't allow duplicate name
        self.assertRaises(AssertionError, Label.create, self.org, self.editor, "Spam")

    def test_get_queryset(self):
        t0 = (timezone.now() - timedelta(days=1)).replace(microsecond=0)

        # one a second before the others, the others a millisecond apart so that their uuids are strictly ordered, and
        # one 20ms after so that the padding of the bounds is seen
        msg0 = self.create_incoming_msg(self.joe, "Msg 0", created_on=t0 - timedelta(seconds=1))
        msg1 = self.create_incoming_msg(self.joe, "Msg 1", created_on=t0)
        msg2 = self.create_incoming_msg(self.frank, "Msg 2", created_on=t0 + timedelta(milliseconds=1))
        archived = self.create_incoming_msg(
            self.joe, "Archived", created_on=t0 + timedelta(milliseconds=2), archived=True
        )
        deleted = self.create_incoming_msg(
            self.joe, "Deleted", created_on=t0 + timedelta(milliseconds=3), visibility=Msg.VISIBILITY_DELETED_BY_USER
        )
        msg3 = self.create_incoming_msg(self.joe, "Msg 3", created_on=t0 + timedelta(milliseconds=20))
        other = self.create_incoming_msg(self.joe, "Other", created_on=t0)

        label = self.create_label("Spam")
        other_label = self.create_label("Other")
        for msg in (msg0, msg1, msg2, archived, deleted, msg3):
            self.add_msg_label(msg, label)
        self.add_msg_label(other, other_label)

        # newest first, whatever folder they're in, except deleted
        qs = label.get_queryset()
        self.assertEqual([msg3, archived, msg2, msg1, msg0], list(qs))

        # ordered by the copy of the message's uuid on the labelling, not the message's own uuid
        self.assertEqual([m.uuid for m in qs], [m.label_msg_uuid for m in qs])
        self.assertRegex(
            str(qs.query),
            r'"msgs_msg_labels"\."msg_uuid" AS "label_msg_uuid" FROM "msgs_msg" INNER JOIN "msgs_msg_labels" '
            r'ON \("msgs_msg"\."id" = "msgs_msg_labels"\."msg_id"\) '
            r'WHERE \("msgs_msg_labels"\."label_id" = \d+ AND "msgs_msg"\."org_id" = \d+ AND NOT \("msgs_msg"\."folder" = D\)\) '
            r"ORDER BY \d+ DESC$",
        )

        def assert_range(expected, **bounds):
            qs = label.get_queryset(**bounds)
            self.assertEqual(expected, list(qs), bounds)

            # the bounds are on the labelling's copy of the uuid too
            self.assertNotIn('"msgs_msg"."uuid"', str(qs.query).split("WHERE")[1])

        # bounds are inclusive, millisecond granular, and padded by 10ms at each end - as for folders
        assert_range([archived, msg2, msg1, msg0], before=msg2.created_on)
        assert_range([archived, msg2, msg1, msg0], before=t0 + timedelta(milliseconds=9))
        assert_range([msg3, archived, msg2, msg1, msg0], before=t0 + timedelta(milliseconds=10))
        assert_range([], before=t0 - timedelta(seconds=1, milliseconds=11))

        assert_range([msg3, archived, msg2, msg1], after=msg2.created_on)
        assert_range([msg3, archived, msg2, msg1, msg0], after=t0 - timedelta(seconds=1) + timedelta(milliseconds=10))
        assert_range([msg3], after=msg3.created_on + timedelta(milliseconds=10))
        assert_range([], after=msg3.created_on + timedelta(milliseconds=11))

        assert_range([archived, msg2, msg1], after=msg1.created_on, before=msg2.created_on)

    def test_toggle_label(self):
        label = self.create_label("Spam")
        msg1 = self.create_incoming_msg(self.joe, "Message 1")
        msg2 = self.create_incoming_msg(self.joe, "Message 2")
        msg3 = self.create_incoming_msg(self.joe, "Message 3")

        self.assertEqual(label.get_message_count(), 0)

        label.toggle_label([msg1, msg2, msg3], add=True)  # add label to 3 messages

        label.refresh_from_db()
        self.assertEqual(label.get_message_count(), 3)
        self.assertEqual(set(label.get_messages()), {msg1, msg2, msg3})

        label.toggle_label([msg3], add=False)  # remove label from a message

        label.refresh_from_db()
        self.assertEqual(label.get_message_count(), 2)
        self.assertEqual(set(label.get_messages()), {msg1, msg2})

        # check still correct after squashing
        squash_msg_counts()
        self.assertEqual(label.get_message_count(), 2)

        Msg.bulk_archive(self.org, [msg2])  # archiving neither removes the label nor changes the count

        label.refresh_from_db()
        self.assertEqual(label.get_message_count(), 2)
        self.assertEqual(set(label.get_messages()), {msg1, msg2})

        Msg.bulk_restore(self.org, [msg2])

        label.refresh_from_db()
        self.assertEqual(label.get_message_count(), 2)
        self.assertEqual(set(label.get_messages()), {msg1, msg2})

        msg2.delete()  # removes label message no longer visible

        label.refresh_from_db()
        self.assertEqual(label.get_message_count(), 1)
        self.assertEqual(set(label.get_messages()), {msg1})

        Msg.bulk_archive(self.org, [msg3])
        label.toggle_label([msg3], add=True)  # labelling an already archived message counts it like any other

        label.refresh_from_db()
        self.assertEqual(label.get_message_count(), 2)
        self.assertEqual(set(label.get_messages()), {msg1, msg3})

        Msg.bulk_restore(self.org, [msg3])

        label.refresh_from_db()
        self.assertEqual(label.get_message_count(), 2)
        self.assertEqual(set(label.get_messages()), {msg1, msg3})

        # can't label outgoing messages
        msg5 = self.create_outgoing_msg(self.joe, "Message")
        self.assertRaises(AssertionError, label.toggle_label, [msg5], add=True)

        # squashing shouldn't affect counts
        self.assertEqual(LabelCount.get_totals([label])[label], 2)

        squash_msg_counts()

        self.assertEqual(LabelCount.get_totals([label])[label], 2)

    def test_delete(self):
        label1 = self.create_label("Spam")
        label2 = self.create_label("Social")
        label3 = self.create_label("Other")

        msg1 = self.create_incoming_msg(self.joe, "Message 1")
        msg2 = self.create_incoming_msg(self.joe, "Message 2")
        msg3 = self.create_incoming_msg(self.joe, "Message 3")

        label1.toggle_label([msg1, msg2], add=True)
        label2.toggle_label([msg1], add=True)
        label3.toggle_label([msg3], add=True)

        MessageExport.create(self.org, self.admin, start_date=date.today(), end_date=date.today(), label=label1)

        label1.release(self.admin)
        label2.release(self.admin)

        # check that contained labels are also released
        self.assertEqual(0, Label.objects.filter(id__in=[label1.id, label2.id], is_active=True).count())
        self.assertEqual(set(), set(Msg.objects.get(id=msg1.id).labels.all()))
        self.assertEqual(set(), set(Msg.objects.get(id=msg2.id).labels.all()))
        self.assertEqual({label3}, set(Msg.objects.get(id=msg3.id).labels.all()))

        label3.release(self.admin)
        label3.refresh_from_db()

        self.assertFalse(label3.is_active)
        self.assertEqual(self.admin, label3.modified_by)
        self.assertEqual(set(), set(Msg.objects.get(id=msg3.id).labels.all()))
