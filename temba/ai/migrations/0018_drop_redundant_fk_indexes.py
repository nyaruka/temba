import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups, and the drops are concurrent so as not to
    # block writes while waiting for their locks. The reverses aren't, as migration tests run them in a transaction.
    atomic = False

    dependencies = [
        ("ai", "0017_drop_llmcount"),
        ("orgs", "0215_drop_redundant_fk_indexes"),
    ]

    operations = [
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "ai_llm_org_id_21c1fd13"',
            reverse_sql='CREATE INDEX IF NOT EXISTS "ai_llm_org_id_21c1fd13" ON "ai_llm" ("org_id")',
            state_operations=[
                migrations.AlterField(
                    model_name="llm",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="llms",
                        to="orgs.org",
                    ),
                )
            ],
        ),
    ]
