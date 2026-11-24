from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0207_org_restricted_reason_suspends_on"),
    ]

    operations = [
        migrations.RemoveConstraint(model_name="org", name="orgs_org_suspended_on_consistent"),
        migrations.SeparateDatabaseAndState(
            state_operations=[migrations.RemoveField(model_name="org", name="is_suspended")],
            # the column stays until code that still writes it is no longer running, so new inserts get a default
            database_operations=[
                migrations.RunSQL(
                    "ALTER TABLE orgs_org ALTER COLUMN is_suspended SET DEFAULT FALSE",
                    migrations.RunSQL.noop,  # lets MigrationTests reverse past this
                ),
            ],
        ),
        migrations.AddConstraint(
            model_name="org",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(
                        ("restricted_reason__isnull", True),
                        ("status", "A"),
                        ("suspended_on__isnull", True),
                        ("suspends_on__isnull", True),
                    ),
                    models.Q(
                        ("restricted_reason__isnull", False),
                        ("status", "R"),
                        ("suspended_on__isnull", True),
                        ("suspends_on__isnull", False),
                    ),
                    models.Q(
                        ("restricted_reason__isnull", True),
                        ("status", "S"),
                        ("suspended_on__isnull", False),
                        ("suspends_on__isnull", True),
                    ),
                    _connector="OR",
                ),
                name="orgs_org_status_consistent",
            ),
        ),
    ]
