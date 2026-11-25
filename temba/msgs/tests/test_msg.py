from datetime import timedelta
from unittest.mock import call, patch

from django.utils import timezone

from temba.flows.models import Flow
from temba.msgs.models import Msg, MsgFolder
from temba.msgs.tasks import fail_old_android_messages
from temba.tests import CRUDLTestMixin, TembaTest, mock_mailroom
from temba.utils.uuid import uuid7


class MsgTest(TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        self.joe = self.create_contact("Joe Blow", urns=["tel:789", "tel:123"])
        self.frank = self.create_contact("Frank Blow", phone="321")
        self.kevin = self.create_contact("Kevin Durant", phone="987")

        self.just_joe = self.create_group("Just Joe", [self.joe])
        self.joe_and_frank = self.create_group("Joe and Frank", [self.joe, self.frank])

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

    def test_as_json_logs_url_without_user_or_org(self):
        # defensive guard in _get_logs_url: a truthy context missing user/org returns None rather than raising
        msg = self.create_incoming_msg(self.joe, "hi")
        self.assertIsNone(msg._get_logs_url({"unrelated": "value"}))

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
            ],
        )
        msg2 = self.create_incoming_msg(self.frank, "ignore joe, he's a liar")
        out1 = self.create_outgoing_msg(self.frank, "hi")

        # can't soft delete outgoing messages
        with self.assertRaises(AssertionError):
            Msg.bulk_soft_delete(self.org, self.admin, [out1])

        Msg.bulk_soft_delete(self.org, self.admin, [msg1, msg2])

        mock_storage_delete.assert_any_call("/attachments/1/a/b.jpg")
        mock_storage_delete.assert_any_call("/attachments/1/c/d e.jpg")

        self.assertEqual([call(self.org, self.admin, [msg1, msg2])], mr_mocks.calls["msg_delete"])

    @patch("django.core.files.storage.default_storage.delete")
    def test_bulk_delete(self, mock_storage_delete):
        # create some messages
        msg1 = self.create_incoming_msg(
            self.joe,
            "i'm having a problem",
            attachments=[
                r"audo/mp4:http://s3.com/attachments/1/a/b.jpg",
                r"image/jpeg:http://s3.com/attachments/1/c/d%20e.jpg",
            ],
        )
        self.create_incoming_msg(self.frank, "ignore joe, he's a liar")
        out1 = self.create_outgoing_msg(self.frank, "hi")

        Msg.bulk_delete([msg1, out1])

        self.assertEqual(1, Msg.objects.all().count())

        mock_storage_delete.assert_any_call("/attachments/1/a/b.jpg")
        mock_storage_delete.assert_any_call("/attachments/1/c/d e.jpg")

    def test_archive_and_release(self):
        msg1 = self.create_incoming_msg(self.joe, "Incoming")
        label = self.create_label("Spam")
        label.toggle_label([msg1], add=True)

        msg1.archive()

        msg1 = Msg.objects.get(pk=msg1.pk)
        self.assertEqual(msg1.visibility, Msg.VISIBILITY_ARCHIVED)
        self.assertEqual(set(msg1.labels.all()), {label})  # don't remove labels

        msg1.restore()

        msg1 = Msg.objects.get(pk=msg1.id)
        self.assertEqual(msg1.visibility, Msg.VISIBILITY_VISIBLE)

        msg1.delete()
        self.assertFalse(Msg.objects.filter(pk=msg1.pk).exists())

        label.refresh_from_db()
        self.assertEqual(0, label.get_messages().count())  # do remove labels
        self.assertIsNotNone(label)

        # can't archive outgoing messages
        msg2 = self.create_outgoing_msg(self.joe, "Outgoing")
        self.assertRaises(AssertionError, msg2.archive)

    def test_release_counts(self):
        flow = self.create_flow("Test")

        def assertReleaseCount(direction, status, visibility, flow, folder):
            if direction == Msg.DIRECTION_OUT:
                msg = self.create_outgoing_msg(self.joe, "Whattup Joe", flow=flow, status=status)
            else:
                msg = self.create_incoming_msg(self.joe, "Hey hey", flow=flow, status=status)

            Msg.objects.filter(id=msg.id).update(visibility=visibility)

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
        assertReleaseCount("I", Msg.STATUS_HANDLED, Msg.VISIBILITY_ARCHIVED, None, MsgFolder.ARCHIVED)
        assertReleaseCount("I", Msg.STATUS_HANDLED, Msg.VISIBILITY_VISIBLE, flow, MsgFolder.HANDLED)

    def test_fail_old_android_messages(self):
        msg1 = self.create_outgoing_msg(self.joe, "Hello", status=Msg.STATUS_QUEUED)
        msg2 = self.create_outgoing_msg(
            self.joe, "Hello", status=Msg.STATUS_QUEUED, created_on=timezone.now() - timedelta(days=8)
        )
        msg3 = self.create_outgoing_msg(
            self.joe, "Hello", status=Msg.STATUS_ERRORED, created_on=timezone.now() - timedelta(days=8)
        )
        msg4 = self.create_outgoing_msg(
            self.joe, "Hello", status=Msg.STATUS_SENT, created_on=timezone.now() - timedelta(days=8)
        )

        fail_old_android_messages()

        def assert_status(msg, status):
            msg.refresh_from_db()
            self.assertEqual(status, msg.status)

        assert_status(msg1, Msg.STATUS_QUEUED)
        assert_status(msg2, Msg.STATUS_FAILED)
        assert_status(msg3, Msg.STATUS_FAILED)
        assert_status(msg4, Msg.STATUS_SENT)

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
            msg_type="T",
            is_android=False,
            visibility="V",
            log_uuids=[],
            created_on=timezone.now(),
            modified_on=timezone.now(),
        )
        spam = self.create_label("Spam")
        msg.labels.add(spam)

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
