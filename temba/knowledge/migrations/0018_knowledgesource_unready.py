from django.contrib.postgres.operations import AddIndexConcurrently, RemoveIndexConcurrently
from django.db import migrations, models
from django.db.migrations.operations.models import AddIndex, RemoveIndex


class AddIndexConcurrentlyPlainReverse(AddIndexConcurrently):
    """
    Adds the index concurrently but reverses with a plain drop, so that migration tests - which roll the graph
    backwards inside a transaction - can unapply it.
    """

    def database_backwards(self, app_label, schema_editor, from_state, to_state):  # pragma: no cover
        AddIndex.database_backwards(self, app_label, schema_editor, from_state, to_state)


class RemoveIndexConcurrentlyPlainReverse(RemoveIndexConcurrently):
    """
    Removes the index concurrently but reverses with a plain create, so that migration tests - which roll the graph
    backwards inside a transaction - can unapply it.
    """

    def database_backwards(self, app_label, schema_editor, from_state, to_state):  # pragma: no cover
        RemoveIndex.database_backwards(self, app_label, schema_editor, from_state, to_state)


class Migration(migrations.Migration):
    # every edit to a shortcut or article now flags its source as pending, so mailroom's sweep no longer has to check
    # every ready source for items changed since it was indexed - only the pending, failed and indexing ones, which
    # this index finds without reading the ready majority. It covers what the pending-only index did. Built
    # concurrently so as not to block writes to sources.
    atomic = False

    dependencies = [
        ("knowledge", "0017_drop_articlecount"),
    ]

    operations = [
        AddIndexConcurrentlyPlainReverse(
            model_name="knowledgesource",
            index=models.Index(
                condition=models.Q(("is_active", True), ("status__in", ("P", "F", "I"))),
                fields=["id"],
                name="knowledgesource_unready",
            ),
        ),
        RemoveIndexConcurrentlyPlainReverse(
            model_name="knowledgesource",
            name="knowledgesource_pending",
        ),
    ]
