from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0207_org_restricted_reason_suspends_on"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RemoveConstraint(model_name="org", name="orgs_org_suspended_on_consistent"),
                migrations.RemoveField(model_name="org", name="is_suspended"),
                migrations.RemoveField(model_name="org", name="suspended_on"),
            ],
            # the columns stay until code that still writes them is no longer running, but new inserts mustn't need them
            database_operations=[
                migrations.RunSQL(
                    """
                    ALTER TABLE orgs_org DROP CONSTRAINT orgs_org_suspended_on_consistent;
                    ALTER TABLE orgs_org ALTER COLUMN is_suspended DROP NOT NULL;
                    """,
                    migrations.RunSQL.noop,  # lets MigrationTests reverse past this
                ),
            ],
        ),
    ]
