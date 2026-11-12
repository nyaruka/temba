from datetime import date, datetime, time, timedelta, timezone as tz
from importlib import import_module
from unittest.mock import patch

from django.utils import timezone

from temba.channels.models import Channel, ChannelTally
from temba.contacts.models import URN
from temba.msgs.models import Msg
from temba.orgs.models import OrgTally
from temba.tests import MigrationTest
from temba.triggers.models import Trigger


class DeactivateRemovedTypeChannelsTest(MigrationTest):
    app = "channels"
    migrate_from = "0222_drop_channelcount"
    migrate_to = "0223_deactivate_removed_type_channels"

    def setUpBeforeMigration(self, apps):
        # these types no longer exist so their channels have to be created directly
        self.removed1 = self._create_channel("DK", "1234")
        self.removed2 = self._create_channel("H9", "2345")
        self.removed3 = self._create_channel("DK", "4567", is_active=False)
        self.other = self.create_channel("EX", "External", "3456", schemes=[URN.TEL_SCHEME])

        flow = self.create_flow("Test")
        self.removed1_trigger = self._create_trigger(flow, self.removed1)
        self.removed3_trigger = self._create_trigger(flow, self.removed3)
        self.other_trigger = self._create_trigger(flow, self.other)

    def _create_channel(self, channel_type: str, address: str, is_active: bool = True):
        return Channel.objects.create(
            org=self.org,
            channel_type=channel_type,
            name="Old",
            address=address,
            config={},
            role=Channel.DEFAULT_ROLE,
            schemes=[URN.TEL_SCHEME],
            created_by=self.admin,
            modified_by=self.admin,
            is_active=is_active,
        )

    def _create_trigger(self, flow, channel):
        return Trigger.objects.create(
            org=self.org,
            trigger_type=Trigger.TYPE_NEW_CONVERSATION,
            flow=flow,
            channel=channel,
            priority=0,
            created_by=self.admin,
            modified_by=self.admin,
        )

    def test_migration(self):
        for ch in (self.removed1, self.removed2, self.other):
            ch.refresh_from_db()

        self.assertFalse(self.removed1.is_active)
        self.assertFalse(self.removed2.is_active)
        self.assertTrue(self.other.is_active)

        for trigger in (self.removed1_trigger, self.removed3_trigger, self.other_trigger):
            trigger.refresh_from_db()

        self.assertFalse(self.removed1_trigger.is_active)
        self.assertTrue(self.removed1_trigger.is_archived)
        self.assertFalse(self.removed3_trigger.is_active)  # channel was already inactive
        self.assertTrue(self.removed3_trigger.is_archived)
        self.assertTrue(self.other_trigger.is_active)
        self.assertFalse(self.other_trigger.is_archived)


class FoldLegacyChannelTalliesTest(MigrationTest):
    app = "channels"
    migrate_from = "0224_channeltally"
    migrate_to = "0225_fold_legacy_channel_tallies"

    def setUpBeforeMigration(self, apps):
        self.channel2 = self.create_channel("TG", "Telegram", "1234")
        self.inactive = self.create_channel("TG", "Old", "2345")
        self.inactive.is_active = False
        self.inactive.save(update_fields=("is_active",))

        # a channel whose id starts with another's
        self.channel10 = Channel.objects.create(
            id=self.channel.id * 10,
            org=self.org,
            channel_type="TG",
            name="Ten",
            address="3456",
            config={},
            role=Channel.DEFAULT_ROLE,
            schemes=[URN.TELEGRAM_SCHEME],
            created_by=self.admin,
            modified_by=self.admin,
        )
        self.deleted_id = self.channel.id * 100

        def legacy(org, channel_id, scope, count, expires_on=None):
            org.org_tallies.create(scope=f"channels/{channel_id}/{scope}", count=count, expires_on=expires_on)

        # no channel tally yet, with and without expiry
        legacy(self.org, self.channel.id, "text:in@2026-11-01", 3, date(2027, 2, 1))
        legacy(self.org, self.channel.id, "voice:out@2026-11-01", 4)

        # added onto existing channel tallies for the same day
        legacy(self.org, self.channel.id, "text:out@2026-11-01", 5, date(2027, 2, 1))
        self.channel.tallies.create(scope="text:out@2026-11-01", count=6, expires_on=date(2027, 3, 1))
        legacy(self.org, self.channel2.id, "text:in@2026-11-01", 7, date(2027, 4, 1))
        self.channel2.tallies.create(scope="text:in@2026-11-01", count=8, expires_on=date(2027, 3, 1))
        legacy(self.org, self.channel2.id, "text:out@2026-11-01", 9)
        self.channel2.tallies.create(scope="text:out@2026-11-01", count=10, expires_on=date(2027, 3, 1))

        legacy(self.org, self.inactive.id, "text:in@2026-11-01", 11)
        legacy(self.org, self.channel10.id, "text:in@2026-11-01", 12)

        # channels that don't exist, in this org or at all
        legacy(self.org2, self.channel.id, "text:in@2026-11-01", 13)
        legacy(self.org, self.deleted_id, "text:in@2026-11-01", 14)

        # unrelated org tallies
        self.org.org_tallies.create(scope="msgs/text:in@2026-11-01", count=15)
        self.org.org_tallies.create(scope="channels/abc/text:in@2026-11-01", count=16)
        self.org.org_tallies.create(scope="channelsx/1/text:in@2026-11-01", count=17)
        self.org.org_tallies.create(scope=f"channels/0{self.channel.id}/text:in@2026-11-01", count=18)

    def assertTallies(self, channel, expected: dict):
        self.assertEqual(
            expected, {t.scope: (t.count, t.expires_on) for t in ChannelTally.objects.filter(channel=channel)}
        )

    def assertState(self):
        self.assertTallies(
            self.channel,
            {
                "text:in@2026-11-01": (3, date(2027, 2, 1)),
                "voice:out@2026-11-01": (4, None),
                "text:out@2026-11-01": (11, date(2027, 3, 1)),
            },
        )
        self.assertTallies(
            self.channel2,
            {"text:in@2026-11-01": (15, date(2027, 4, 1)), "text:out@2026-11-01": (19, None)},
        )
        self.assertTallies(self.inactive, {"text:in@2026-11-01": (11, None)})
        self.assertTallies(self.channel10, {"text:in@2026-11-01": (12, None)})
        self.assertEqual(7, ChannelTally.objects.count())  # nothing else created

        self.assertEqual(
            {
                (self.org.id, "msgs/text:in@2026-11-01"): 15,
                (self.org.id, "channels/abc/text:in@2026-11-01"): 16,
                (self.org.id, "channelsx/1/text:in@2026-11-01"): 17,
                (self.org.id, f"channels/0{self.channel.id}/text:in@2026-11-01"): 18,
            },
            {(t.org_id, t.scope): t.count for t in OrgTally.objects.all()},
        )

    def test_migration(self):
        migration = import_module("temba.channels.migrations.0225_fold_legacy_channel_tallies")
        fold = migration.fold_legacy_channel_tallies

        self.assertState()

        # running again is a noop
        fold(self.apps, None)
        self.assertState()

        # but moves legacy tallies flushed since
        self.org.org_tallies.create(scope=f"channels/{self.channel.id}/text:in@2026-11-01", count=20)
        fold(self.apps, None)

        self.assertEqual(23, self.channel.tallies.get(scope="text:in@2026-11-01").count)
        self.assertFalse(
            OrgTally.objects.filter(scope__startswith="channels/").exclude(scope__regex=r"^channels/(abc|0)").exists()
        )

        # batches are bounded
        for d in range(1, 6):
            self.org.org_tallies.create(scope=f"channels/{self.channel2.id}/voice:in@2026-11-0{d}", count=d)
        with patch.object(migration, "BATCH_SIZE", 2):
            fold(self.apps, None)

        self.assertEqual(
            {f"voice:in@2026-11-0{d}": d for d in range(1, 6)},
            {t.scope: t.count for t in self.channel2.tallies.filter(scope__startswith="voice:in")},
        )


class BackfillFailedTalliesTest(MigrationTest):
    app = "channels"
    migrate_from = "0225_fold_legacy_channel_tallies"
    migrate_to = "0226_backfill_failed_tallies"

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

        failed(contact, self.channel, 1)
        failed(contact, self.channel, 1, reason=Msg.FAILED_ERROR_LIMIT)
        failed(contact, self.channel, 1, reason=Msg.FAILED_LOOPING)  # failed by mailroom
        failed(contact, self.channel, 1, voice=True)
        failed(contact, self.channel, 5)
        failed(contact, self.channel, 400)
        failed(contact, self.channel, 401)  # too old
        failed(contact, self.channel, 0)  # today
        deleted = failed(contact, self.channel, 5)
        Msg.objects.filter(id=deleted.id).update(folder=Msg.FOLDER_DELETED)
        self.create_outgoing_msg(contact, "Hi", channel=self.channel, created_on=timezone.now() - timedelta(days=1))

        # already tallied with more than remain
        failed(tg_contact, self.channel2, 2)
        self.create_channel_tally(self.channel2, "text:failed", self.day(2), 3)

        failed(tg_contact, self.inactive, 1)
        self.inactive.is_active = False
        self.inactive.save(update_fields=("is_active",))

        failed(other_contact, self.other_org, 1)

    def day(self, days_ago: int) -> date:
        return self.today - timedelta(days=days_ago)

    def assertState(self):
        def expected(days_ago: int, count: int, expires=True):
            d = self.day(days_ago)
            return f"text:failed@{d}", (count, d + timedelta(days=400) if expires else None)

        def tallies(channel):
            return {t.scope: (t.count, t.expires_on) for t in ChannelTally.objects.filter(channel=channel)}

        self.assertEqual(dict([expected(1, 2), expected(5, 1), expected(400, 1)]), tallies(self.channel))
        self.assertEqual(dict([expected(2, 3, expires=False)]), tallies(self.channel2))
        self.assertEqual({}, tallies(self.inactive))
        self.assertEqual(dict([expected(1, 1)]), tallies(self.other_org))

    def test_migration(self):
        self.assertState()

        # running again is a noop
        migration = import_module("temba.channels.migrations.0226_backfill_failed_tallies")
        with patch("builtins.print") as mock_print:
            migration.backfill_failed_tallies(self.apps, None)

        mock_print.assert_not_called()
        self.assertState()

        # but raises tallies which are behind
        self.channel.tallies.filter(scope=f"text:failed@{self.day(1)}").update(count=1)
        migration.backfill_failed_tallies(self.apps, None)

        self.assertState()
