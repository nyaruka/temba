from django.db import connection as default_connection, migrations

# Deletes the weekday counts of incoming messages, which stopped being written in msgs 0329. The count table is large
# and busy, so rather than one big delete this walks flows by id and deletes their counts a batch of flows at a time,
# each batch its own transaction and an index range scan on (flow_id, scope).

BATCH_SIZE = 1000

SQL_DELETE_DOW_COUNTS = """
WITH batch AS (
    SELECT id FROM flows_flow WHERE id > %(after)s ORDER BY id LIMIT %(batch)s
), deleted AS (
    DELETE FROM flows_flowactivitycount
    WHERE flow_id IN (SELECT id FROM batch) AND scope LIKE 'msgsin:dow:%%'
    RETURNING id
)
SELECT (SELECT MAX(id) FROM batch), (SELECT COUNT(*) FROM deleted)
"""


def delete_dow_counts(apps, schema_editor):
    # schema_editor is None when this is run out of band via apply_manual
    conn = schema_editor.connection if schema_editor else default_connection

    after_id = 0
    num_deleted = 0

    while True:
        with conn.cursor() as cursor:
            cursor.execute(SQL_DELETE_DOW_COUNTS, {"after": after_id, "batch": BATCH_SIZE})
            last_id, batch_deleted = cursor.fetchone()

        if last_id is None:
            break

        after_id = last_id
        num_deleted += batch_deleted

    if num_deleted:
        print(f"Deleted {num_deleted} weekday flow activity counts")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    delete_dow_counts(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("flows", "0413_rename_reserved_flows"),
        ("msgs", "0329_update_triggers"),
    ]

    operations = [
        migrations.RunPython(delete_dow_counts, migrations.RunPython.noop),
    ]
