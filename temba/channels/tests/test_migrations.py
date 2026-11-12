from datetime import date, datetime, time, timedelta, timezone as tz
from importlib import import_module
from unittest.mock import patch

from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from temba.channels.models import ChannelTally
from temba.msgs.models import Msg
from temba.tests import MigrationTest


class ChannelTpsNotNullTest(MigrationTest):
    app = "channels"
    migrate_from = "0225_fold_legacy_channel_tallies"
    migrate_to = "0226_channel_tps_not_null"

    def setUpBeforeMigration(self, apps):
        self.no_tps = self.create_channel("EX", "No TPS", "1234", schemes=["tel"])
        self.zero_tps = self.create_channel("EX", "Zero TPS", "2345", schemes=["tel"])
        self.own_tps = self.create_channel("EX", "Own TPS", "3456", schemes=["tel"])

        with connection.cursor() as cursor:
            cursor.execute("UPDATE channels_channel SET tps = NULL WHERE id = %s", [self.no_tps.id])
            cursor.execute("UPDATE channels_channel SET tps = 0 WHERE id = %s", [self.zero_tps.id])
            cursor.execute("UPDATE channels_channel SET tps = 45 WHERE id = %s", [self.own_tps.id])

    def test_migration(self):
        for ch in (self.no_tps, self.zero_tps, self.own_tps):
            ch.refresh_from_db()

        self.assertEqual(10, self.no_tps.tps)
        self.assertEqual(10, self.zero_tps.tps)
        self.assertEqual(45, self.own_tps.tps)

        with self.assertRaises(IntegrityError), transaction.atomic():
            self.own_tps.tps = 0
            self.own_tps.save(update_fields=("tps",))


class BackfillFailedTalliesTest(MigrationTest):
    app = "channels"
    migrate_from = "0226_channel_tps_not_null"
    migrate_to = "0227_backfill_failed_tallies"

    def setUpBeforeMigration(self, apps):
        self.today = timezone.now().date()
        self.channel2 = self.create_channel("TG", "Telegram", "1234")
        self.inactive = self.create_channel("TG", "Old", "2345")
        self.other_org = self.create_channel("TG", "Other", "3456", org=self.org2)

        contact = self.create_contact("Bob", phone="+593979000001")
        tg_contact = self.create_contact("Jim", urns=["telegram:1234"])
        other_contact = self.create_contact("Ann", urns=["telegram:3456"], org=self.org2)

        def failed(contact, channel, days_ago: int, *, reason=None, voice=False):
            created_on = datetime.combine(self.day(days_ago), time(12), tzinfo=tz.utc)
            return self.create_outgoing_msg(
                contact,
                "Hi",
                channel=channel,
                status=Msg.STATUS_FAILED,
                failed_reason=reason,
                created_on=created_on,
                voice=voice,
            )

        failed(contact, self.channel, 4)
        failed(contact, self.channel, 4, reason=Msg.FAILED_ERROR_LIMIT)
        failed(contact, self.channel, 4, reason=Msg.FAILED_LOOPING)  # failed by mailroom
        failed(contact, self.channel, 4, voice=True)
        failed(contact, self.channel, 5)
        failed(contact, self.channel, 400)
        failed(contact, self.channel, 401)  # too old
        failed(contact, self.channel, 1)
        failed(contact, self.channel, 0)
        deleted = failed(contact, self.channel, 5)
        Msg.objects.filter(id=deleted.id).update(folder=Msg.FOLDER_DELETED)
        self.create_outgoing_msg(contact, "Hi", channel=self.channel, created_on=timezone.now() - timedelta(days=1))

        # already tallied with more than remain
        failed(tg_contact, self.channel2, 2)
        self.create_channel_tally(self.channel2, "text:failed", self.day(2), 3)

        failed(tg_contact, self.inactive, 4)
        self.inactive.is_active = False
        self.inactive.save(update_fields=("is_active",))

        failed(other_contact, self.other_org, 4)

    def day(self, days_ago: int) -> date:
        return self.today - timedelta(days=days_ago)

    def assertState(self):
        def expected(days_ago: int, count: int, expires=True):
            d = self.day(days_ago)
            return f"text:failed@{d}", (count, d + timedelta(days=400) if expires else None)

        def tallies(channel):
            return {t.scope: (t.count, t.expires_on) for t in ChannelTally.objects.filter(channel=channel)}

        self.assertEqual(
            dict([expected(4, 2), expected(5, 1), expected(400, 1), expected(1, 1), expected(0, 1)]),
            tallies(self.channel),
        )
        self.assertEqual(dict([expected(2, 3, expires=False)]), tallies(self.channel2))
        self.assertEqual({}, tallies(self.inactive))
        self.assertEqual(dict([expected(4, 1)]), tallies(self.other_org))

    def test_migration(self):
        self.assertState()

        # running again is a noop
        migration = import_module("temba.channels.migrations.0227_backfill_failed_tallies")
        with patch("builtins.print") as mock_print:
            migration.backfill_failed_tallies(self.apps, None)

        mock_print.assert_not_called()
        self.assertState()

        # but raises tallies which are behind
        self.channel.tallies.filter(scope=f"text:failed@{self.day(4)}").update(count=1)
        migration.backfill_failed_tallies(self.apps, None)

        self.assertState()
