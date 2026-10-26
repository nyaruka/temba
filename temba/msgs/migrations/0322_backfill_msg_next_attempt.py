from django.db import connection as default_connection, migrations

# next_attempt is now only set on an outgoing message whilst it's awaiting a retry - courier clears it when a message
# moves on to wired, sent, delivered, read or failed - but until now it was left as it was, so a message which errored
# and was then sent still carries the time of the retry it no longer needs. The retry index added in 0321 is on
# next_attempt being set, so those rows would sit in it for no reason. This clears them.
#
# The rows are found through that index rather than by walking the table - it's exactly the set of rows the index
# holds, minus the ones legitimately awaiting a retry - so each batch is an index scan rather than a slice of the
# table. The status check is repeated on the update itself so that a message which errors again between being
# selected and being updated keeps the retry it was just given. Each batch is its own transaction, and the loop runs
# until nothing is left, so an interrupted run just picks up where it left off.

BATCH_SIZE = 5000

SQL_CLEAR_NEXT_ATTEMPT = """
WITH rows AS (
    SELECT id FROM msgs_msg
    WHERE direction = 'O' AND next_attempt IS NOT NULL AND status NOT IN ('I', 'E')
    LIMIT %(batch)s
)
UPDATE msgs_msg m SET next_attempt = NULL
FROM rows
WHERE m.id = rows.id AND m.status NOT IN ('I', 'E')
"""


def clear_stale_next_attempts(apps, schema_editor):  # pragma: no cover
    # schema_editor is None when this is run out of band via apply_manual
    conn = schema_editor.connection if schema_editor else default_connection

    num_updated = 0

    while True:
        with conn.cursor() as cursor:
            cursor.execute(SQL_CLEAR_NEXT_ATTEMPT, {"batch": BATCH_SIZE})
            batch_updated = cursor.rowcount

        if not batch_updated:
            break

        num_updated += batch_updated
        print(f"Cleared next_attempt on {num_updated} messages")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    clear_stale_next_attempts(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("msgs", "0321_msg_outgoing_awaiting_retry"),
    ]

    operations = [
        migrations.RunPython(clear_stale_next_attempts, migrations.RunPython.noop),
    ]
