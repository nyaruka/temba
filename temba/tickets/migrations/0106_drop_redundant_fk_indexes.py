import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups, and the drops are concurrent so as not to
    # block writes while waiting for their locks. The reverses aren't, as migration tests run them in a transaction.
    atomic = False

    dependencies = [
        ("orgs", "0215_drop_redundant_fk_indexes"),
        ("tickets", "0105_backfill_ticket_tallies"),
    ]

    operations = [
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "tickets_shortcut_org_id_5fbbda6f"',
            reverse_sql=(
                'CREATE INDEX IF NOT EXISTS "tickets_shortcut_org_id_5fbbda6f" ON "tickets_shortcut" ("org_id")'
            ),
            state_operations=[
                migrations.AlterField(
                    model_name="shortcut",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="shortcuts",
                        to="orgs.org",
                    ),
                )
            ],
        ),
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "tickets_team_org_id_2a011111"',
            reverse_sql='CREATE INDEX IF NOT EXISTS "tickets_team_org_id_2a011111" ON "tickets_team" ("org_id")',
            state_operations=[
                migrations.AlterField(
                    model_name="team",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="teams",
                        to="orgs.org",
                    ),
                )
            ],
        ),
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "tickets_topic_org_id_0b22bd8a"',
            reverse_sql='CREATE INDEX IF NOT EXISTS "tickets_topic_org_id_0b22bd8a" ON "tickets_topic" ("org_id")',
            state_operations=[
                migrations.AlterField(
                    model_name="topic",
                    name="org",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="topics",
                        to="orgs.org",
                    ),
                )
            ],
        ),
    ]
