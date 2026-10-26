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
    # the index replaced by msgs_outgoing_awaiting_retry in 0321. The retry query can be served by the replacement
    # whether or not it still filters on status, so this doesn't need the service deploy to land first.
    atomic = False

    dependencies = [
        ("msgs", "0322_backfill_msg_next_attempt"),
    ]

    operations = [
        RemoveIndexConcurrentlyPlainReverse(model_name="msg", name="msgs_outgoing_to_retry"),
    ]
