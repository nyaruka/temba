from django.contrib.postgres.operations import RemoveIndexConcurrently
from django.db import migrations


class Migration(migrations.Migration):
    # a plain index drop would block writes to the tickets table while it waits for its lock, so it's dropped concurrently
    atomic = False

    dependencies = [
        ("tickets", "0095_backfill_ticket_close_fires"),
    ]

    operations = [
        RemoveIndexConcurrently(model_name="ticket", name="tickets_open_last_activity"),
    ]
