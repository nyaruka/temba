from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations, models
from django.db.migrations.operations.models import AddIndex


class AddIndexConcurrentlyPlainReverse(AddIndexConcurrently):
    """
    Adds the index concurrently but reverses with a plain drop, so that migration tests - which roll the graph
    backwards inside a transaction - can unapply it.
    """

    def database_backwards(self, app_label, schema_editor, from_state, to_state):  # pragma: no cover
        AddIndex.database_backwards(self, app_label, schema_editor, from_state, to_state)


class Migration(migrations.Migration):
    # an index build on the messages table can't hold ACCESS EXCLUSIVE for its duration, so it's created concurrently.
    # Nothing reads it yet - it's added ahead of the folder views and API folders switching to filter by folder and
    # order by uuid (time ordered, as message uuids are v7) so that the switch doesn't wait on the build.
    # Installations large enough to care can build it by hand ahead of the deploy and fake this migration:
    #
    #   CREATE INDEX CONCURRENTLY msgs_by_folder ON msgs_msg (org_id, folder, uuid DESC)
    #   WHERE folder IN ('I', 'W', 'A', 'O', 'S', 'X');
    #
    atomic = False

    dependencies = [
        ("msgs", "0310_backfill_msg_folder"),
    ]

    operations = [
        AddIndexConcurrentlyPlainReverse(
            model_name="msg",
            index=models.Index(
                name="msgs_by_folder",
                fields=["org", "folder", "-uuid"],
                condition=models.Q(("folder__in", ("I", "W", "A", "O", "S", "X"))),
            ),
        ),
    ]
