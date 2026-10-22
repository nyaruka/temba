from django.contrib.postgres.operations import RemoveIndexConcurrently
from django.db import migrations
from django.db.migrations.operations.models import RemoveIndex


class RemoveIndexConcurrentlyPlainReverse(RemoveIndexConcurrently):
    """
    Removes the index concurrently but reverses with a plain create, so that migration tests - which roll the graph
    backwards inside a transaction - can unapply it.
    """

    def database_backwards(self, app_label, schema_editor, from_state, to_state):  # pragma: no cover
        RemoveIndex.database_backwards(self, app_label, schema_editor, from_state, to_state)


class Migration(migrations.Migration):
    # a plain index drop would block writes to the tickets table while it waits for its lock, so it's dropped concurrently
    atomic = False

    dependencies = [
        ("tickets", "0095_backfill_ticket_close_fires"),
    ]

    operations = [
        RemoveIndexConcurrentlyPlainReverse(model_name="ticket", name="tickets_open_last_activity"),
    ]
