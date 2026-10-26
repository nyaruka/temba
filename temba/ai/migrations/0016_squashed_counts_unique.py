from django.db import migrations, models

from temba.utils.models.counts import get_merge_squashed_sql


class Migration(migrations.Migration):
    # Squashing upserts the single squashed row of each set of counts, which needs a unique index over the squashed
    # rows - so any sets with more than one are merged first. The index is built concurrently because these tables
    # take constant writes, and fillfactor is lowered to leave room on each page for squashed rows to be updated in
    # place. Any index left invalid by a failed build is dropped first so that the migration can be re-run.
    # Installations large enough to care can merge duplicates and run the following ahead of the deploy, and fake
    # this migration:
    #
    #   ALTER TABLE ai_llmcount SET (fillfactor = 85);
    #   CREATE UNIQUE INDEX CONCURRENTLY "llmcount_squashed" ON ai_llmcount ("llm_id", "day", "scope") WHERE "is_squashed";
    #
    atomic = False

    dependencies = [
        ("ai", "0015_audit_fields_cleanup"),
    ]

    operations = [
        migrations.RunSQL('DROP INDEX CONCURRENTLY IF EXISTS "llmcount_squashed"'),
        migrations.RunSQL(get_merge_squashed_sql("ai_llmcount", ("llm_id", "day", "scope"))),
        migrations.RunSQL(sql="ALTER TABLE ai_llmcount SET (fillfactor = 85)"),
        migrations.RunSQL(
            sql='CREATE UNIQUE INDEX CONCURRENTLY "llmcount_squashed" ON ai_llmcount ("llm_id", "day", "scope") WHERE "is_squashed"',
            state_operations=[
                migrations.AddConstraint(
                    model_name="llmcount",
                    constraint=models.UniqueConstraint(
                        condition=models.Q(("is_squashed", True)),
                        fields=("llm", "day", "scope"),
                        name="llmcount_squashed",
                    ),
                ),
            ],
        ),
    ]
