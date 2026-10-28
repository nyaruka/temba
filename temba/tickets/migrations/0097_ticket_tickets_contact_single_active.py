from django.db import migrations, models


class Migration(migrations.Migration):
    # The index is built concurrently because tickets take constant writes. Any existing index is dropped first so
    # that an invalid one left by a failed build (e.g. by a contact with more than one ticket that isn't closed) doesn't
    # stop the migration being re-run. Installations large enough to care can run the following ahead of the deploy,
    # and fake this migration:
    #
    #   CREATE UNIQUE INDEX CONCURRENTLY "tickets_contact_single_active" ON tickets_ticket ("contact_id") WHERE "status" IN ('P', 'O');
    #
    atomic = False

    dependencies = [
        ("tickets", "0096_drop_tickets_open_last_activity"),
    ]

    operations = [
        migrations.RunSQL('DROP INDEX CONCURRENTLY IF EXISTS "tickets_contact_single_active"'),
        migrations.RunSQL(
            sql="""CREATE UNIQUE INDEX CONCURRENTLY "tickets_contact_single_active" ON tickets_ticket ("contact_id") WHERE "status" IN ('P', 'O')""",
            state_operations=[
                migrations.AddConstraint(
                    model_name="ticket",
                    constraint=models.UniqueConstraint(
                        condition=models.Q(("status__in", ("P", "O"))),
                        fields=("contact",),
                        name="tickets_contact_single_active",
                    ),
                ),
            ],
        ),
    ]
