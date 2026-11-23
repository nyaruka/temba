import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups, and the drops are concurrent so as not to
    # block writes while waiting for their locks. The reverses aren't, as migration tests run them in a transaction.
    atomic = False

    dependencies = [
        ("orgs", "0214_restrict_without_suspension"),
    ]

    operations = [
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "orgs_orgmembership_org_id_35cc8172"',
            reverse_sql=(
                'CREATE INDEX IF NOT EXISTS "orgs_orgmembership_org_id_35cc8172" ON "orgs_orgmembership" ("org_id")'
            ),
            state_operations=[
                migrations.AlterField(
                    model_name="orgmembership",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.CASCADE,
                        to="orgs.org",
                    ),
                )
            ],
        ),
    ]
