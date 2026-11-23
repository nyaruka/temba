import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups, and the drops are concurrent so as not to
    # block writes while waiting for their locks. The reverses aren't, as migration tests run them in a transaction.
    atomic = False

    dependencies = [
        ("ivr", "0046_call_calls_by_external_id"),
        ("orgs", "0215_drop_redundant_fk_indexes"),
    ]

    operations = [
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "ivr_call_org_id_f05ab39d"',
            reverse_sql='CREATE INDEX IF NOT EXISTS "ivr_call_org_id_f05ab39d" ON "ivr_call" ("org_id")',
            state_operations=[
                migrations.AlterField(
                    model_name="call",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="calls",
                        to="orgs.org",
                    ),
                )
            ],
        ),
    ]
