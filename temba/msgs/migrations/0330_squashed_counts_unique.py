from django.db import migrations, models

from temba.utils.models.counts import get_merge_squashed_sql


class Migration(migrations.Migration):
    # Squashing upserts the single squashed row of each set of counts, which needs a unique index over the squashed
    # rows - so any sets with more than one are merged first. The index is built concurrently because these tables
    # take constant writes, and fillfactor is lowered to leave room on each page for squashed rows to be updated in
    # place. Installations large enough to care can merge duplicates and run the following ahead of the deploy, and
    # fake this migration:
    #
    #   ALTER TABLE msgs_broadcastmsgcount SET (fillfactor = 85);
    #   CREATE UNIQUE INDEX CONCURRENTLY "broadcastmsgcount_squashed" ON msgs_broadcastmsgcount ("broadcast_id") WHERE "is_squashed";
    #   ALTER TABLE msgs_labelcount SET (fillfactor = 85);
    #   CREATE UNIQUE INDEX CONCURRENTLY "labelcount_squashed" ON msgs_labelcount ("label_id") WHERE "is_squashed";
    #
    atomic = False

    dependencies = [
        ("msgs", "0329_update_triggers"),
    ]

    operations = [
        migrations.RunSQL(get_merge_squashed_sql("msgs_broadcastmsgcount", ("broadcast_id",))),
        migrations.RunSQL(sql="ALTER TABLE msgs_broadcastmsgcount SET (fillfactor = 85)"),
        migrations.RunSQL(
            sql='CREATE UNIQUE INDEX CONCURRENTLY "broadcastmsgcount_squashed" ON msgs_broadcastmsgcount ("broadcast_id") WHERE "is_squashed"',
            state_operations=[
                migrations.AddConstraint(
                    model_name="broadcastmsgcount",
                    constraint=models.UniqueConstraint(
                        condition=models.Q(("is_squashed", True)),
                        fields=("broadcast",),
                        name="broadcastmsgcount_squashed",
                    ),
                ),
            ],
        ),
        migrations.RunSQL(get_merge_squashed_sql("msgs_labelcount", ("label_id",))),
        migrations.RunSQL(sql="ALTER TABLE msgs_labelcount SET (fillfactor = 85)"),
        migrations.RunSQL(
            sql='CREATE UNIQUE INDEX CONCURRENTLY "labelcount_squashed" ON msgs_labelcount ("label_id") WHERE "is_squashed"',
            state_operations=[
                migrations.AddConstraint(
                    model_name="labelcount",
                    constraint=models.UniqueConstraint(
                        condition=models.Q(("is_squashed", True)), fields=("label",), name="labelcount_squashed"
                    ),
                ),
            ],
        ),
    ]
