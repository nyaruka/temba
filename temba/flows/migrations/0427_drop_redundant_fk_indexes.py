import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups, and the drops are concurrent so as not to
    # block writes while waiting for their locks. The reverses aren't, as migration tests run them in a transaction.
    atomic = False

    dependencies = [
        ("flows", "0426_drop_flowactivitycount"),
        ("orgs", "0215_drop_redundant_fk_indexes"),
    ]

    operations = [
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "flows_flow_org_id_51b9c589"',
            reverse_sql='CREATE INDEX IF NOT EXISTS "flows_flow_org_id_51b9c589" ON "flows_flow" ("org_id")',
            state_operations=[
                migrations.AlterField(
                    model_name="flow",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="flows",
                        to="orgs.org",
                    ),
                )
            ],
        ),
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "flows_flowlabel_org_id_4ed2f553"',
            reverse_sql='CREATE INDEX IF NOT EXISTS "flows_flowlabel_org_id_4ed2f553" ON "flows_flowlabel" ("org_id")',
            state_operations=[
                migrations.AlterField(
                    model_name="flowlabel",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="flow_labels",
                        to="orgs.org",
                    ),
                )
            ],
        ),
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "flows_flowrun_flow_id_9cbb3a32"',
            reverse_sql='CREATE INDEX IF NOT EXISTS "flows_flowrun_flow_id_9cbb3a32" ON "flows_flowrun" ("flow_id")',
            state_operations=[
                migrations.AlterField(
                    model_name="flowrun",
                    name="flow",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="runs",
                        to="flows.flow",
                    ),
                )
            ],
        ),
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "flows_flowstart_org_id_d5383c58"',
            reverse_sql='CREATE INDEX IF NOT EXISTS "flows_flowstart_org_id_d5383c58" ON "flows_flowstart" ("org_id")',
            state_operations=[
                migrations.AlterField(
                    model_name="flowstart",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="flow_starts",
                        to="orgs.org",
                    ),
                )
            ],
        ),
    ]
