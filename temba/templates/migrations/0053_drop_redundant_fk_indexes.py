import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups, and the drops are concurrent so as not to
    # block writes while waiting for their locks. The reverses aren't, as migration tests run them in a transaction.
    atomic = False

    dependencies = [
        ("orgs", "0215_drop_redundant_fk_indexes"),
        ("templates", "0052_drop_template_is_active"),
    ]

    operations = [
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "templates_template_org_id_01fb381e"',
            reverse_sql=(
                'CREATE INDEX IF NOT EXISTS "templates_template_org_id_01fb381e" ON "templates_template" ("org_id")'
            ),
            state_operations=[
                migrations.AlterField(
                    model_name="template",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="templates",
                        to="orgs.org",
                    ),
                )
            ],
        ),
    ]
