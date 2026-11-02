from django.db import migrations, models

ADD_SQL = """
ALTER TABLE tickets_ticket ADD CONSTRAINT tickets_closed_fields CHECK (
    (closed_on IS NOT NULL AND outcome IS NOT NULL AND status = 'C') OR
    (closed_on IS NULL AND outcome IS NULL AND status IN ('P', 'O'))
) NOT VALID"""


class Migration(migrations.Migration):
    # Requires that every closed ticket has a close time and outcome and no other ticket does, so this has to run
    # after 0101 and after mailroom is recording outcomes when it closes tickets and clearing them when it reopens them.
    #
    # Adding a validated constraint scans the table under an ACCESS EXCLUSIVE lock, so it's added NOT VALID (instant)
    # and then validated, which only takes a SHARE UPDATE EXCLUSIVE lock so tickets can still be written.
    atomic = False

    dependencies = [
        ("tickets", "0101_backfill_ticket_outcome"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql=[ADD_SQL, "ALTER TABLE tickets_ticket VALIDATE CONSTRAINT tickets_closed_fields"],
                    reverse_sql="ALTER TABLE tickets_ticket DROP CONSTRAINT tickets_closed_fields",
                ),
            ],
            state_operations=[
                migrations.AddConstraint(
                    model_name="ticket",
                    constraint=models.CheckConstraint(
                        condition=models.Q(
                            models.Q(("closed_on__isnull", False), ("outcome__isnull", False), ("status", "C")),
                            models.Q(
                                ("closed_on__isnull", True), ("outcome__isnull", True), ("status__in", ("P", "O"))
                            ),
                            _connector="OR",
                        ),
                        name="tickets_closed_fields",
                    ),
                ),
            ],
        ),
    ]
