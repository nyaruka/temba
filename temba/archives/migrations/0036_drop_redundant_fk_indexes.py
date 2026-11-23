import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups, and the drops are concurrent so as not to
    # block writes while waiting for their locks. The reverses aren't, as migration tests run them in a transaction.
    atomic = False

    dependencies = [
        ("archives", "0035_alter_archive_id"),
        ("orgs", "0215_drop_redundant_fk_indexes"),
    ]

    operations = [
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "archives_archive_org_id_d19c8f63"',
            reverse_sql=(
                'CREATE INDEX IF NOT EXISTS "archives_archive_org_id_d19c8f63" ON "archives_archive" ("org_id")'
            ),
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
