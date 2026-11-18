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
        # status is the source of truth, and suspended_on could only have drifted from it through a workspace move
        migrations.RunSQL(
            """
            UPDATE orgs_org SET suspended_on = NULL WHERE status != 'S' AND suspended_on IS NOT NULL;
            UPDATE orgs_org SET suspended_on = NOW() WHERE status = 'S' AND suspended_on IS NULL;
            """,
            migrations.RunSQL.noop,
        ),
        migrations.AddConstraint(
            model_name="org",
            constraint=models.CheckConstraint(
                condition=models.Q(("status", "S"), ("suspended_on__isnull", False))
                | models.Q(models.Q(("status", "S"), _negated=True), ("suspended_on__isnull", True)),
                name="orgs_org_suspended_on_consistent",
            ),
        ),
    ]
