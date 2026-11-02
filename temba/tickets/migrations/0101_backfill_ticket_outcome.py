from django.db import connection, migrations
from django.db.models import Max

BATCH_SIZE = 10_000

# no ticket could have been closed for inactivity before then
AUTO_CLOSE_SINCE = "2026-10-19T00:00:00Z"

# closes by users bump last activity to the time of the close, whereas closes of inactive tickets leave it at least a
# day before it, which is the smallest idle limit a workspace can have
SQL = """
UPDATE tickets_ticket
   SET outcome = CASE
           WHEN closed_on >= %(auto_close_since)s AND last_activity_on <= closed_on - INTERVAL '1 day' THEN 'I'
           ELSE 'R'
       END
 WHERE id > %(from_id)s AND id <= %(to_id)s AND status = 'C' AND outcome IS NULL"""


def backfill_ticket_outcome(apps, schema_editor):
    Ticket = apps.get_model("tickets", "Ticket")

    max_id = Ticket.objects.aggregate(max_id=Max("id"))["max_id"] or 0
    num_updated = 0

    for from_id in range(0, max_id, BATCH_SIZE):
        with connection.cursor() as cursor:
            cursor.execute(
                SQL, {"auto_close_since": AUTO_CLOSE_SINCE, "from_id": from_id, "to_id": from_id + BATCH_SIZE}
            )
            num_updated += cursor.rowcount

    if num_updated:
        print(f"Set outcome on {num_updated} closed tickets")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_ticket_outcome(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("tickets", "0100_ticket_outcome"),
    ]

    operations = [
        migrations.RunPython(backfill_ticket_outcome, migrations.RunPython.noop),
    ]
