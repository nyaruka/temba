from datetime import datetime, timedelta, timezone as tzone

from temba.tests import MigrationTest
from temba.tickets.models import Ticket


class BackfillTicketOutcomeTest(MigrationTest):
    app = "tickets"
    migrate_from = "0100_ticket_outcome"
    migrate_to = "0101_backfill_ticket_outcome"

    def setUpBeforeMigration(self, apps):
        contact1 = self.create_contact("Ann", phone="+16055741111")
        contact2 = self.create_contact("Bob", phone="+16055742222")

        def closed_ticket(contact, closed_on, last_activity_on, outcome=None):
            ticket = self.create_ticket(contact, closed_on=closed_on, outcome=outcome)
            Ticket.objects.filter(id=ticket.id).update(last_activity_on=last_activity_on, outcome=outcome)
            return ticket

        before = datetime(2025, 3, 1, 12, 0, tzinfo=tzone.utc)
        after = datetime(2026, 10, 25, 12, 0, tzinfo=tzone.utc)

        self.user_close = closed_ticket(contact1, after, after)
        self.idle_close = closed_ticket(contact1, after, after - timedelta(days=30, hours=1))
        self.idle_close_boundary = closed_ticket(contact1, after, after - timedelta(days=1))
        self.no_closed_on = closed_ticket(contact1, after, after - timedelta(days=30))
        Ticket.objects.filter(id=self.no_closed_on.id).update(closed_on=None)
        self.old_close = closed_ticket(contact2, before, before - timedelta(days=60))  # before auto-closing existed
        self.has_outcome = closed_ticket(contact2, after, after - timedelta(days=30), outcome=Ticket.OUTCOME_RESOLVED)
        self.open = self.create_ticket(contact2)

    def test_migration(self):
        def assert_outcome(ticket, expected):
            ticket.refresh_from_db()
            self.assertEqual(expected, ticket.outcome)

        assert_outcome(self.user_close, Ticket.OUTCOME_RESOLVED)
        assert_outcome(self.idle_close, Ticket.OUTCOME_IDLE)
        assert_outcome(self.idle_close_boundary, Ticket.OUTCOME_IDLE)
        assert_outcome(self.no_closed_on, Ticket.OUTCOME_RESOLVED)
        assert_outcome(self.old_close, Ticket.OUTCOME_RESOLVED)
        assert_outcome(self.has_outcome, Ticket.OUTCOME_RESOLVED)  # left as it was
        assert_outcome(self.open, None)
