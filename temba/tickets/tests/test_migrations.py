from datetime import timedelta
from importlib import import_module
from unittest.mock import patch

from django.utils import timezone

from temba.tests import MigrationTest


class BackfillTicketTalliesTest(MigrationTest):
    app = "tickets"
    migrate_from = "0104_drop_team_is_active"
    migrate_to = "0105_backfill_ticket_tallies"

    def setUpBeforeMigration(self, apps):
        self.today = timezone.now().date()

        def day(days_ago: int):
            return self.today - timedelta(days=days_ago)

        def count(org, scope: str, days_ago: int, n: int):
            org.daily_counts.create(day=day(days_ago), scope=scope, count=n)

        def tally(org, scope: str, days_ago: int, n: int):
            org.org_tallies.create(scope=f"tickets/{scope}@{day(days_ago)}", count=n)

        self.day = day

        # mailroom started tallying 3 days ago, partway through the day
        count(self.org, "tickets:opened:0", 10, 2)
        count(self.org, "tickets:opened:0", 10, 1)  # unsquashed
        count(self.org, "tickets:opened:5", 3, 4)
        tally(self.org, "opened:5", 3, 1)
        count(self.org, "tickets:assigned:0:7", 10, 1)
        count(self.org, "tickets:assigned:2:7", 10, 2)
        count(self.org, "msgs:ticketreplies:2:7", 10, 3)
        count(self.org, "msgs:ticketreplies:2:8", 10, 1)

        # response times, including a first reply since tallying started to a ticket opened before
        count(self.org, "ticketresptime:total", 20, 500)
        count(self.org, "ticketresptime:count", 20, 2)
        tally(self.org, "resptime:total", 20, 100)
        tally(self.org, "resptime:count", 20, 1)
        count(self.org, "ticketresptime:0:7:total", 30, 60)  # older format

        # after tallying started, so not copied
        count(self.org, "tickets:opened:5", 2, 6)
        tally(self.org, "opened:5", 2, 6)
        count(self.org, "tickets:opened:5", 1, 3)

        # unrelated counts and tallies
        count(self.org, "msgs:folder:I", 10, 9)
        self.org.org_tallies.create(scope=f"msgs/text:in@{day(4)}", count=7)

        # never tallied, so copied up to today
        count(self.org2, "tickets:opened:0", 1, 1)
        count(self.org2, "tickets:opened:0", 0, 2)

    def assertState(self):
        d = self.day

        self.assertEqual(
            {
                f"msgs/text:in@{d(4)}": 7,
                f"tickets/opened:0@{d(10)}": 3,
                f"tickets/opened:5@{d(3)}": 4,
                f"tickets/opened:5@{d(2)}": 6,
                f"tickets/assigned:7@{d(10)}": 3,
                f"tickets/teamreplies:2@{d(10)}": 4,
                f"tickets/userreplies:7@{d(10)}": 3,
                f"tickets/userreplies:8@{d(10)}": 1,
                f"tickets/resptime:total@{d(20)}": 500,
                f"tickets/resptime:count@{d(20)}": 2,
                f"tickets/resptime:total@{d(30)}": 60,
            },
            {t.scope: t.count for t in self.org.org_tallies.all()},
        )
        self.assertEqual(
            {f"tickets/opened:0@{d(1)}": 1, f"tickets/opened:0@{d(0)}": 2},
            {t.scope: t.count for t in self.org2.org_tallies.all()},
        )
        self.assertFalse(self.org.org_tallies.filter(expires_on__isnull=False).exists())

    def test_migration(self):
        self.assertState()

        # running again is a noop
        migration = import_module("temba.tickets.migrations.0105_backfill_ticket_tallies")
        with patch("builtins.print") as mock_print:
            migration.backfill_ticket_tallies(self.apps, None)

        mock_print.assert_not_called()
        self.assertState()

        # but raises tallies which are behind
        self.org.org_tallies.filter(scope=f"tickets/opened:0@{self.day(10)}").update(count=1)
        migration.backfill_ticket_tallies(self.apps, None)

        self.assertState()
