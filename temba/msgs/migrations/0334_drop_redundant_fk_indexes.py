import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups, and the drops are concurrent so as not to
    # block writes while waiting for their locks. The reverses aren't, as migration tests run them in a transaction.
    atomic = False

    dependencies = [
        ("msgs", "0333_update_triggers"),
        ("orgs", "0215_drop_redundant_fk_indexes"),
    ]

    operations = [
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "msgs_label_org_id_a63db233"',
            reverse_sql='CREATE INDEX IF NOT EXISTS "msgs_label_org_id_a63db233" ON "msgs_label" ("org_id")',
            state_operations=[
                migrations.AlterField(
                    model_name="label",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="msgs_labels",
                        to="orgs.org",
                    ),
                )
            ],
        ),
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "msgs_msg_labels_msg_id_a1f8fefa"',
            reverse_sql='CREATE INDEX IF NOT EXISTS "msgs_msg_labels_msg_id_a1f8fefa" ON "msgs_msg_labels" ("msg_id")',
            state_operations=[
                migrations.AlterField(
                    model_name="msglabel",
                    name="msg",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.CASCADE,
                        to="msgs.msg",
                    ),
                )
            ],
        ),
    ]
