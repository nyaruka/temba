import django.db.models.deletion
from django.db import migrations, models

from temba.utils.db.operations import drop_column_index


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups
    atomic = False

    dependencies = [
        ("ivr", "0046_call_calls_by_external_id"),
        ("orgs", "0214_restrict_without_suspension"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[drop_column_index("ivr_call", "org_id", "ivr_call_org_id_f05ab39d")],
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
