from temba.contacts.models import ContactGroup
from temba.tests import MigrationTest


class UpdateOpenTicketsQueryTest(MigrationTest):
    app = "contacts"
    migrate_from = "0225_squashed_counts_unique"
    migrate_to = "0226_update_open_tickets_query"

    def setUpBeforeMigration(self, apps):
        ContactGroup.objects.filter(is_system=True, group_type=ContactGroup.TYPE_SMART).update(query="tickets > 0")

        self.group1 = self.org.groups.create(
            name="Has Tickets",
            group_type=ContactGroup.TYPE_SMART,
            query="tickets > 0",
            status=ContactGroup.STATUS_READY,
            created_by=self.admin,
            modified_by=self.admin,
        )

    def test_migration(self):
        for org in (self.org, self.org2):
            open_tickets = org.groups.get(name="Open Tickets")
            self.assertEqual('ticket = "open"', open_tickets.query)
            self.assertEqual(ContactGroup.STATUS_READY, open_tickets.status)

        self.group1.refresh_from_db()
        self.assertEqual("tickets > 0", self.group1.query)  # user smart groups untouched
