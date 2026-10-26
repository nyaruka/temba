from django.db import connection as default_connection, migrations
from django.db.models import Max, Min

# Archived is no longer a message visibility - it's recorded by Msg.folder alone, which is what everything reads to tell
# whether a message is archived. Mailroom and courier no longer write it, so this clears the value from the messages
# that predate that, leaving visibility to mean only visible or deleted and letting the value itself be removed.
#
# Almost all of these rows are archived messages, which keep folder 'A' and stay archived - only the redundant second
# record of that fact goes. The exception is a message archived while it was still unhandled, which carries visibility
# 'A' with folder 'P' because being unhandled takes precedence over being archived. Such a message isn't in the
# Archived folder and, now that handling one no longer consults visibility, wouldn't be filed there when handled
# either, so clearing its visibility makes the row say what the rest of the system already believes about it.
#
# No counts move, so this doesn't need a quiet window. The folder counts are keyed on folder, and the label counts on
# whether the folder is archived or deleted, so an update which leaves folder alone moves neither.
#
# The table is far too large to scan for the messages needing this, so we walk the primary key range in batches
# instead, newest first. Each batch is its own transaction, so an interrupted run can be resumed from the last id it
# reported. See the note in 0310_backfill_msg_folder on choosing the batch size by what one statement should cost
# rather than by the id range it covers - the same per row and per statement triggers apply here.

BATCH_SIZE = 10_000  # ids per batch, not rows - ids are sparse wherever messages have been deleted

# the visibility test is part of the statement, so the triggers see a batch sized by the rows actually cleared rather
# than by the ids walked
SQL_BACKFILL_VISIBILITY = """
UPDATE msgs_msg SET visibility = 'V' WHERE id >= %(low)s AND id <= %(high)s AND visibility = 'A'
"""


def backfill_msg_visibility(apps, schema_editor):  # pragma: no cover
    Msg = apps.get_model("msgs", "Msg")

    # schema_editor is None when this is run out of band via apply_manual
    conn = schema_editor.connection if schema_editor else default_connection

    id_range = Msg.objects.aggregate(low=Min("id"), high=Max("id"))
    lowest, highest = id_range["low"], id_range["high"]
    if lowest is None:  # no messages at all
        return

    num_updated = 0
    batch_high = highest

    while batch_high >= lowest:
        batch_low = max(batch_high - BATCH_SIZE + 1, lowest)

        with conn.cursor() as cursor:
            cursor.execute(SQL_BACKFILL_VISIBILITY, {"low": batch_low, "high": batch_high})
            num_updated += cursor.rowcount

        print(f"Cleared archived visibility on {num_updated} messages (down to id={batch_low})")

        batch_high = batch_low - 1


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_msg_visibility(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("msgs", "0315_update_triggers"),
    ]

    operations = [
        migrations.RunPython(backfill_msg_visibility, migrations.RunPython.noop),
    ]
