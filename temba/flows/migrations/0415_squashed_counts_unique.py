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
    #   ALTER TABLE flows_flowactivitycount SET (fillfactor = 85);
    #   CREATE UNIQUE INDEX CONCURRENTLY "flowactivitycount_squashed" ON flows_flowactivitycount ("flow_id", "scope") WHERE "is_squashed";
    #   ALTER TABLE flows_flowresultcount SET (fillfactor = 85);
    #   CREATE UNIQUE INDEX CONCURRENTLY "flowresultcount_squashed" ON flows_flowresultcount ("flow_id", "result", "category") WHERE "is_squashed";
    #   ALTER TABLE flows_flowstartcount SET (fillfactor = 85);
    #   CREATE UNIQUE INDEX CONCURRENTLY "flowstartcounts_squashed" ON flows_flowstartcount ("start_id") WHERE "is_squashed";
    #
    atomic = False

    dependencies = [
        ("flows", "0414_delete_msgsin_dow_counts"),
    ]

    operations = [
        migrations.RunSQL('DROP INDEX CONCURRENTLY IF EXISTS "flowactivitycount_squashed"'),
        migrations.RunSQL(get_merge_squashed_sql("flows_flowactivitycount", ("flow_id", "scope"))),
        migrations.RunSQL(sql="ALTER TABLE flows_flowactivitycount SET (fillfactor = 85)"),
        migrations.RunSQL(
            sql='CREATE UNIQUE INDEX CONCURRENTLY "flowactivitycount_squashed" ON flows_flowactivitycount ("flow_id", "scope") WHERE "is_squashed"',
            state_operations=[
                migrations.AddConstraint(
                    model_name="flowactivitycount",
                    constraint=models.UniqueConstraint(
                        condition=models.Q(("is_squashed", True)),
                        fields=("flow", "scope"),
                        name="flowactivitycount_squashed",
                    ),
                ),
            ],
        ),
        migrations.RunSQL('DROP INDEX CONCURRENTLY IF EXISTS "flowresultcount_squashed"'),
        migrations.RunSQL(get_merge_squashed_sql("flows_flowresultcount", ("flow_id", "result", "category"))),
        migrations.RunSQL(sql="ALTER TABLE flows_flowresultcount SET (fillfactor = 85)"),
        migrations.RunSQL(
            sql='CREATE UNIQUE INDEX CONCURRENTLY "flowresultcount_squashed" ON flows_flowresultcount ("flow_id", "result", "category") WHERE "is_squashed"',
            state_operations=[
                migrations.AddConstraint(
                    model_name="flowresultcount",
                    constraint=models.UniqueConstraint(
                        condition=models.Q(("is_squashed", True)),
                        fields=("flow", "result", "category"),
                        name="flowresultcount_squashed",
                    ),
                ),
            ],
        ),
        migrations.RunSQL('DROP INDEX CONCURRENTLY IF EXISTS "flowstartcounts_squashed"'),
        migrations.RunSQL(get_merge_squashed_sql("flows_flowstartcount", ("start_id",))),
        migrations.RunSQL(sql="ALTER TABLE flows_flowstartcount SET (fillfactor = 85)"),
        migrations.RunSQL(
            sql='CREATE UNIQUE INDEX CONCURRENTLY "flowstartcounts_squashed" ON flows_flowstartcount ("start_id") WHERE "is_squashed"',
            state_operations=[
                migrations.AddConstraint(
                    model_name="flowstartcount",
                    constraint=models.UniqueConstraint(
                        condition=models.Q(("is_squashed", True)), fields=("start",), name="flowstartcounts_squashed"
                    ),
                ),
            ],
        ),
    ]
