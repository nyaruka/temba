import django.db.models.deletion
from django.db import migrations, models

from temba.utils.db.operations import drop_column_index


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups
    atomic = False

    dependencies = [
        ("archives", "0035_alter_archive_id"),
        ("orgs", "0214_restrict_without_suspension"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[drop_column_index("archives_archive", "org_id", "archives_archive_org_id_d19c8f63")],
            state_operations=[
                migrations.AlterField(
                    model_name="archive",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="archives",
                        to="orgs.org",
                    ),
                )
            ],
        ),
    ]
