from django.db import connection as default_connection, migrations
from django.db.models import Max, Min

# Msg.folder is denormalized from direction/visibility/status/flow and is written by mailroom and courier - this fills
# it in for the messages that predate that, and corrects the ones where it was written and has since gone stale. The
# stale ones exist because for a window after the column was introduced some state changes were still being applied by
# code that predated it and so didn't maintain it - an outgoing message's status being updated from an Android
# relayer's sync, and incoming messages being archived in bulk for a contact. Both saved the columns folder is derived
# from without saving folder, leaving e.g. a sent message still filed under Outbox, or an archived one still under
# Inbox. Nothing writes message state that way any more, but the rows they left behind are wrong.
#
# So this works by comparison rather than by absence: recompute the folder every message should have and write it
# wherever it disagrees with what's stored, which covers the never-written and the stale cases in one pass without
# needing to know which messages fall into which. The CASE mirrors the folder derivation mailroom and courier implement, including its precedence: being
# deleted, and then being unhandled, both come before the user facing folders, so that a message which is archived or
# deleted whilst still pending doesn't land in Archived.
#
# A message whose state matches no branch keeps the folder it has rather than being guessed at - or having a folder
# cleared. The temba_msg_on_change trigger rules out most of those - an incoming message that isn't pending or handled,
# and an outgoing message that is archived - but not every one: an outgoing message that is somehow pending or handled
# is legal and falls through.
#
# The table is far too large to scan for messages needing this, so we walk the primary key range in batches instead,
# newest first so that the messages users are most likely to be looking at are corrected first - which is also where
# the stale ones are, since they can only exist from the column's introduction onwards. Each batch is its own
# transaction, so an interrupted run can be resumed from the last id it reported.
#
# Batching by id range is what gets each statement served by the primary key, but the size is chosen by what one
# statement should cost rather than by that. msgs_msg carries a FOR EACH ROW trigger, so a batch is that many plpgsql
# calls, that many row locks held until it commits, and a WAL burst to match - all on the rows courier and mailroom
# are concurrently writing. It also carries a FOR EACH STATEMENT update trigger with OLD and NEW transition tables, so
# every batch materializes two tuplestores of whole msgs_msg rows, message text included, and joins them five times
# over - the part that grows worst with batch size, since past work_mem those tuplestores spill to disk. Hence a size
# that keeps a batch cheap on the dense recent end of the table, where ids and rows are close to one to one.

BATCH_SIZE = 10_000  # ids per batch, not rows - ids are sparse wherever messages have been deleted

# the folder is derived in a CTE so that the update itself is a primary key join touching only the rows that actually
# disagree - the triggers above then see a batch sized by the corrections made, not by the ids walked
SQL_BACKFILL_FOLDER = """
WITH derived AS (
    SELECT id, CASE
        WHEN visibility IN ('D', 'X') THEN 'D'                                                   -- deleted
        WHEN direction = 'I' AND status = 'P' THEN 'P'                                           -- pending
        WHEN direction = 'I' AND visibility = 'V' AND status = 'H' AND flow_id IS NULL THEN 'I'  -- inbox
        WHEN direction = 'I' AND visibility = 'V' AND status = 'H' THEN 'W'                      -- handled
        WHEN direction = 'I' AND visibility = 'A' AND status = 'H' THEN 'A'                      -- archived
        WHEN direction = 'O' AND visibility = 'V' AND status IN ('I', 'Q', 'E') THEN 'O'         -- outbox
        WHEN direction = 'O' AND visibility = 'V' AND status IN ('W', 'S', 'D', 'R') THEN 'S'    -- sent
        WHEN direction = 'O' AND visibility = 'V' AND status = 'F' THEN 'X'                      -- failed
    END AS folder
    FROM msgs_msg WHERE id >= %(low)s AND id <= %(high)s
)
UPDATE msgs_msg m SET folder = d.folder
FROM derived d
WHERE m.id = d.id AND d.folder IS NOT NULL AND m.folder IS DISTINCT FROM d.folder
"""


def backfill_msg_folder(apps, schema_editor):  # pragma: no cover
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
            cursor.execute(SQL_BACKFILL_FOLDER, {"low": batch_low, "high": batch_high})
            num_updated += cursor.rowcount

        print(f"Backfilled folder on {num_updated} messages (down to id={batch_low})")

        batch_high = batch_low - 1


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_msg_folder(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("msgs", "0309_msg_folder"),
    ]

    operations = [
        migrations.RunPython(backfill_msg_folder, migrations.RunPython.noop),
    ]
