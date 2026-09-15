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
    # Completes the msg_uuid column on labellings, added in 0324 and backfilled in 0325: makes it NOT NULL and adds
    # the index by label and uuid descending which lets a label's messages be paged and date-bounded the way the
    # folder views page msgs_by_folder. This has to run after 0325, and so after the services which insert
    # labellings are writing the column - the NOT NULL fails if any row is still missing it.
    #
    # The plain index on label_id is left in place - the views and API still query by label alone - until they've
    # been switched to page over the new index.
    #
    # None of this can hold an ACCESS EXCLUSIVE lock on the table for long whilst labellings are being written:
    #
    #  - SET NOT NULL scans the whole table under that lock to prove there are no nulls, unless a validated CHECK
    #    constraint already proves it, so one is added NOT VALID (instant), validated (which only takes a SHARE
    #    UPDATE EXCLUSIVE lock, so writes continue), and dropped once the column is NOT NULL.
    #  - the index is created concurrently.
    #
    # Installations large enough to care can do all of this by hand ahead of the deploy and fake this migration:
    #
    #   ALTER TABLE msgs_msg_labels ADD CONSTRAINT msg_uuid_not_null CHECK (msg_uuid IS NOT NULL) NOT VALID;
    #   ALTER TABLE msgs_msg_labels VALIDATE CONSTRAINT msg_uuid_not_null;
    #   ALTER TABLE msgs_msg_labels ALTER COLUMN msg_uuid SET NOT NULL;
    #   ALTER TABLE msgs_msg_labels DROP CONSTRAINT msg_uuid_not_null;
    #   CREATE INDEX CONCURRENTLY msgs_by_label ON msgs_msg_labels (label_id, msg_uuid DESC);
    #
    atomic = False

    dependencies = [
        ("msgs", "0325_backfill_msglabel_msg_uuid"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql=[
                        "ALTER TABLE msgs_msg_labels ADD CONSTRAINT msg_uuid_not_null "
                        "CHECK (msg_uuid IS NOT NULL) NOT VALID",
                        "ALTER TABLE msgs_msg_labels VALIDATE CONSTRAINT msg_uuid_not_null",
                        "ALTER TABLE msgs_msg_labels ALTER COLUMN msg_uuid SET NOT NULL",
                        "ALTER TABLE msgs_msg_labels DROP CONSTRAINT msg_uuid_not_null",
                    ],
                    reverse_sql="ALTER TABLE msgs_msg_labels ALTER COLUMN msg_uuid DROP NOT NULL",
                ),
            ],
            state_operations=[
                migrations.AlterField(
                    model_name="msglabel",
                    name="msg_uuid",
                    field=models.UUIDField(),
                ),
            ],
        ),
        AddIndexConcurrentlyPlainReverse(
            model_name="msglabel",
            index=models.Index(fields=["label", "-msg_uuid"], name="msgs_by_label"),
        ),
    ]
