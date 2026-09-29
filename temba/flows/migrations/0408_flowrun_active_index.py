from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations, models
from django.db.migrations.operations.models import AddIndex
from django.db.models import Q


class AddIndexConcurrentlyPlainReverse(AddIndexConcurrently):
    """
    Adds the index concurrently but reverses with a plain drop, so that migration tests - which roll the graph
    backwards inside a transaction - can unapply it.
    """

    def database_backwards(self, app_label, schema_editor, from_state, to_state):  # pragma: no cover
        AddIndex.database_backwards(self, app_label, schema_editor, from_state, to_state)


class Migration(migrations.Migration):
    # temporary index to support the count repair in the next migration - without it, recounting a single flow's
    # active runs means a sequential scan of the whole run table, so the repair can't be batched. Dropped again in
    # 0410 as nothing else needs it. Installations large enough to care can create it by hand ahead of the deploy:
    #
    #   CREATE INDEX CONCURRENTLY tmp_flowruns_active_by_flow ON flows_flowrun (flow_id, status, current_node_uuid)
    #   WHERE status IN ('A', 'W');
    #
    atomic = False

    dependencies = [
        ("flows", "0407_update_triggers"),
    ]

    operations = [
        AddIndexConcurrentlyPlainReverse(
            model_name="flowrun",
            index=models.Index(
                name="tmp_flowruns_active_by_flow",
                fields=("flow", "status", "current_node_uuid"),
                condition=Q(status__in=("A", "W")),
            ),
        ),
    ]
