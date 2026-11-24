from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations, models
from django.db.migrations.operations.models import AddIndex


class AddIndexConcurrentlyPlainReverse(AddIndexConcurrently):
    """
    Adds the index concurrently but reverses with a plain drop, so that migration tests - which roll the graph
    backwards inside a transaction - can unapply it.
    """

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        AddIndex.database_backwards(self, app_label, schema_editor, from_state, to_state)


class Migration(migrations.Migration):
    # used to look up a call by its provider's call ID. Created concurrently so the build doesn't hold ACCESS
    # EXCLUSIVE on the calls table. Installations large enough to care can build it by hand ahead of the deploy and
    # fake this migration:
    #
    #   CREATE INDEX CONCURRENTLY calls_by_external_id ON ivr_call (channel_id, external_id);
    #
    atomic = False

    dependencies = [
        ("ivr", "0045_backfill_call_minute_tallies"),
    ]

    operations = [
        AddIndexConcurrentlyPlainReverse(
            model_name="call",
            index=models.Index(name="calls_by_external_id", fields=["channel", "external_id"]),
        ),
    ]
