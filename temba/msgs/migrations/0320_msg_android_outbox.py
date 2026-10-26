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
    Removes the index concurrently but reverses with a plain create, for the same reason.
    """

    def database_backwards(self, app_label, schema_editor, from_state, to_state):  # pragma: no cover
        RemoveIndex.database_backwards(self, app_label, schema_editor, from_state, to_state)


class Migration(migrations.Migration):
    # Postgres can only apply an update as a heap-only tuple (HOT) update - no index maintenance, and dead row
    # versions reclaimed by page pruning rather than vacuum - when none of the columns that actually changed are
    # referenced by any index on the table. Columns that only appear in a partial index's WHERE count, so the index
    # on old Android messages having status in its predicate means every status change on an outgoing message has to
    # update every index on the table, even when nothing it changed is indexed.
    #
    # This replaces it with one on the outbox folder, which is the visible outgoing messages still waiting to be
    # sent - what the query selects. The two aren't quite identical: the old predicate had no visibility clause, so
    # it also covered outgoing messages deleted whilst still in a waiting status, which the folder excludes. The
    # query has always filtered those out itself, so narrowing the index to match it changes nothing about what gets
    # failed.
    #
    # The replacement is created before the old one is dropped so that the query is never without an index, and both
    # are done concurrently because an index build or drop on the messages table can't hold ACCESS EXCLUSIVE for its
    # duration - hence atomic = False.
    #
    # DEPLOY ORDER: the drop is not safe to run before the query that uses it has switched to selecting by folder.
    # Postgres will only use a partial index when it can prove the query's WHERE implies the index predicate, and it
    # reasons within a single column - it cannot derive folder = 'O' from status IN ('I', 'Q', 'E') even though that
    # holds by construction, because they're independent columns. So a fail-old-Android query still filtering on
    # status can't use the replacement, and dropping the old index leaves it scanning the messages table. The message
    # handling service has to be running the folder based query before this migration runs.
    #
    # The retry index replacement doesn't have this problem: its old query filters next_attempt <= NOW(), which
    # implies the new predicate's next_attempt IS NOT NULL, so Postgres can use the replacement for the old query.
    #
    # Installations large enough to care can do both by hand ahead of the deploy and fake this migration:
    #
    #   CREATE INDEX CONCURRENTLY msgs_android_outbox ON msgs_msg (created_on)
    #   WHERE direction = 'O' AND folder = 'O' AND is_android;
    #   DROP INDEX CONCURRENTLY msgs_outgoing_android_to_fail;
    #
    atomic = False

    dependencies = [
        ("msgs", "0319_remove_labelcount_is_archived"),
    ]

    operations = [
        AddIndexConcurrentlyPlainReverse(
            model_name="msg",
            index=models.Index(
                name="msgs_android_outbox",
                fields=["created_on"],
                condition=models.Q(("direction", "O"), ("folder", "O"), ("is_android", True)),
            ),
        ),
        RemoveIndexConcurrentlyPlainReverse(model_name="msg", name="msgs_outgoing_android_to_fail"),
    ]
