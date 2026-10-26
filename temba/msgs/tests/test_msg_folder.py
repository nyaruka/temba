from datetime import timedelta

from django.utils import timezone

from temba.flows.models import Flow, FlowRun, FlowSession
from temba.msgs.models import Msg, MsgFolder
from temba.orgs.tasks import squash_item_counts
from temba.schedules.models import Schedule
from temba.tests import TembaTest
from temba.utils import s3


class MsgFolderTest(TembaTest):
    def test_get_queryset(self):
        contact = self.create_contact("Bob", phone="0783835001")
        other_contact = self.create_contact("Jim", phone="0783835002", org=self.org2)
        self.create_channel("A", "Org2Channel", "123456", country="RW", org=self.org2)
        t0 = (timezone.now() - timedelta(days=1)).replace(microsecond=0)

        # one a second before the others and one 20ms after, with the others a millisecond apart so that their uuids
        # are strictly ordered, and the last in the same millisecond as the one before it so that the bounds are seen
        # to be millisecond granular
        msg0 = self.create_incoming_msg(contact, "Msg 0", created_on=t0 - timedelta(seconds=1))
        msg1 = self.create_incoming_msg(contact, "Msg 1", created_on=t0)
        msg2 = self.create_incoming_msg(contact, "Msg 2", created_on=t0 + timedelta(milliseconds=1))
        msg3 = self.create_incoming_msg(contact, "Msg 3", created_on=t0 + timedelta(milliseconds=2))
        msg4 = self.create_incoming_msg(contact, "Msg 4", created_on=t0 + timedelta(milliseconds=2, microseconds=500))
        msg5 = self.create_incoming_msg(contact, "Msg 5", created_on=t0 + timedelta(milliseconds=20))
        self.create_incoming_msg(contact, "Archived", created_on=t0, archived=True)
        self.create_incoming_msg(other_contact, "Other org", created_on=t0)

        # newest first, filtered by folder rather than the columns it's derived from
        qs = MsgFolder.INBOX.get_queryset(self.org)
        self.assertEqual([msg5, msg4, msg3, msg2, msg1, msg0], list(qs))
        self.assertRegex(
            str(qs.query),
            r'WHERE \("msgs_msg"\."folder" = I AND "msgs_msg"\."org_id" = \d+\) ORDER BY "msgs_msg"\."uuid" DESC$',
        )

        def assert_range(expected, **bounds):
            self.assertEqual(expected, list(MsgFolder.INBOX.get_queryset(self.org, **bounds)), bounds)

        # bounds are inclusive, millisecond granular, and padded by 10ms at each end
        assert_range([msg4, msg3, msg2, msg1, msg0], before=msg2.created_on)
        assert_range([msg4, msg3, msg2, msg1, msg0], before=t0 + timedelta(milliseconds=9))
        assert_range([msg5, msg4, msg3, msg2, msg1, msg0], before=t0 + timedelta(milliseconds=10))
        assert_range([msg0], before=t0 - timedelta(seconds=1, milliseconds=10))
        assert_range([], before=t0 - timedelta(seconds=1, milliseconds=11))

        assert_range([msg5, msg4, msg3, msg2, msg1], after=msg2.created_on)
        assert_range([msg5, msg4, msg3, msg2, msg1], after=t0 - timedelta(seconds=1) + timedelta(milliseconds=11))
        assert_range([msg5, msg4, msg3, msg2, msg1, msg0], after=t0 - timedelta(seconds=1) + timedelta(milliseconds=10))
        assert_range([msg5], after=msg5.created_on + timedelta(milliseconds=10))
        assert_range([], after=msg5.created_on + timedelta(milliseconds=11))

        assert_range([msg4, msg3, msg2, msg1], before=msg3.created_on, after=msg3.created_on)
        assert_range([msg0], before=msg0.created_on, after=msg0.created_on)

    def test_outbox_matches_unsent_statuses(self):
        """
        The index on old Android messages is partial on folder = Outbox rather than on the statuses a message waiting
        to be sent can have, so the two have to pick out the same messages.
        """

        contact = self.create_contact("Bob", phone="0783835001")

        waiting = (Msg.STATUS_INITIALIZING, Msg.STATUS_QUEUED, Msg.STATUS_ERRORED)
        gone = (Msg.STATUS_WIRED, Msg.STATUS_SENT, Msg.STATUS_DELIVERED, Msg.STATUS_READ, Msg.STATUS_FAILED)

        for status in waiting:
            msg = self.create_outgoing_msg(contact, "Hi", status=status)
            self.assertEqual(Msg.FOLDER_OUTBOX, msg.folder, f"{status} should be in the outbox")

        for status in gone:
            # a message that reached the channel has to carry a sent_on
            sent_on = timezone.now() if status != Msg.STATUS_FAILED else None
            msg = self.create_outgoing_msg(contact, "Hi", status=status, sent_on=sent_on)
            self.assertNotEqual(Msg.FOLDER_OUTBOX, msg.folder, f"{status} should not be in the outbox")

        # so selecting visible outgoing messages by folder and by status gives the same set
        outgoing = Msg.objects.filter(org=self.org, direction=Msg.DIRECTION_OUT, visibility=Msg.VISIBILITY_VISIBLE)

        self.assertEqual(
            set(outgoing.filter(folder=Msg.FOLDER_OUTBOX).values_list("id", flat=True)),
            set(outgoing.filter(status__in=waiting).values_list("id", flat=True)),
        )

        # selecting by folder is narrower than selecting by status alone though - a message deleted whilst still
        # waiting to be sent keeps its status but moves to the deleted folder, and isn't ours to fail any more
        deleted = self.create_outgoing_msg(contact, "Hi", status=Msg.STATUS_QUEUED)
        Msg.objects.filter(id=deleted.id).update(visibility=Msg.VISIBILITY_DELETED_BY_USER, folder=Msg.FOLDER_DELETED)
        deleted.refresh_from_db()

        self.assertEqual(Msg.STATUS_QUEUED, deleted.status)
        self.assertEqual(Msg.FOLDER_DELETED, deleted.folder)

    def test_get_archive_query(self):
        tcs = (
            (
                MsgFolder.INBOX,
                "SELECT s.* FROM s3object s WHERE s.direction = 'in' AND s.visibility = 'visible' AND s.status = 'handled' AND s.flow IS NULL",
            ),
            (
                MsgFolder.HANDLED,
                "SELECT s.* FROM s3object s WHERE s.direction = 'in' AND s.visibility = 'visible' AND s.status = 'handled' AND s.flow IS NOT NULL",
            ),
            (
                MsgFolder.ARCHIVED,
                "SELECT s.* FROM s3object s WHERE s.direction = 'in' AND s.visibility = 'archived' AND s.status = 'handled'",
            ),
            (
                MsgFolder.OUTBOX,
                "SELECT s.* FROM s3object s WHERE s.direction = 'out' AND s.visibility = 'visible' AND s.status IN ('initializing', 'queued', 'errored')",
            ),
            (
                MsgFolder.SENT,
                "SELECT s.* FROM s3object s WHERE s.direction = 'out' AND s.visibility = 'visible' AND s.status IN ('wired', 'sent', 'delivered', 'read')",
            ),
            (
                MsgFolder.FAILED,
                "SELECT s.* FROM s3object s WHERE s.direction = 'out' AND s.visibility = 'visible' AND s.status = 'failed'",
            ),
        )

        for folder, expected_select in tcs:
            select = s3.compile_select(where=folder.get_archive_query())
            self.assertEqual(expected_select, select, f"select s3 mismatch for {folder}")

    def test_get_counts(self):
        def assert_counts(org, expected: dict):
            self.assertEqual(MsgFolder.get_counts(org), expected)

        assert_counts(
            self.org,
            {
                MsgFolder.INBOX: 0,
                MsgFolder.HANDLED: 0,
                MsgFolder.ARCHIVED: 0,
                MsgFolder.OUTBOX: 0,
                MsgFolder.SENT: 0,
                MsgFolder.FAILED: 0,
                "scheduled": 0,
                "calls": 0,
            },
        )

        contact1 = self.create_contact("Bob", phone="0783835001")
        contact2 = self.create_contact("Jim", phone="0783835002")
        msg1 = self.create_incoming_msg(contact1, "Message 1")
        self.create_incoming_msg(contact1, "Message 2")
        msg3 = self.create_incoming_msg(contact1, "Message 3")
        msg4 = self.create_incoming_msg(contact1, "Message 4")
        self.create_broadcast(self.editor, {"eng": {"text": "Broadcast 2"}}, contacts=[contact1, contact2], status="P")
        self.create_broadcast(
            self.editor,
            {"eng": {"text": "Broadcast 2"}},
            contacts=[contact1, contact2],
            schedule=Schedule.create(self.org, timezone.now(), Schedule.REPEAT_DAILY),
        )
        ivr_flow = self.create_flow("IVR", flow_type=Flow.TYPE_VOICE)
        call1 = self.create_incoming_call(ivr_flow, contact1)
        self.create_incoming_call(ivr_flow, contact2)

        assert_counts(
            self.org,
            {
                MsgFolder.INBOX: 4,
                MsgFolder.HANDLED: 0,
                MsgFolder.ARCHIVED: 0,
                MsgFolder.OUTBOX: 0,
                MsgFolder.SENT: 2,
                MsgFolder.FAILED: 0,
                "scheduled": 1,
                "calls": 2,
            },
        )

        Msg.bulk_archive(self.org, [msg3])

        bcast1 = self.create_broadcast(
            self.editor,
            {"eng": {"text": "Broadcast 1"}},
            contacts=[contact1, contact2],
            msg_status=Msg.STATUS_INITIALIZING,
        )
        msg5, msg6 = tuple(Msg.objects.filter(broadcast=bcast1))

        self.create_broadcast(
            self.editor,
            {"eng": {"text": "Broadcast 3"}},
            contacts=[contact1],
            schedule=Schedule.create(self.org, timezone.now(), Schedule.REPEAT_DAILY),
        )

        assert_counts(
            self.org,
            {
                MsgFolder.INBOX: 3,
                MsgFolder.HANDLED: 0,
                MsgFolder.ARCHIVED: 1,
                MsgFolder.OUTBOX: 2,
                MsgFolder.SENT: 2,
                MsgFolder.FAILED: 0,
                "scheduled": 2,
                "calls": 2,
            },
        )

        Msg.bulk_archive(self.org, [msg1])
        msg3.delete()  # deleting an archived msg
        msg4.delete()  # deleting a visible msg

        # status changes are made the way mailroom and courier make them, with the folder
        msg5.status = "F"
        msg5.folder = Msg.FOLDER_FAILED
        msg5.save(update_fields=("status", "folder"))
        msg6.status = "S"
        msg6.folder = Msg.FOLDER_SENT
        msg6.save(update_fields=("status", "folder"))
        FlowRun.objects.all().delete()
        FlowSession.objects.all().delete()
        call1.delete()

        assert_counts(
            self.org,
            {
                MsgFolder.INBOX: 1,
                MsgFolder.HANDLED: 0,
                MsgFolder.ARCHIVED: 1,
                MsgFolder.OUTBOX: 0,
                MsgFolder.SENT: 3,
                MsgFolder.FAILED: 1,
                "scheduled": 2,
                "calls": 1,
            },
        )

        Msg.bulk_restore(self.org, [msg1])
        msg5.status = "F"  # already failed
        msg5.save(update_fields=("status", "folder"))
        msg6.status = "D"  # still in the sent folder
        msg6.save(update_fields=("status", "folder"))

        assert_counts(
            self.org,
            {
                MsgFolder.INBOX: 2,
                MsgFolder.HANDLED: 0,
                MsgFolder.ARCHIVED: 0,
                MsgFolder.OUTBOX: 0,
                MsgFolder.SENT: 3,
                MsgFolder.FAILED: 1,
                "scheduled": 2,
                "calls": 1,
            },
        )

        self.assertEqual(self.org.counts.count(), 25)

        # squash our counts
        squash_item_counts()

        assert_counts(
            self.org,
            {
                MsgFolder.INBOX: 2,
                MsgFolder.HANDLED: 0,
                MsgFolder.ARCHIVED: 0,
                MsgFolder.OUTBOX: 0,
                MsgFolder.SENT: 3,
                MsgFolder.FAILED: 1,
                "scheduled": 2,
                "calls": 1,
            },
        )

        # we should only have one count per folder with non-zero count
        self.assertEqual(self.org.counts.count(), 5)

        # counts follow folder, so a state change which doesn't update it moves nothing - the message wouldn't have
        # moved between folders either
        msg6.status = "F"
        msg6.save(update_fields=("status",))

        assert_counts(
            self.org,
            {
                MsgFolder.INBOX: 2,
                MsgFolder.HANDLED: 0,
                MsgFolder.ARCHIVED: 0,
                MsgFolder.OUTBOX: 0,
                MsgFolder.SENT: 3,
                MsgFolder.FAILED: 1,
                "scheduled": 2,
                "calls": 1,
            },
        )
