from datetime import timedelta

from django.utils import timezone

from temba.channels.models import ChannelCount
from temba.orgs.models import Org
from temba.tests import MigrationTest


class BackfillChannelTalliesTest(MigrationTest):
    app = "channels"
    migrate_from = "0220_remove_address_country_help_text"
    migrate_to = "0221_backfill_channel_tallies"

    def setUpBeforeMigration(self, apps):
        self.today = timezone.now().date()
        self.yesterday = self.today - timedelta(days=1)
        self.last_week = self.today - timedelta(days=7)
        self.expired = self.today - timedelta(days=400)

        channel1 = self.channel
        channel2 = self.create_channel("A", "Android", "+250785551212")
        channel3 = self.create_channel("A", "Android", "+250785551313", org=self.org2)

        def count(channel, day, scope, count, is_squashed=False):
            ChannelCount.objects.create(channel=channel, day=day, scope=scope, count=count, is_squashed=is_squashed)

        count(channel1, self.yesterday, "text:in", 5, is_squashed=True)
        count(channel1, self.yesterday, "text:in", 2)
        count(channel1, self.yesterday, "text:out", 3)
        count(channel1, self.last_week, "voice:in", 4)
        count(channel1, self.last_week, "voice:out", 0)
        count(channel1, self.today, "text:in", 6)
        count(channel1, self.expired, "text:in", 7)
        count(channel2, self.yesterday, "text:out", 8)
        count(channel3, self.yesterday, "text:in", 9)

        self.tally_prefix1 = f"channels/{channel1.id}/"
        self.tally_prefix2 = f"channels/{channel2.id}/"

        # yesterday's tally is incomplete and today's is being written alongside its counts
        self.org.tallies.create(scope=f"{self.tally_prefix1}text:out@{self.yesterday}", count=1)
        self.org.tallies.create(scope=f"{self.tally_prefix1}text:in@{self.today}", count=6)

        Org.objects.filter(id=self.org2.id).update(is_active=False)

    def test_migration(self):
        def expires(day):
            return day + timedelta(days=400)

        p1, p2 = self.tally_prefix1, self.tally_prefix2

        self.assertEqual(
            {
                (f"{p1}text:in@{self.yesterday}", 7, expires(self.yesterday)),
                (f"{p1}text:out@{self.yesterday}", 3, expires(self.yesterday)),
                (f"{p1}voice:in@{self.last_week}", 4, expires(self.last_week)),
                (f"{p1}text:in@{self.today}", 6, None),
                (f"{p2}text:out@{self.yesterday}", 8, expires(self.yesterday)),
            },
            set(self.org.tallies.filter(scope__startswith="channels/").values_list("scope", "count", "expires_on")),
        )
        self.assertFalse(self.org2.tallies.exists())
