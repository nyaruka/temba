from django.db import connection

from temba.tests import MigrationTest


class DropCurrentFlowIDTest(MigrationTest):
    app = "contacts"
    migrate_from = "0231_remove_contact_current_flow"
    migrate_to = "0232_drop_contact_current_flow_id"

    def test_migration(self):
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM information_schema.columns "
                "WHERE table_name = 'contacts_contact' AND column_name = 'current_flow_id'"
            )
            self.assertEqual(0, cursor.fetchone()[0])
