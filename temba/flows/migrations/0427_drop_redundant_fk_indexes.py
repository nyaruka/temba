import django.db.models.deletion
from django.db import migrations, models

from temba.utils.db.operations import drop_column_index


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups
    atomic = False

    dependencies = [
        ("flows", "0426_drop_flowactivitycount"),
        ("orgs", "0214_restrict_without_suspension"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[drop_column_index("flows_flowrun", "flow_id", "flows_flowrun_flow_id_9cbb3a32")],
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
        migrations.SeparateDatabaseAndState(
            database_operations=[drop_column_index("flows_flowstart", "org_id", "flows_flowstart_org_id_d5383c58")],
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
