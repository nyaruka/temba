from django.db import migrations

# Removes the field from the model but only drops its foreign key constraint, as mailroom still writes the column. The
# constraint is looked up by column rather than by name in case databases differ. The column is dropped once mailroom
# stops writing it.

SQL_DROP_CONSTRAINT = """
DO $$
DECLARE
    fk_name TEXT;
BEGIN
    SELECT c.conname INTO fk_name
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     WHERE c.conrelid = 'contacts_contact'::regclass AND c.contype = 'f' AND a.attname = 'current_flow_id';

    IF fk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE contacts_contact DROP CONSTRAINT %I', fk_name);
    END IF;
END $$;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("contacts", "0230_backfill_contact_current_flow_uuid"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[migrations.RemoveField(model_name="contact", name="current_flow")],
            database_operations=[migrations.RunSQL(SQL_DROP_CONSTRAINT, migrations.RunSQL.noop)],
        ),
    ]
