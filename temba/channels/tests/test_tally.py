from datetime import date, datetime, timezone as tzone
from unittest.mock import patch

from django_valkey import get_valkey_connection

from temba.channels.models import ChannelTally
from temba.tests import TembaTest, cleanup


class ChannelTallyTest(TembaTest):
    @cleanup(valkey=True)
    def test_get_daily_totals_by_channel(self):
        r = get_valkey_connection()
        channel2 = self.create_channel("TG", "Telegram", "1234")
        other_org_channel = self.create_channel("A", "Android", "+250785551313", org=self.org2)

        self.channel.tallies.create(scope="text:in@2026-11-01", count=1)
        self.channel.tallies.create(scope="text:in@2026-11-04", count=2)
        self.channel.tallies.create(scope="text:out@2026-11-04", count=3)
        channel2.tallies.create(scope="text:in@2026-11-04", count=4)
        other_org_channel.tallies.create(scope="text:in@2026-11-04", count=5)

        # only today's are read from Valkey
        r.hset(
            "{tallies}:live",
            mapping={
                f"C{self.channel.id}|text:in@2026-11-05": 100,
                f"C{self.channel.id}|text:in@2026-11-04": 1000,
            },
        )

        with patch("django.utils.timezone.now", return_value=datetime(2026, 11, 5, 12, 0, 0, 0, tzone.utc)):
            self.assertEqual(
                {
                    (self.channel.id, date(2026, 11, 4), "text:in"): 2,
                    (self.channel.id, date(2026, 11, 5), "text:in"): 100,
                    (self.channel.id, date(2026, 11, 4), "text:out"): 3,
                    (channel2.id, date(2026, 11, 4), "text:in"): 4,
                    (other_org_channel.id, date(2026, 11, 4), "text:in"): 5,
                },
                ChannelTally.get_daily_totals_by_channel(
                    [self.channel, channel2, other_org_channel],
                    ["text:in", "text:out"],
                    date(2026, 11, 2),
                    date(2026, 11, 6),
                ),
            )

            self.assertEqual(
                {}, ChannelTally.get_daily_totals_by_channel([], ["text:in"], date(2026, 11, 1), date(2026, 11, 6))
            )
