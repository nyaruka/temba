from django.db import migrations, models

from temba.utils.models.counts import get_merge_squashed_sql


class Migration(migrations.Migration):
    # Squashing upserts the single squashed row of each set of counts, which needs a unique index over the squashed
    # rows - so any sets with more than one are merged first. The index is built concurrently because these tables
    # take constant writes, and fillfactor is lowered to leave room on each page for squashed rows to be updated in
    # place. Installations large enough to care can merge duplicates and run the following ahead of the deploy, and
    # fake this migration:
    #
    #   ALTER TABLE orgs_itemcount SET (fillfactor = 85);
    #   CREATE UNIQUE INDEX CONCURRENTLY "orgcount_squashed" ON orgs_itemcount ("org_id", "scope") WHERE "is_squashed";
    #   ALTER TABLE orgs_dailycount SET (fillfactor = 85);
    #   CREATE UNIQUE INDEX CONCURRENTLY "orgdailycount_squashed" ON orgs_dailycount ("org_id", "day", "scope") WHERE "is_squashed";
    #
    atomic = False

    dependencies = [
        ("orgs", "0195_org_max_ticket_idle_days"),
    ]

    operations = [
        migrations.RunSQL(get_merge_squashed_sql("orgs_itemcount", ("org_id", "scope"))),
        migrations.RunSQL(sql="ALTER TABLE orgs_itemcount SET (fillfactor = 85)"),
        migrations.RunSQL(
            sql='CREATE UNIQUE INDEX CONCURRENTLY "orgcount_squashed" ON orgs_itemcount ("org_id", "scope") WHERE "is_squashed"',
            state_operations=[
                migrations.AddConstraint(
                    model_name="itemcount",
                    constraint=models.UniqueConstraint(
                        condition=models.Q(("is_squashed", True)), fields=("org", "scope"), name="orgcount_squashed"
                    ),
                ),
            ],
        ),
        migrations.RunSQL(get_merge_squashed_sql("orgs_dailycount", ("org_id", "day", "scope"))),
        migrations.RunSQL(sql="ALTER TABLE orgs_dailycount SET (fillfactor = 85)"),
        migrations.RunSQL(
            sql='CREATE UNIQUE INDEX CONCURRENTLY "orgdailycount_squashed" ON orgs_dailycount ("org_id", "day", "scope") WHERE "is_squashed"',
            state_operations=[
                migrations.AddConstraint(
                    model_name="dailycount",
                    constraint=models.UniqueConstraint(
                        condition=models.Q(("is_squashed", True)),
                        fields=("org", "day", "scope"),
                        name="orgdailycount_squashed",
                    ),
                ),
            ],
        ),
    ]
