from django.db import connection as default_connection, migrations

# Fills in msg_uuid, added to labellings in 0324, from the labelled message. This has to run after the services
# which insert labellings are deployed with support for the column: until then, new rows are still written without
# it and would be missed. 0326 then makes the column NOT NULL.
#
# The table is walked by its primary key rather than scanned for rows still missing a uuid, so that each batch is
# an index range scan and a row is never read twice. Each batch is its own transaction, and the loop runs until it
# reaches the end of the table, so an interrupted run just picks up where it left off - it re-reads the rows already
# done but doesn't rewrite them.

BATCH_SIZE = 5000

SQL_BACKFILL_MSG_UUID = """
WITH batch AS (
    SELECT ml.id, m.uuid
    FROM msgs_msg_labels ml
    INNER JOIN msgs_msg m ON m.id = ml.msg_id
    WHERE ml.id > %(after)s
    ORDER BY ml.id
    LIMIT %(batch)s
), updated AS (
    UPDATE msgs_msg_labels ml SET msg_uuid = batch.uuid
    FROM batch
    WHERE ml.id = batch.id AND ml.msg_uuid IS NULL
    RETURNING ml.id
)
SELECT (SELECT MAX(id) FROM batch), (SELECT COUNT(*) FROM updated)
"""


def backfill_msg_uuids(apps, schema_editor):
    # schema_editor is None when this is run out of band via apply_manual
    conn = schema_editor.connection if schema_editor else default_connection

    after_id = 0
    num_updated = 0

    while True:
        with conn.cursor() as cursor:
            cursor.execute(SQL_BACKFILL_MSG_UUID, {"after": after_id, "batch": BATCH_SIZE})
            last_id, batch_updated = cursor.fetchone()

        if last_id is None:
            break

        after_id = last_id
        num_updated += batch_updated
        print(f"Backfilled msg_uuid on {num_updated} labellings (up to id {last_id})")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_msg_uuids(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("msgs", "0324_msglabel"),
    ]

    operations = [
        migrations.RunPython(backfill_msg_uuids, migrations.RunPython.noop),
    ]
