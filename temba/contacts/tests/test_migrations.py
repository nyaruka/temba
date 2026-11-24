from uuid import UUID

from temba.contacts.models import Contact
from temba.tests import MigrationTest


class AddContactUUID2Test(MigrationTest):
    app = "contacts"
    migrate_from = "0232_drop_contact_current_flow_id"
    migrate_to = "0233_contact_uuid2"

    def setUpBeforeMigration(self, apps):
        Contact = apps.get_model("contacts", "Contact")

        self.contact1 = Contact.objects.create(org_id=self.org.id, name="Ann", created_by_id=self.admin.id)

    def test_migration(self):
        # existing contacts are left for the backfill
        self.assertIsNone(Contact.objects.get(id=self.contact1.id).uuid2)

        contact2 = self.create_contact("Bob")
        self.assertEqual(UUID(contact2.uuid), Contact.objects.get(id=contact2.id).uuid2)
