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
    # the per-folder partial indexes, superseded by msgs_by_folder now that everything reading a folder filters by
    # folder and pages by uuid. Dropped concurrently as a plain drop would hold ACCESS EXCLUSIVE on the messages table
    # while waiting on every in-flight query against it.
    atomic = False

    dependencies = [
        ("msgs", "0311_msg_msgs_by_folder"),
    ]

    operations = [
        RemoveIndexConcurrentlyPlainReverse(model_name="msg", name="msgs_inbox"),
        RemoveIndexConcurrentlyPlainReverse(model_name="msg", name="msgs_flows"),
        RemoveIndexConcurrentlyPlainReverse(model_name="msg", name="msgs_archived"),
        RemoveIndexConcurrentlyPlainReverse(model_name="msg", name="msgs_outbox_and_failed"),
        RemoveIndexConcurrentlyPlainReverse(model_name="msg", name="msgs_sent"),
    ]
