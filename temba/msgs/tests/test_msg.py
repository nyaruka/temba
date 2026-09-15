from unittest.mock import call, patch

from django.utils import timezone

from temba.flows.models import Flow
from temba.msgs.models import Msg, MsgFolder
from temba.tests import CRUDLTestMixin, TembaTest, mock_mailroom
from temba.tests.mailroom import derive_msg_folder
from temba.utils.uuid import uuid7


class MsgTest(TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        self.joe = self.create_contact("Joe Blow", urns=["tel:789", "tel:123"])
        self.frank = self.create_contact("Frank Blow", phone="321")
        self.kevin = self.create_contact("Kevin Durant", phone="987")

        self.just_joe = self.create_group("Just Joe", [self.joe])
        self.joe_and_frank = self.create_group("Joe and Frank", [self.joe, self.frank])

    def test_folder(self):
        flow = self.create_flow("Test")

        def assert_folder(msg, expected):
            # test fixtures write the folder at creation like mailroom and courier do
            self.assertEqual(expected, msg.folder, f"folder mismatch for msg #{msg.id}")
            self.assertEqual(expected, derive_msg_folder(msg), f"folder mismatch for msg #{msg.id}")

        assert_folder(self.create_incoming_msg(self.joe, "Hi"), Msg.FOLDER_INBOX)
        assert_folder(self.create_incoming_msg(self.joe, "Hi", flow=flow), Msg.FOLDER_HANDLED)
        assert_folder(self.create_outgoing_msg(self.joe, "Hi", status=Msg.STATUS_FAILED), Msg.FOLDER_FAILED)

        # the outbox and sent folders each fold in several statuses
        for status in (Msg.STATUS_INITIALIZING, Msg.STATUS_QUEUED, Msg.STATUS_ERRORED):
            assert_folder(self.create_outgoing_msg(self.joe, "Hi", status=status), Msg.FOLDER_OUTBOX)

        for status in (Msg.STATUS_WIRED, Msg.STATUS_SENT, Msg.STATUS_DELIVERED, Msg.STATUS_READ):
            msg = self.create_outgoing_msg(self.joe, "Hi", status=status, sent_on=timezone.now())
            assert_folder(msg, Msg.FOLDER_SENT)

        # incoming messages which haven't been handled yet are pending
        assert_folder(self.create_incoming_msg(self.joe, "Hi", status=Msg.STATUS_PENDING), Msg.FOLDER_PENDING)

        # being deleted takes precedence over everything else
        for visibility in (Msg.VISIBILITY_DELETED_BY_USER, Msg.VISIBILITY_DELETED_BY_SENDER):
            assert_folder(self.create_incoming_msg(self.joe, "Hi", visibility=visibility), Msg.FOLDER_DELETED)
            assert_folder(
                self.create_incoming_msg(self.joe, "Hi", status=Msg.STATUS_PENDING, visibility=visibility),
                Msg.FOLDER_DELETED,
            )

        # an outgoing message that is pending belongs to no folder - unlikely, but the database permits it
        with self.assertRaises(AssertionError):
            derive_msg_folder(Msg(direction=Msg.DIRECTION_OUT, status=Msg.STATUS_PENDING))

    def test_as_archive_json(self):
        flow = self.create_flow("Color Flow")
        msg1 = self.create_incoming_msg(self.joe, "i'm having a problem", flow=flow)
        self.assertEqual(
            {
                "uuid": str(msg1.uuid),
                "id": msg1.id,
                "contact": {"uuid": str(self.joe.uuid), "name": "Joe Blow"},
                "channel": {"uuid": str(self.channel.uuid), "name": "Test Channel"},
                "flow": {"uuid": str(flow.uuid), "name": "Color Flow"},
                "urn": "tel:123",
                "direction": "in",
                "type": "text",
                "status": "handled",
                "visibility": "visible",
                "text": "i'm having a problem",
                "attachments": [],
                "labels": [],
                "created_on": msg1.created_on.isoformat(),
                "sent_on": None,
            },
            msg1.as_archive_json(),
        )

        # label first message
        label = self.create_label("la\02bel1")
        label.toggle_label([msg1], add=True)

        self.assertEqual(
            {
                "uuid": str(msg1.uuid),
                "id": msg1.id,
                "contact": {"uuid": str(self.joe.uuid), "name": "Joe Blow"},
                "channel": {"uuid": str(self.channel.uuid), "name": "Test Channel"},
                "flow": {"uuid": str(flow.uuid), "name": "Color Flow"},
                "urn": "tel:123",
                "direction": "in",
                "type": "text",
                "status": "handled",
                "visibility": "visible",
                "text": "i'm having a problem",
                "attachments": [],
                "labels": [{"uuid": str(label.uuid), "name": "la\x02bel1"}],
                "created_on": msg1.created_on.isoformat(),
                "sent_on": None,
            },
            msg1.as_archive_json(),
        )

        msg2 = self.create_incoming_msg(
            self.joe, "Media message", attachments=["audio:http://rapidpro.io/audio/sound.mp3"]
        )

        self.assertEqual(
            {
                "uuid": str(msg2.uuid),
                "id": msg2.id,
                "contact": {"uuid": str(self.joe.uuid), "name": "Joe Blow"},
                "channel": {"uuid": str(self.channel.uuid), "name": "Test Channel"},
                "flow": None,
                "urn": "tel:123",
                "direction": "in",
                "type": "text",
                "status": "handled",
                "visibility": "visible",
                "text": "Media message",
                "attachments": [{"url": "http://rapidpro.io/audio/sound.mp3", "content_type": "audio"}],
                "labels": [],
                "created_on": msg2.created_on.isoformat(),
                "sent_on": None,
            },
            msg2.as_archive_json(),
        )

    @patch("django.core.files.storage.default_storage.delete")
    @mock_mailroom
    def test_bulk_soft_delete(self, mr_mocks, mock_storage_delete):
        # create some messages
        msg1 = self.create_incoming_msg(
            self.joe,
            "i'm having a problem",
            attachments=[
                r"audo/mp4:http://s3.com/attachments/1/a/b.jpg",
                r"image/jpeg:http://s3.com/attachments/1/c/d%20e.jpg",
                r"http://example.com/test.mp4",  # invalid attachments are ignored
            ],
        )
        msg2 = self.create_incoming_msg(self.frank, "ignore joe, he's a liar")
        out1 = self.create_outgoing_msg(self.frank, "hi")

        label = self.create_label("Spam")
        label.toggle_label([msg1, msg2], add=True)

        self.assertEqual(2, label.get_message_count())

        # can't soft delete outgoing messages
        with self.assertRaises(AssertionError):
            Msg.bulk_soft_delete(self.org, self.admin, [out1])

        Msg.bulk_soft_delete(self.org, self.admin, [msg1, msg2])

        mock_storage_delete.assert_any_call("/attachments/1/a/b.jpg")
        mock_storage_delete.assert_any_call("/attachments/1/c/d e.jpg")
        self.assertEqual(2, mock_storage_delete.call_count)  # invalid attachment not deleted from storage

        self.assertEqual([call(self.org, self.admin, [msg1, msg2])], mr_mocks.calls["msg_delete"])

        # mailroom clears content and labels as well as updating visibility
        msg1.refresh_from_db()
        self.assertEqual(Msg.VISIBILITY_DELETED_BY_USER, msg1.visibility)
        self.assertEqual(Msg.FOLDER_DELETED, msg1.folder)
        self.assertEqual("", msg1.text)
        self.assertEqual([], msg1.attachments)
        self.assertEqual(set(), set(msg1.labels.all()))

        self.assertEqual(0, label.get_message_count())

    @patch("django.core.files.storage.default_storage.delete")
    def test_bulk_delete(self, mock_storage_delete):
        # create some messages
        msg1 = self.create_incoming_msg(
            self.joe,
            "i'm having a problem",
            attachments=[
                r"audo/mp4:http://s3.com/attachments/1/a/b.jpg",
                r"image/jpeg:http://s3.com/attachments/1/c/d%20e.jpg",
                r"http://example.com/test.mp4",  # invalid attachments are ignored
            ],
        )
        self.create_incoming_msg(self.frank, "ignore joe, he's a liar")
        out1 = self.create_outgoing_msg(self.frank, "hi")

        Msg.bulk_delete([msg1, out1])

        self.assertEqual(1, Msg.objects.all().count())

        mock_storage_delete.assert_any_call("/attachments/1/a/b.jpg")
        mock_storage_delete.assert_any_call("/attachments/1/c/d e.jpg")
        self.assertEqual(2, mock_storage_delete.call_count)  # invalid attachment not deleted from storage

    @mock_mailroom
    def test_archive_and_release(self, mr_mocks):
        msg1 = self.create_incoming_msg(self.joe, "Incoming")
        label = self.create_label("Spam")
        label.toggle_label([msg1], add=True)

        Msg.bulk_archive(self.org, [msg1])

        msg1 = Msg.objects.get(pk=msg1.pk)
        self.assertEqual(Msg.FOLDER_ARCHIVED, msg1.folder)
        self.assertEqual(set(msg1.labels.all()), {label})  # don't remove labels

        Msg.bulk_restore(self.org, [msg1])

        msg1 = Msg.objects.get(pk=msg1.id)
        self.assertEqual(Msg.FOLDER_INBOX, msg1.folder)

        msg1.delete()
        self.assertFalse(Msg.objects.filter(pk=msg1.pk).exists())

        label.refresh_from_db()
        self.assertEqual(0, label.get_messages().count())  # do remove labels
        self.assertIsNotNone(label)

        # an empty selection doesn't reach mailroom at all
        Msg.bulk_archive(self.org, [])
        Msg.bulk_restore(self.org, [])

        self.assertEqual(1, len(mr_mocks.calls["msg_archive"]))
        self.assertEqual(1, len(mr_mocks.calls["msg_restore"]))

        # can't archive outgoing messages
        msg2 = self.create_outgoing_msg(self.joe, "Outgoing")

        with self.assertRaises(AssertionError):
            Msg.bulk_archive(self.org, [msg2])

        with self.assertRaises(AssertionError):
            Msg.bulk_restore(self.org, [msg2])

    def test_release_counts(self):
        flow = self.create_flow("Test")

        def assertReleaseCount(direction, status, visibility, flow, folder):
            if direction == Msg.DIRECTION_OUT:
                msg = self.create_outgoing_msg(self.joe, "Whattup Joe", flow=flow, status=status)
            else:
                msg = self.create_incoming_msg(self.joe, "Hey hey", flow=flow, status=status)

            # write the state the way mailroom does, with the folder
            Msg.objects.filter(id=msg.id).update(visibility=visibility, folder=folder.code)

            # assert our folder count is right
            self.assertEqual(folder.get_count(self.org), 1)

            # delete the msg, count should now be 0
            msg.delete()

            self.assertEqual(folder.get_count(self.org), 0)

        # outgoing labels
        assertReleaseCount("O", Msg.STATUS_SENT, Msg.VISIBILITY_VISIBLE, None, MsgFolder.SENT)
        assertReleaseCount("O", Msg.STATUS_QUEUED, Msg.VISIBILITY_VISIBLE, None, MsgFolder.OUTBOX)
        assertReleaseCount("O", Msg.STATUS_FAILED, Msg.VISIBILITY_VISIBLE, flow, MsgFolder.FAILED)

        # incoming labels
        assertReleaseCount("I", Msg.STATUS_HANDLED, Msg.VISIBILITY_VISIBLE, None, MsgFolder.INBOX)
        assertReleaseCount("I", Msg.STATUS_HANDLED, Msg.VISIBILITY_VISIBLE, None, MsgFolder.ARCHIVED)
        assertReleaseCount("I", Msg.STATUS_HANDLED, Msg.VISIBILITY_VISIBLE, flow, MsgFolder.HANDLED)

    def test_big_ids(self):
        # create an incoming message with big id
        msg = Msg.objects.create(
            id=3_000_000_000,
            uuid=uuid7(),
            org=self.org,
            direction="I",
            contact=self.joe,
            contact_urn=self.joe.urns.first(),
            text="Hi there",
            channel=self.channel,
            status="H",
            folder="I",
            msg_type="T",
            is_android=False,
            visibility="V",
            log_uuids=[],
            created_on=timezone.now(),
            modified_on=timezone.now(),
        )
        spam = self.create_label("Spam")
        self.add_msg_label(msg, spam)

    def test_foreign_keys(self):
        # create a message which references a flow
        flow = self.create_flow("Flow")
        contact = self.create_contact("Ann", phone="+250788000001")
        msg = self.create_outgoing_msg(contact, "Hi", flow=flow)

        # Msg.flow is unconstrained so we should be able to delete these
        flow.release(self.admin, interrupt_sessions=False)
        flow.delete()

        msg.refresh_from_db()

        # but then accessing them blows up
        with self.assertRaises(Flow.DoesNotExist):
            print(msg.flow)
