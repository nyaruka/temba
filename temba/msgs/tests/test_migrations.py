from importlib import import_module
from unittest.mock import patch

from django.utils import timezone

from temba.msgs.models import Msg
from temba.tests import MigrationTest
from temba.utils.uuid import UUID


class BackfillBroadcastUUIDsTest(MigrationTest):
    app = "msgs"
    migrate_from = "0293_broadcast_uuid"
    migrate_to = "0294_backfill_bcast_uuid"

    def setUpBeforeMigration(self, apps):
        self.bcast1 = self.create_broadcast(self.admin, {"eng": {"text": "Hello"}})
        self.bcast1.uuid = None
        self.bcast1.save(update_fields=["uuid"])

        self.bcast2 = self.create_broadcast(self.admin, {"eng": {"text": "Hello"}})
        self.bcast2.uuid = "01997d23-81ec-73c2-a3da-4d8d69025931"
        self.bcast2.save(update_fields=["uuid"])

    def test_migration(self):
        self.bcast1.refresh_from_db()
        self.assertIsNotNone(self.bcast1.uuid)
        self.bcast2.refresh_from_db()
        self.assertEqual("01997d23-81ec-73c2-a3da-4d8d69025931", str(self.bcast2.uuid))  # unchanged


class BackfillMsgFolderTest(MigrationTest):
    app = "msgs"
    migrate_from = "0309_msg_folder"
    migrate_to = "0310_backfill_msg_folder"

    def setUpBeforeMigration(self, apps):
        contact = self.create_contact("Bob", phone="+1234567890")
        flow = self.create_flow("Test")

        self.inbox = self.create_incoming_msg(contact, "Hi")
        self.handled = self.create_incoming_msg(contact, "Hi", flow=flow)
        self.archived = self.create_incoming_msg(contact, "Hi", visibility="A")
        self.failed = self.create_outgoing_msg(contact, "Hi", status=Msg.STATUS_FAILED)
        self.pending = self.create_incoming_msg(contact, "Hi", status=Msg.STATUS_PENDING)

        # the outbox and sent folders each fold in several statuses
        self.outbox = {
            s: self.create_outgoing_msg(contact, "Hi", status=s)
            for s in (Msg.STATUS_INITIALIZING, Msg.STATUS_QUEUED, Msg.STATUS_ERRORED)
        }
        self.sent = {
            s: self.create_outgoing_msg(contact, "Hi", status=s, sent_on=timezone.now())
            for s in (Msg.STATUS_WIRED, Msg.STATUS_SENT, Msg.STATUS_DELIVERED, Msg.STATUS_READ)
        }

        # deleted and unhandled take precedence over the user facing folders
        self.deleted = self.create_incoming_msg(contact, "Hi", visibility=Msg.VISIBILITY_DELETED_BY_USER)
        self.deleted_by_sender = self.create_incoming_msg(
            contact, "Hi", status=Msg.STATUS_PENDING, visibility=Msg.VISIBILITY_DELETED_BY_SENDER
        )
        self.pending_archived = self.create_incoming_msg(contact, "Hi", status=Msg.STATUS_PENDING, visibility="A")

        # an outgoing message that is pending belongs to no folder - unlikely, but the database permits it
        self.underivable = self.create_outgoing_msg(contact, "Hi")
        Msg.objects.filter(id=self.underivable.id).update(status=Msg.STATUS_PENDING)

        # all of the above predate the folder column being written
        self.org.msgs.update(folder=None)

        # messages whose folder was written and has since gone stale, as updating an outgoing message's status from
        # an Android relayer's sync and archiving a contact's incoming messages in bulk both used to leave them
        self.stale_sent = self.create_outgoing_msg(contact, "Hi", status=Msg.STATUS_SENT)
        Msg.objects.filter(id=self.stale_sent.id).update(folder=Msg.FOLDER_OUTBOX)

        self.stale_archived = self.create_incoming_msg(contact, "Hi", visibility="A")
        Msg.objects.filter(id=self.stale_archived.id).update(folder=Msg.FOLDER_INBOX)

        # a message whose folder agrees with its state is left as it is
        self.correct = self.create_incoming_msg(contact, "Hi")
        Msg.objects.filter(id=self.correct.id).update(folder=Msg.FOLDER_INBOX)

        # an underivable message keeps the folder it has rather than having it cleared
        self.underivable_with_folder = self.create_outgoing_msg(contact, "Hi")
        Msg.objects.filter(id=self.underivable_with_folder.id).update(
            status=Msg.STATUS_PENDING, folder=Msg.FOLDER_OUTBOX
        )

        self.counts_before = self.org.counts.prefix("msgs:folder:").scope_totals()

    def test_migration(self):
        def assert_folder(msg, expected):
            msg.refresh_from_db()
            self.assertEqual(expected, msg.folder, f"folder mismatch for msg #{msg.id}")

        assert_folder(self.inbox, Msg.FOLDER_INBOX)
        assert_folder(self.handled, Msg.FOLDER_HANDLED)
        assert_folder(self.archived, Msg.FOLDER_ARCHIVED)
        assert_folder(self.failed, Msg.FOLDER_FAILED)
        assert_folder(self.pending, Msg.FOLDER_PENDING)
        assert_folder(self.deleted, Msg.FOLDER_DELETED)
        assert_folder(self.deleted_by_sender, Msg.FOLDER_DELETED)
        assert_folder(self.pending_archived, Msg.FOLDER_PENDING)

        for msg in self.outbox.values():
            assert_folder(msg, Msg.FOLDER_OUTBOX)
        for msg in self.sent.values():
            assert_folder(msg, Msg.FOLDER_SENT)

        assert_folder(self.stale_sent, Msg.FOLDER_SENT)  # corrected, not just filled in
        assert_folder(self.stale_archived, Msg.FOLDER_ARCHIVED)
        assert_folder(self.correct, Msg.FOLDER_INBOX)  # unchanged

        # a message that derives no folder is left alone rather than guessed at, either way round
        assert_folder(self.underivable, None)
        assert_folder(self.underivable_with_folder, Msg.FOLDER_OUTBOX)

        # folder counts are scoped by the columns folder is derived from and not by folder itself, so correcting one
        # can't move them - pinned down here because folder is a denormalization of nearly what that scope computes,
        # and a future change that had it read folder instead would make this migration emit spurious deltas
        self.assertTrue(self.counts_before)  # guard against the comparison below being two empty dicts
        self.assertEqual(self.counts_before, self.org.counts.prefix("msgs:folder:").scope_totals())


class BackfillMsgFolderPagingTest(MigrationTest):
    """
    The backfill walks the id range in batches of BATCH_SIZE ids, so with a realistic batch size a test fixture never
    runs the loop more than once. Shrink it so that advancing between batches is actually exercised.
    """

    app = "msgs"
    migrate_from = "0309_msg_folder"
    migrate_to = "0310_backfill_msg_folder"

    def setUp(self):
        # has to be patched before super() runs the migration
        migration = import_module("temba.msgs.migrations.0310_backfill_msg_folder")
        patcher = patch.object(migration, "BATCH_SIZE", 1)
        patcher.start()
        self.addCleanup(patcher.stop)

        super().setUp()

    def setUpBeforeMigration(self, apps):
        contact = self.create_contact("Bob", phone="+1234567890")

        # enough messages to span several batches, alternately never written and written wrongly
        self.msgs = [self.create_incoming_msg(contact, f"Hi {m}") for m in range(5)]
        for m, msg in enumerate(self.msgs):
            Msg.objects.filter(id=msg.id).update(folder=None if m % 2 else Msg.FOLDER_OUTBOX)

    def test_migration(self):
        # every message filled in, so no batch was skipped
        for msg in self.msgs:
            msg.refresh_from_db()
            self.assertEqual(Msg.FOLDER_INBOX, msg.folder, f"folder mismatch for msg #{msg.id}")


class BackfillMsgFolderNoMessagesTest(MigrationTest):
    app = "msgs"
    migrate_from = "0309_msg_folder"
    migrate_to = "0310_backfill_msg_folder"

    def test_migration(self):
        # a workspace with no messages at all has no id range to walk
        self.assertEqual(0, Msg.objects.count())


class BackfillMsgVisibilityTest(MigrationTest):
    app = "msgs"
    migrate_from = "0315_update_triggers"
    migrate_to = "0316_backfill_msg_visibility"

    def setUpBeforeMigration(self, apps):
        contact = self.create_contact("Bob", phone="+1234567890")
        flow = self.create_flow("Test")
        self.label = self.create_label("Spam")

        # archived messages, which stay in the Archived folder and only lose the second record of being archived
        self.archived = self.create_incoming_msg(contact, "Hi", visibility="A", archived=True)
        self.archived_in_flow = self.create_incoming_msg(contact, "Hi", flow=flow, visibility="A", archived=True)

        # archived while still unhandled, so filed as pending rather than archived
        self.archived_pending = self.create_incoming_msg(contact, "Hi", status=Msg.STATUS_PENDING, visibility="A")

        # messages whose visibility means something still, and so is left alone
        self.visible = self.create_incoming_msg(contact, "Hi")
        self.deleted_by_user = self.create_incoming_msg(contact, "Hi", visibility=Msg.VISIBILITY_DELETED_BY_USER)
        self.deleted_by_sender = self.create_incoming_msg(contact, "Hi", visibility=Msg.VISIBILITY_DELETED_BY_SENDER)

        # labelled via the through model as it was then, before it carried the message's uuid (added in 0324)
        msg_labels = apps.get_model("msgs", "Msg").labels.through
        for msg in (self.archived, self.visible):
            msg_labels.objects.create(msg_id=msg.id, label_id=self.label.id)

        self.folder_counts_before = self.org.counts.prefix("msgs:folder:").scope_totals()
        self.label_count_before = self.label.counts.sum()
        self.modified_on_before = dict(self.org.msgs.values_list("id", "modified_on"))

    def test_migration(self):
        def assert_msg(msg, visibility, folder):
            msg.refresh_from_db()
            self.assertEqual(visibility, msg.visibility, f"visibility mismatch for msg #{msg.id}")
            self.assertEqual(folder, msg.folder, f"folder mismatch for msg #{msg.id}")

            # correcting a redundant record isn't a change to the message itself
            self.assertEqual(self.modified_on_before[msg.id], msg.modified_on, f"modified_on bumped on #{msg.id}")

        # archived messages keep their folder, so they're still archived, and lose the redundant visibility
        assert_msg(self.archived, Msg.VISIBILITY_VISIBLE, Msg.FOLDER_ARCHIVED)
        assert_msg(self.archived_in_flow, Msg.VISIBILITY_VISIBLE, Msg.FOLDER_ARCHIVED)

        # the one that never made it to the Archived folder becomes an ordinary pending message
        assert_msg(self.archived_pending, Msg.VISIBILITY_VISIBLE, Msg.FOLDER_PENDING)

        # everything else is untouched, deleted messages included
        assert_msg(self.visible, Msg.VISIBILITY_VISIBLE, Msg.FOLDER_INBOX)
        assert_msg(self.deleted_by_user, Msg.VISIBILITY_DELETED_BY_USER, Msg.FOLDER_DELETED)
        assert_msg(self.deleted_by_sender, Msg.VISIBILITY_DELETED_BY_SENDER, Msg.FOLDER_DELETED)

        # and no counts moved, because no message changed folder
        self.assertEqual(self.folder_counts_before, self.org.counts.prefix("msgs:folder:").scope_totals())
        self.assertEqual(self.label_count_before, self.label.counts.sum())


class BackfillMsgVisibilityPagingTest(MigrationTest):
    """
    The backfill walks the id range in batches of BATCH_SIZE ids, so with a realistic batch size a test fixture never
    runs the loop more than once. Shrink it so that advancing between batches is actually exercised.
    """

    app = "msgs"
    migrate_from = "0315_update_triggers"
    migrate_to = "0316_backfill_msg_visibility"

    def setUp(self):
        # has to be patched before super() runs the migration
        migration = import_module("temba.msgs.migrations.0316_backfill_msg_visibility")
        patcher = patch.object(migration, "BATCH_SIZE", 1)
        patcher.start()
        self.addCleanup(patcher.stop)

        super().setUp()

    def setUpBeforeMigration(self, apps):
        contact = self.create_contact("Bob", phone="+1234567890")

        # enough messages to span several batches, alternately archived and not
        self.msgs = [
            self.create_incoming_msg(contact, f"Hi {m}", visibility="A" if m % 2 else Msg.VISIBILITY_VISIBLE)
            for m in range(5)
        ]

    def test_migration(self):
        # every message cleared, so no batch was skipped
        for msg in self.msgs:
            msg.refresh_from_db()
            self.assertEqual(Msg.VISIBILITY_VISIBLE, msg.visibility, f"visibility mismatch for msg #{msg.id}")


class BackfillMsgVisibilityNoMessagesTest(MigrationTest):
    app = "msgs"
    migrate_from = "0315_update_triggers"
    migrate_to = "0316_backfill_msg_visibility"

    def test_migration(self):
        # a workspace with no messages at all has no id range to walk
        self.assertEqual(0, Msg.objects.count())


class BackfillMsgNextAttemptTest(MigrationTest):
    app = "msgs"
    migrate_from = "0321_msg_outgoing_awaiting_retry"
    migrate_to = "0322_backfill_msg_next_attempt"

    def setUpBeforeMigration(self, apps):
        contact = self.create_contact("Bob", phone="+1234567890")
        self.next_attempt = timezone.now()

        # messages awaiting a retry keep theirs
        self.errored = self.create_outgoing_msg(
            contact, "Hi", status=Msg.STATUS_ERRORED, next_attempt=self.next_attempt
        )
        self.initializing = self.create_outgoing_msg(
            contact, "Hi", status=Msg.STATUS_INITIALIZING, next_attempt=self.next_attempt
        )

        # messages which moved on but were left with the retry they no longer need
        self.wired = self.create_outgoing_msg(
            contact, "Hi", status=Msg.STATUS_WIRED, sent_on=timezone.now(), next_attempt=self.next_attempt
        )
        self.failed = self.create_outgoing_msg(contact, "Hi", status=Msg.STATUS_FAILED, next_attempt=self.next_attempt)

        # and one that never had one
        self.queued = self.create_outgoing_msg(contact, "Hi", status=Msg.STATUS_QUEUED)

    def test_migration(self):
        def next_attempt(msg):
            msg.refresh_from_db()
            return msg.next_attempt

        self.assertEqual(self.next_attempt, next_attempt(self.errored))
        self.assertEqual(self.next_attempt, next_attempt(self.initializing))
        self.assertIsNone(next_attempt(self.wired))
        self.assertIsNone(next_attempt(self.failed))
        self.assertIsNone(next_attempt(self.queued))


class BackfillMsgNextAttemptPagingTest(MigrationTest):
    """
    The backfill clears BATCH_SIZE rows at a time until nothing is left, so with a realistic batch size a test fixture
    never runs the loop more than once. Shrink it so that looping - and terminating - is actually exercised.
    """

    app = "msgs"
    migrate_from = "0321_msg_outgoing_awaiting_retry"
    migrate_to = "0322_backfill_msg_next_attempt"

    def setUp(self):
        # has to be patched before super() runs the migration
        migration = import_module("temba.msgs.migrations.0322_backfill_msg_next_attempt")
        patcher = patch.object(migration, "BATCH_SIZE", 1)
        patcher.start()
        self.addCleanup(patcher.stop)

        super().setUp()

    def setUpBeforeMigration(self, apps):
        contact = self.create_contact("Bob", phone="+1234567890")
        now = timezone.now()

        # enough stale rows to span several batches
        self.stale = [
            self.create_outgoing_msg(contact, f"Hi {m}", status=Msg.STATUS_SENT, sent_on=now, next_attempt=now)
            for m in range(5)
        ]
        self.errored = self.create_outgoing_msg(contact, "Hi", status=Msg.STATUS_ERRORED, next_attempt=now)

    def test_migration(self):
        # every stale row cleared, so no batch was skipped and the loop terminated
        for msg in self.stale:
            msg.refresh_from_db()
            self.assertIsNone(msg.next_attempt, f"next_attempt still set on msg #{msg.id}")

        self.errored.refresh_from_db()
        self.assertIsNotNone(self.errored.next_attempt)


class BackfillMsgLabelUUIDTest(MigrationTest):
    app = "msgs"
    migrate_from = "0324_msglabel"
    migrate_to = "0325_backfill_msglabel_msg_uuid"

    def setUpBeforeMigration(self, apps):
        contact = self.create_contact("Bob", phone="+1234567890")
        label1 = self.create_label("Spam")
        label2 = self.create_label("Social")

        # labellings written before the column existed
        self.msg1 = self.create_incoming_msg(contact, "Hi 1")
        self.msg1.labels.add(label1, label2)
        self.msg2 = self.create_incoming_msg(contact, "Hi 2")
        self.msg2.labels.add(label1)

        # and one written since, which the backfill leaves as it is (given a different uuid to make that provable)
        self.msg3 = self.create_incoming_msg(contact, "Hi 3")
        self.already = self.msg3.labels.through.objects.create(
            msg=self.msg3, label=label1, msg_uuid="01997d23-81ec-73c2-a3da-4d8d69025931"
        )

    def test_migration(self):
        def msg_uuids(msg) -> set:
            return set(msg.labels.through.objects.filter(msg=msg).values_list("msg_uuid", flat=True))

        self.assertEqual({self.msg1.uuid}, msg_uuids(self.msg1))
        self.assertEqual({self.msg2.uuid}, msg_uuids(self.msg2))
        self.assertEqual({UUID("01997d23-81ec-73c2-a3da-4d8d69025931")}, msg_uuids(self.msg3))


class BackfillMsgLabelUUIDPagingTest(MigrationTest):
    """
    The backfill walks the table BATCH_SIZE rows at a time, so with a realistic batch size a test fixture never runs
    the loop more than once. Shrink it so that looping - and terminating - is actually exercised.
    """

    app = "msgs"
    migrate_from = "0324_msglabel"
    migrate_to = "0325_backfill_msglabel_msg_uuid"

    def setUp(self):
        # has to be patched before super() runs the migration
        migration = import_module("temba.msgs.migrations.0325_backfill_msglabel_msg_uuid")
        patcher = patch.object(migration, "BATCH_SIZE", 2)
        patcher.start()
        self.addCleanup(patcher.stop)

        super().setUp()

    def setUpBeforeMigration(self, apps):
        contact = self.create_contact("Bob", phone="+1234567890")
        label = self.create_label("Spam")

        # enough rows to span several batches
        self.msgs = [self.create_incoming_msg(contact, f"Hi {m}") for m in range(5)]
        for msg in self.msgs:
            msg.labels.add(label)

    def test_migration(self):
        # every row filled, so no batch was skipped and the loop terminated
        for msg in self.msgs:
            labelling = msg.labels.through.objects.get(msg=msg)
            self.assertEqual(msg.uuid, labelling.msg_uuid, f"msg_uuid still unset on msg #{msg.id}")


class BackfillMsgLabelUUIDNoRowsTest(MigrationTest):
    app = "msgs"
    migrate_from = "0324_msglabel"
    migrate_to = "0325_backfill_msglabel_msg_uuid"

    def test_migration(self):
        self.assertFalse(Msg.labels.through.objects.exists())
