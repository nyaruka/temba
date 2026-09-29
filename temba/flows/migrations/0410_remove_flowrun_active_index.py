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
    # the count repair in 0409 is done with it, and nothing else needs an index on active runs by flow, so drop it
    # rather than leave the write overhead on the run table
    atomic = False

    dependencies = [
        ("flows", "0409_fix_activity_counts"),
    ]

    operations = [
        RemoveIndexConcurrentlyPlainReverse(model_name="flowrun", name="tmp_flowruns_active_by_flow"),
    ]
