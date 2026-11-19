from django.db import connection

from temba.tests import MigrationTest


class RemoveCurrentFlowTest(MigrationTest):
    app = "contacts"
    migrate_from = "0230_backfill_contact_current_flow_uuid"
    migrate_to = "0231_remove_contact_current_flow"

    def test_migration(self):
        with connection.cursor() as cursor:
            cursor.execute(
                """SELECT count(*) FROM pg_constraint c
                     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
                    WHERE c.conrelid = 'contacts_contact'::regclass AND c.contype = 'f' AND a.attname = 'current_flow_id'"""
            )
            self.assertEqual(0, cursor.fetchone()[0])

            # column is kept for now
            cursor.execute(
                "SELECT count(*) FROM information_schema.columns "
                "WHERE table_name = 'contacts_contact' AND column_name = 'current_flow_id'"
            )
            self.assertEqual(1, cursor.fetchone()[0])
