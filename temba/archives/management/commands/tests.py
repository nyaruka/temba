from datetime import date
from decimal import Decimal
from io import StringIO

from django.core.management import call_command
from django.core.management.base import CommandError

from temba.archives.models import Archive
from temba.tests import TembaTest, cleanup, matchers
from temba.tests.dynamo import dynamo_scan_all
from temba.utils import dynamo
from temba.utils.uuid import is_uuid7


class SearchArchivesTest(TembaTest):
    def test_command(self):
        self.create_archive(
            Archive.TYPE_FLOWRUN,
            "D",
            date(2020, 8, 1),
            [{"id": 1, "created_on": "2020-07-30T10:00:00Z"}, {"id": 2, "created_on": "2020-07-30T15:00:00Z"}],
        )

        out = StringIO()
        call_command("search_archives", self.org.id, "run", where="", limit=10, stdout=out)

        self.assertIn('"id": 1', out.getvalue())
        self.assertIn("Fetched 2 records in", out.getvalue())


class ArchivesToHistoryTest(TembaTest):
    @cleanup(s3=True, dynamodb=True)
    def test_command(self):
        # run archive should be ignored
        self.create_archive(
            Archive.TYPE_FLOWRUN,
            "D",
            date(2025, 8, 1),
            [{"id": 1, "created_on": "2020-07-30T10:00:00Z"}, {"id": 2, "created_on": "2020-07-30T15:00:00Z"}],
        )

        # message archive with old types
        archive1 = self.create_archive(
            Archive.TYPE_MSG,
            Archive.PERIOD_DAILY,
            date(2015, 1, 1),
            [
                {
                    # regular incoming message
                    "id": 1,
                    "broadcast": None,
                    "contact": {"uuid": "abe1460e-7e97-4db4-9944-3d8d20792a2d", "name": "Ann"},
                    "urn": "tel:+16305550123",
                    "channel": {"uuid": "d0c17405-a902-4a06-8fb8-5b067a582283", "name": "Twilio"},
                    "direction": "in",
                    "type": "inbox",
                    "status": "handled",
                    "visibility": "visible",
                    "text": "sawa",
                    "attachments": [],
                    "labels": [],
                    "created_on": "2015-01-01T13:50:31+00:00",
                    "sent_on": None,
                    "modified_on": "2015-01-04T23:50:33.052089+00:00",
                },
                {
                    # IVR incoming message
                    "id": 2,
                    "broadcast": None,
                    "contact": {"uuid": "b33599af-2d97-4299-904d-2ea2d50921bb", "name": "Bob"},
                    "urn": "tel:+1234567890",
                    "channel": {"uuid": "d0c17405-a902-4a06-8fb8-5b067a582283", "name": "Twilio"},
                    "direction": "in",
                    "type": "ivr",
                    "status": "handled",
                    "visibility": "visible",
                    "text": "who's there?",
                    "attachments": [],
                    "labels": [],
                    "created_on": "2015-01-01T13:51:31+00:00",
                    "sent_on": None,
                    "modified_on": "2014-11-04T23:50:33.052089+00:00",
                },
                {
                    # old surveyor style message with no channel and no urn
                    "id": 3,
                    "broadcast": None,
                    "contact": {"uuid": "c9f65adb-efa4-4497-8527-7a7ff02df99c", "name": "Cat"},
                    "urn": None,
                    "channel": None,
                    "direction": "in",
                    "type": "flow",
                    "status": "handled",
                    "visibility": "visible",
                    "text": "sawa 2",
                    "attachments": [],
                    "labels": [],
                    "created_on": "2015-01-01T13:52:31+00:00",
                    "sent_on": None,
                    "modified_on": "2014-11-04T23:50:33.052089+00:00",
                },
                {
                    # deleted incoming message
                    "id": 4,
                    "broadcast": None,
                    "contact": {"uuid": "abe1460e-7e97-4db4-9944-3d8d20792a2d", "name": "Ann"},
                    "urn": "tel:+16305550123",
                    "channel": {"uuid": "d0c17405-a902-4a06-8fb8-5b067a582283", "name": "Twilio"},
                    "direction": "in",
                    "type": "inbox",
                    "status": "handled",
                    "visibility": "deleted",
                    "text": "bad word",
                    "attachments": [],
                    "labels": [],
                    "created_on": "2015-01-03T13:53:31+00:00",
                    "sent_on": None,
                    "modified_on": "2015-01-04T23:50:33.052089+00:00",
                },
            ],
        )

        # create archive for other org in same period
        self.create_archive(
            Archive.TYPE_MSG,
            Archive.PERIOD_DAILY,
            date(2015, 1, 1),
            [
                {
                    "id": 3456,
                    "broadcast": None,
                    "contact": {"uuid": "427b1f45-40fa-4798-9331-6d002509e582", "name": "Ann"},
                    "urn": "tel:+16305550123",
                    "channel": {"uuid": "347521d3-65f7-46a7-852d-9cd9be32471d", "name": "Twilio"},
                    "direction": "in",
                    "type": "inbox",
                    "status": "handled",
                    "visibility": "visible",
                    "text": "bonjour",
                    "attachments": [],
                    "labels": [],
                    "created_on": "2015-01-01T13:50:31+00:00",
                    "sent_on": None,
                    "modified_on": "2015-01-04T23:50:33.052089+00:00",
                },
            ],
            org=self.org2,
        )

        # message archive with new types
        self.create_archive(
            Archive.TYPE_MSG,
            Archive.PERIOD_MONTHLY,
            date(2025, 1, 1),
            [
                {
                    # unsendable broadcast message (no urn or channel)
                    "id": 5297,
                    "broadcast": 107746936,
                    "contact": {"uuid": "abe1460e-7e97-4db4-9944-3d8d20792a2d", "name": "Ann"},
                    "urn": None,
                    "channel": None,
                    "flow": None,
                    "direction": "out",
                    "type": "text",
                    "status": "failed",
                    "visibility": "visible",
                    "text": "Testing",
                    "attachments": [],
                    "labels": [],
                    "created_on": "2025-01-01T12:00:02.931134+00:00",
                    "sent_on": None,
                    "modified_on": "2025-01-01T17:00:02.931523+00:00",
                },
                {
                    "id": 5307,
                    "broadcast": None,
                    "contact": {"uuid": "b33599af-2d97-4299-904d-2ea2d50921bb", "name": "Bob"},
                    "urn": "telegram:123456",
                    "channel": {"uuid": "ce4959aa-8c85-41a4-b53e-14c3f6852f90", "name": "TG Test"},
                    "flow": {"uuid": "448bb9d0-af76-4657-96b5-aa033805542d", "name": "Cat Facts"},
                    "direction": "out",
                    "type": "text",
                    "status": "wired",
                    "visibility": "visible",
                    "text": "A cat uses its whiskers for measuring distances.",
                    "attachments": [],
                    "labels": [],
                    "created_on": "2025-01-01T14:52:49.053541+00:00",
                    "sent_on": "2025-01-01T14:52:53.773715+00:00",
                    "modified_on": "2025-01-01T14:52:53.773715+00:00",
                },
                {
                    # a message with long text that will trigger compression
                    "id": 5400,
                    "broadcast": None,
                    "contact": {"uuid": "c9f65adb-efa4-4497-8527-7a7ff02df99c", "name": "Cat"},
                    "urn": "telegram:123456",
                    "channel": {"uuid": "ce4959aa-8c85-41a4-b53e-14c3f6852f90", "name": "TG Test"},
                    "flow": {"uuid": "448bb9d0-af76-4657-96b5-aa033805542d", "name": "Cat Facts"},
                    "direction": "out",
                    "type": "text",
                    "status": "wired",
                    "visibility": "visible",
                    "text": "helloworld" * 1000,
                    "attachments": [],
                    "labels": [],
                    "created_on": "2025-01-01T14:53:49.053541+00:00",
                    "sent_on": "2025-01-01T14:53:53.773715+00:00",
                    "modified_on": "2025-01-01T14:53:53.773715+00:00",
                },
            ],
        )

        # try to import archives - should fail because they lack UUIDs
        with self.assertRaises(CommandError):
            self._call("archives_to_history", "import")

        self.assertEqual([], dynamo_scan_all(dynamo.HISTORY))  # nothing imported

        # update 2015 archives
        output = self._call(
            "archives_to_history", "update", "--org", str(self.org.id), "--since", "2015-01-01", "--until", "2015-12-31"
        )
        self.assertIn("updating archives for 'Nyaruka'", output)
        self.assertIn("rewriting D:2015-01-01", output)
        self.assertIn("(4 records, 4 updated)", output)

        archive1.refresh_from_db()
        self.assertEqual(4, archive1.record_count)
        self.assertEqual(f"test-archives:{self.org.id}/message_D20150101_{archive1.hash}.jsonl.gz", archive1.location)
        records = list(archive1.iter_records())
        self.assertEqual(4, len(records))
        self.assertIn("uuid", records[0])
        self.assertTrue(is_uuid7(records[0]["uuid"]))

        # can run again and no updates needed
        output = self._call(
            "archives_to_history", "update", "--org", str(self.org.id), "--since", "2015-01-01", "--until", "2015-12-31"
        )
        self.assertIn("updating archives for 'Nyaruka'", output)
        self.assertIn("rewriting D:2015-01-01", output)
        self.assertIn("(4 records, 0 updated)", output)

        archive1.refresh_from_db()
        self.assertEqual(4, archive1.record_count)
        self.assertEqual(f"test-archives:{self.org.id}/message_D20150101_{archive1.hash}.jsonl.gz", archive1.location)
        self.assertEqual(4, len(list(archive1.iter_records())))

        # update 2025 archives
        output = self._call(
            "archives_to_history", "update", "--org", str(self.org.id), "--since", "2025-01-01", "--until", "2025-12-31"
        )
        self.assertIn("updating archives for 'Nyaruka'", output)
        self.assertIn("rewriting M:2025-01-01", output)
        self.assertIn("(3 records, 3 updated)", output)

        # import 2015 archives
        output = self._call(
            "archives_to_history", "import", "--org", str(self.org.id), "--since", "2015-01-01", "--until", "2015-12-31"
        )
        self.assertIn("importing archives for 'Nyaruka'", output)
        self.assertIn("importing D:2015-01-01", output)
        self.assertIn("(4 imported)", output)

        # import all archives (will repeat 2015 archives but ok because importation is idempotent)
        output = self._call("archives_to_history", "import", "--org", str(self.org.id))
        self.assertIn("importing archives for 'Nyaruka'", output)
        self.assertIn("importing D:2015-01-01", output)
        self.assertIn("(4 imported)", output)
        self.assertIn("importing M:2025-01-01", output)
        self.assertIn("(3 imported)", output)
        self.assertIn("7 records imported.", output)

        items = dynamo_scan_all(dynamo.HISTORY)
        self.assertEqual(
            [
                {
                    "PK": "con#abe1460e-7e97-4db4-9944-3d8d20792a2d",
                    "SK": matchers.String(pattern="evt#[0-9a-fA-F-]{36}"),
                    "OrgID": Decimal(self.org.id),
                    "Data": {
                        "type": "msg_received",
                        "created_on": "2015-01-01T13:50:31+00:00",
                        "msg": {
                            "text": "sawa",
                            "channel": {"uuid": "d0c17405-a902-4a06-8fb8-5b067a582283", "name": "Twilio"},
                            "urn": "tel:+16305550123",
                        },
                    },
                    "Src": "archives",
                },
                {
                    "PK": "con#abe1460e-7e97-4db4-9944-3d8d20792a2d",
                    "SK": matchers.String(pattern="evt#[0-9a-fA-F-]{36}"),
                    "OrgID": Decimal(self.org.id),
                    "Data": {
                        "type": "msg_received",
                        "created_on": "2015-01-03T13:53:31+00:00",
                        "msg": {
                            "text": "bad word",
                            "channel": {"uuid": "d0c17405-a902-4a06-8fb8-5b067a582283", "name": "Twilio"},
                            "urn": "tel:+16305550123",
                        },
                    },
                    "Src": "archives",
                },
                {
                    "PK": "con#abe1460e-7e97-4db4-9944-3d8d20792a2d",
                    "SK": matchers.String(pattern="evt#[0-9a-fA-F-]{36}#del"),
                    "OrgID": Decimal(self.org.id),
                    "Data": {"created_on": "2015-01-03T13:53:31+00:00"},
                    "Src": "archives",
                },
                {
                    "PK": "con#abe1460e-7e97-4db4-9944-3d8d20792a2d",
                    "SK": matchers.String(pattern="evt#[0-9a-fA-F-]{36}"),
                    "OrgID": Decimal(self.org.id),
                    "Data": {
                        "type": "msg_created",
                        "created_on": "2025-01-01T12:00:02.931134+00:00",
                        "msg": {
                            "text": "Testing",
                            "broadcast_uuid": matchers.UUIDString(version=7),
                            "unsendable_reason": "no_route",
                        },
                    },
                    "Src": "archives",
                },
                {
                    "PK": "con#b33599af-2d97-4299-904d-2ea2d50921bb",
                    "SK": matchers.String(pattern="evt#[0-9a-fA-F-]{36}"),
                    "OrgID": Decimal(self.org.id),
                    "Data": {
                        "type": "msg_received",
                        "created_on": "2015-01-01T13:51:31+00:00",
                        "msg": {
                            "text": "who's there?",
                            "channel": {"uuid": "d0c17405-a902-4a06-8fb8-5b067a582283", "name": "Twilio"},
                            "urn": "tel:+1234567890",
                        },
                    },
                    "Src": "archives",
                },
                {
                    "PK": "con#b33599af-2d97-4299-904d-2ea2d50921bb",
                    "SK": matchers.String(pattern="evt#[0-9a-fA-F-]{36}"),
                    "OrgID": Decimal(self.org.id),
                    "Data": {
                        "type": "msg_created",
                        "created_on": "2025-01-01T14:52:49.053541+00:00",
                        "msg": {
                            "text": "A cat uses its whiskers for measuring distances.",
                            "urn": "telegram:123456",
                            "channel": {"uuid": "ce4959aa-8c85-41a4-b53e-14c3f6852f90", "name": "TG Test"},
                        },
                    },
                    "Src": "archives",
                },
                {
                    "PK": "con#b33599af-2d97-4299-904d-2ea2d50921bb",
                    "SK": matchers.String(pattern="evt#[0-9a-fA-F-]{36}#sts"),
                    "OrgID": Decimal(self.org.id),
                    "Data": {"created_on": "2025-01-01T14:52:49.053541+00:00", "status": "wired"},
                    "Src": "archives",
                },
                {
                    "PK": "con#c9f65adb-efa4-4497-8527-7a7ff02df99c",
                    "SK": matchers.String(pattern="evt#[0-9a-fA-F-]{36}"),
                    "OrgID": Decimal(self.org.id),
                    "Data": {
                        "type": "msg_received",
                        "created_on": "2015-01-01T13:52:31+00:00",
                        "msg": {"text": "sawa 2"},
                    },
                    "Src": "archives",
                },
                {
                    "PK": "con#c9f65adb-efa4-4497-8527-7a7ff02df99c",
                    "SK": matchers.String(pattern="evt#[0-9a-fA-F-]{36}"),
                    "OrgID": Decimal(self.org.id),
                    "Data": {"type": "msg_created"},
                    "DataGZ": matchers.GZippedJSON(
                        {
                            "type": "msg_created",
                            "created_on": "2025-01-01T14:53:49.053541+00:00",
                            "msg": {
                                "text": "helloworld" * 1000,
                                "urn": "telegram:123456",
                                "channel": {"uuid": "ce4959aa-8c85-41a4-b53e-14c3f6852f90", "name": "TG Test"},
                            },
                        }
                    ),
                    "Src": "archives",
                },
                {
                    "PK": "con#c9f65adb-efa4-4497-8527-7a7ff02df99c",
                    "SK": matchers.String(pattern="evt#[0-9a-fA-F-]{36}#sts"),
                    "OrgID": Decimal(self.org.id),
                    "Data": {"created_on": "2025-01-01T14:53:49.053541+00:00", "status": "wired"},
                    "Src": "archives",
                },
            ],
            items,
        )

    def _call(self, cmd, *args) -> str:
        out = StringIO()
        call_command(cmd, *args, stdout=out)
        return out.getvalue()
