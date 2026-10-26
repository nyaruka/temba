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
    #   ALTER TABLE contacts_contactgroupcount SET (fillfactor = 85);
    #   CREATE UNIQUE INDEX CONCURRENTLY "contactgroupcounts_squashed" ON contacts_contactgroupcount ("group_id") WHERE "is_squashed";
    #
    atomic = False

    dependencies = [
        ("contacts", "0224_contactfire_ticket_close"),
    ]

    operations = [
        migrations.RunSQL('DROP INDEX CONCURRENTLY IF EXISTS "contactgroupcounts_squashed"'),
        migrations.RunSQL(get_merge_squashed_sql("contacts_contactgroupcount", ("group_id",))),
        migrations.RunSQL(sql="ALTER TABLE contacts_contactgroupcount SET (fillfactor = 85)"),
        migrations.RunSQL(
            sql='CREATE UNIQUE INDEX CONCURRENTLY "contactgroupcounts_squashed" ON contacts_contactgroupcount ("group_id") WHERE "is_squashed"',
            state_operations=[
                migrations.AddConstraint(
                    model_name="contactgroupcount",
                    constraint=models.UniqueConstraint(
                        condition=models.Q(("is_squashed", True)), fields=("group",), name="contactgroupcounts_squashed"
                    ),
                ),
            ],
        ),
    ]
