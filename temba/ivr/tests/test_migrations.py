from datetime import date, datetime, time, timedelta, timezone as tzone
from decimal import Decimal
from importlib import import_module
from unittest.mock import patch

from django.utils import timezone

from temba.channels.models import ChannelTally
from temba.ivr.models import Call
from temba.orgs.models import OrgTally
from temba.tests import MigrationTest, cleanup, matchers
from temba.tests.dynamo import dynamo_scan_all
from temba.utils import dynamo
from temba.utils.uuid import uuid7


class BackfillCallEventsTest(MigrationTest):
    app = "ivr"
    migrate_from = "0038_alter_call_uuid"
    migrate_to = "0039_backfill_call_events"

    def setUpBeforeMigration(self, apps):
        contact = self.create_contact("Ann", phone="+1234567890", uuid="40248365-230d-4a29-8dbc-c89e43dd3adf")
        deleted_contact = self.create_contact("Deleted", uuid="1d48402f-df4c-44d8-b648-e0180f6a0dd2", is_active=False)

        Call.objects.create(
            uuid="0198e29d-a536-7cf4-b78b-a33eebe0ce58",
            org=self.org,
            channel=self.channel,
            direction=Call.DIRECTION_IN,
            contact=contact,
            contact_urn=contact.get_urn(),
            status=Call.STATUS_IN_PROGRESS,
            created_on=datetime(2025, 8, 11, 20, 36, 0, 0, tzinfo=tzone.utc),
        )
        Call.objects.create(
            uuid="0198e29d-c924-7047-ba48-e980b817c7ca",
            org=self.org,
            channel=self.channel,
            direction=Call.DIRECTION_OUT,
            contact=contact,
            contact_urn=contact.get_urn(),
            status=Call.STATUS_IN_PROGRESS,
            created_on=datetime(2025, 8, 11, 20, 38, 0, 0, tzinfo=tzone.utc),
        )
        Call.objects.create(  # for a deleted contact
            uuid="0198e29e-49b1-7475-860f-b2d39e6c2831",
            org=self.org,
            channel=self.channel,
            direction=Call.DIRECTION_IN,
            contact=deleted_contact,
            contact_urn=contact.get_urn(),
            status=Call.STATUS_IN_PROGRESS,
            created_on=datetime(2025, 8, 11, 20, 36, 0, 0, tzinfo=tzone.utc),
        )

    @cleanup(dynamodb=True)
    def test_migration(self):
        items = dynamo_scan_all(dynamo.HISTORY)
        self.assertEqual(
            [
                {
                    "PK": "con#40248365-230d-4a29-8dbc-c89e43dd3adf",
                    "SK": matchers.String(pattern=r"evt#[a-z0-9\-]{36}"),
                    "OrgID": Decimal(self.org.id),
                    "Data": {
                        "type": "call_received",
                        "created_on": "2025-08-11T20:36:00+00:00",
                        "call": {
                            "uuid": "0198e29d-a536-7cf4-b78b-a33eebe0ce58",
                            "urn": "tel:1234567890",
                            "channel": {"uuid": str(self.channel.uuid), "name": self.channel.name},
                        },
                    },
                },
                {
                    "PK": "con#40248365-230d-4a29-8dbc-c89e43dd3adf",
                    "SK": matchers.String(pattern=r"evt#[a-z0-9\-]{36}"),
                    "OrgID": Decimal(self.org.id),
                    "Data": {
                        "type": "call_created",
                        "created_on": "2025-08-11T20:38:00+00:00",
                        "call": {
                            "uuid": "0198e29d-c924-7047-ba48-e980b817c7ca",
                            "urn": "tel:1234567890",
                            "channel": {"uuid": str(self.channel.uuid), "name": self.channel.name},
                        },
                    },
                },
            ],
            items,
        )


class BackfillCallTalliesTest(MigrationTest):
    app = "ivr"
    migrate_from = "0043_remove_call_calls_org_created_on"
    migrate_to = "0044_backfill_call_tallies"

    def setUpBeforeMigration(self, apps):
        self.today = timezone.now().date()
        self.channel2 = self.create_channel("T", "Twilio", "1234")
        self.inactive = self.create_channel("T", "Old", "2345")
        self.other_org = self.create_channel("T", "Other", "3456", org=self.org2)

        contact = self.create_contact("Bob", phone="+593979000001")
        other_contact = self.create_contact("Ann", phone="+593979000002", org=self.org2)

        def call(channel, days_ago: int, direction=Call.DIRECTION_OUT, *, contact=contact):
            Call.objects.create(
                uuid=uuid7(),
                org=channel.org,
                channel=channel,
                direction=direction,
                contact=contact,
                contact_urn=contact.get_urn(),
                status=Call.STATUS_COMPLETED,
                created_on=datetime.combine(self.day(days_ago), time(12), tzinfo=tzone.utc),
            )

        call(self.channel, 4)
        call(self.channel, 4)
        call(self.channel, 4, Call.DIRECTION_IN)
        call(self.channel, 400)
        call(self.channel, 401)  # too old for the channel but not the org
        call(self.channel, 0, Call.DIRECTION_IN)
        call(self.channel2, 4)

        # already tallied with more than remain
        call(self.channel2, 2, Call.DIRECTION_IN)
        self.create_channel_tally(self.channel2, "calls:in", self.day(2), 3)
        self.org.org_tallies.create(scope=f"calls/in@{self.day(2)}", count=3)

        call(self.inactive, 4)
        self.inactive.is_active = False
        self.inactive.save(update_fields=("is_active",))

        call(self.other_org, 4, contact=other_contact)

    def day(self, days_ago: int) -> date:
        return self.today - timedelta(days=days_ago)

    def assertState(self):
        def ch(scope: str, days_ago: int, count: int, expires=True):
            d = self.day(days_ago)
            return f"{scope}@{d}", (count, d + timedelta(days=400) if expires else None)

        def channel_tallies(channel):
            return {t.scope: (t.count, t.expires_on) for t in ChannelTally.objects.filter(channel=channel)}

        def org_tallies(org):
            return {t.scope: t.count for t in OrgTally.objects.filter(org=org, scope__startswith="calls/")}

        self.assertEqual(
            dict([ch("calls:out", 4, 2), ch("calls:in", 4, 1), ch("calls:out", 400, 1), ch("calls:in", 0, 1)]),
            channel_tallies(self.channel),
        )
        self.assertEqual(
            dict([ch("calls:out", 4, 1), ch("calls:in", 2, 3, expires=False)]), channel_tallies(self.channel2)
        )
        self.assertEqual({}, channel_tallies(self.inactive))
        self.assertEqual(dict([ch("calls:out", 4, 1)]), channel_tallies(self.other_org))

        self.assertEqual(
            {
                f"calls/out@{self.day(4)}": 4,  # includes the inactive channel's
                f"calls/in@{self.day(4)}": 1,
                f"calls/in@{self.day(2)}": 3,
                f"calls/out@{self.day(400)}": 1,
                f"calls/out@{self.day(401)}": 1,
                f"calls/in@{self.day(0)}": 1,
            },
            org_tallies(self.org),
        )
        self.assertEqual({f"calls/out@{self.day(4)}": 1}, org_tallies(self.org2))
        self.assertFalse(OrgTally.objects.filter(scope__startswith="calls/").exclude(expires_on=None).exists())

    def test_migration(self):
        self.assertState()

        # running again is a noop
        migration = import_module("temba.ivr.migrations.0044_backfill_call_tallies")
        with patch("builtins.print") as mock_print:
            migration.backfill_call_tallies(self.apps, None)

        mock_print.assert_not_called()
        self.assertState()

        # but raises tallies which are behind
        self.channel.tallies.filter(scope=f"calls:out@{self.day(4)}").update(count=1)
        self.org.org_tallies.filter(scope=f"calls/out@{self.day(4)}").update(count=1)
        migration.backfill_call_tallies(self.apps, None)

        self.assertState()
