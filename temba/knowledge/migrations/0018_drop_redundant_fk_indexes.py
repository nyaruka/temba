import django.db.models.deletion
from django.db import migrations, models

from temba.utils.db.operations import drop_column_index


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups
    atomic = False

    dependencies = [
        ("knowledge", "0017_drop_articlecount"),
        ("orgs", "0214_restrict_without_suspension"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                drop_column_index("knowledge_knowledgesource", "org_id", "knowledge_knowledge_org_id_d6471729")
            ],
            state_operations=[
                migrations.AlterField(
                    model_name="knowledgesource",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="sources",
                        to="orgs.org",
                    ),
                )
            ],
        ),
    ]
