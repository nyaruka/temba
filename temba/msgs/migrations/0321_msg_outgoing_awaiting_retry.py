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
    # like the Android index replaced in 0320, the index used to find messages to retry has status in its predicate,
    # so every status change on an outgoing message has to update it even when nothing it changed is indexed - which
    # is what stops Postgres applying those updates as heap-only tuple (HOT) updates.
    #
    # This replaces it with one on next_attempt being set, which is the case only whilst a message is awaiting a
    # retry. Mailroom and courier maintain that: every transition that moves a message on clears it. 0322 clears the
    # stale values left on messages written before that held.
    #
    # Unlike the Android replacement, this one has no deploy order dependency. The query that uses it filters
    # next_attempt <= NOW(), which implies this predicate's next_attempt IS NOT NULL, so Postgres can serve the
    # existing query from this index during the transition and the old one can be dropped in 0323 either side of the
    # service deploy.
    #
    # An index build on the messages table can't hold ACCESS EXCLUSIVE for its duration, so it's created
    # concurrently. Installations large enough to care can build it by hand ahead of the deploy and fake this:
    #
    #   CREATE INDEX CONCURRENTLY msgs_outgoing_awaiting_retry ON msgs_msg (next_attempt, created_on, id)
    #   WHERE direction = 'O' AND next_attempt IS NOT NULL;
    #
    atomic = False

    dependencies = [
        ("msgs", "0320_msg_android_outbox"),
    ]

    operations = [
        AddIndexConcurrentlyPlainReverse(
            model_name="msg",
            index=models.Index(
                name="msgs_outgoing_awaiting_retry",
                fields=["next_attempt", "created_on", "id"],
                condition=models.Q(("direction", "O"), ("next_attempt__isnull", False)),
            ),
        ),
    ]
