import django.db.models.deletion
from django.db import migrations, models

# Drops the plain index on msgs_msg_labels.label_id. Everything which lists a label's messages now reads msgs_by_label
# (added in 0326), which has label_id as its leading column and so serves a lookup by label alone as well, leaving
# this one only costing space and write overhead. This has to run after the services which read labellings by label
# alone have been deployed with that change.
#
# The index isn't a named index in the migration state - it's the one Django creates for a foreign key - so it's
# found and dropped here directly, with the state change (db_index=False) made separately. It's found by its
# definition rather than by name: on a database whose table predates Django's current index naming scheme it has a
# different name to the one Django would give it now, and a drop by that name would silently do nothing. Dropping
# concurrently means it doesn't block writes, which is why this migration isn't atomic. Installations large enough to
# care can do it by hand ahead of the deploy and fake this migration:
#
#   SELECT indexname FROM pg_indexes WHERE tablename = 'msgs_msg_labels' AND indexdef LIKE '% USING btree (label_id)';
#   DROP INDEX CONCURRENTLY <that index>;
#

# what Django would name the index, used when reversing
LABEL_INDEX_NAME = "msgs_msg_labels_label_id_525dfbc1"

SQL_FIND_LABEL_INDEXES = """
SELECT indexname FROM pg_indexes
WHERE schemaname = current_schema() AND tablename = 'msgs_msg_labels' AND indexdef LIKE %s
"""


def drop_label_index(apps, schema_editor):
    conn = schema_editor.connection

    with conn.cursor() as cursor:
        cursor.execute(SQL_FIND_LABEL_INDEXES, ["% USING btree (label_id)"])
        names = [row[0] for row in cursor.fetchall()]

        for name in names:
            # a concurrent drop can't run inside a transaction, and there isn't one when this is applied for real -
            # but migration tests roll the graph back and forth inside one, so drop plainly there
            concurrently = "" if conn.in_atomic_block else "CONCURRENTLY "
            cursor.execute(f'DROP INDEX {concurrently}"{name}"')


def create_label_index(apps, schema_editor):  # pragma: no cover
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(f'CREATE INDEX "{LABEL_INDEX_NAME}" ON msgs_msg_labels (label_id)')


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("msgs", "0326_msglabel_msg_uuid_not_null"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(drop_label_index, create_label_index),
            ],
            state_operations=[
                migrations.AlterField(
                    model_name="msglabel",
                    name="label",
                    field=models.ForeignKey(
                        db_index=False, on_delete=django.db.models.deletion.CASCADE, to="msgs.label"
                    ),
                ),
            ],
        ),
    ]
