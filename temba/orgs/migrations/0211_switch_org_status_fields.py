from django.db import migrations, models

# catches up rows whose status changed while the previous release was being deployed, since code from before it only
# wrote the fields being replaced
BACKFILL_SQL = """
UPDATE orgs_org o SET
    status_reason = o.restricted_reason,
    status_changed_on = COALESCE(
        (
            SELECT MAX(i.started_on) FROM notifications_incident i
            WHERE i.org_id = COALESCE(o.parent_id, o.id) AND i.incident_type = 'org:restricted' AND i.ended_on IS NULL
        ),
        o.modified_on
    )
WHERE o.status = 'R';

UPDATE orgs_org SET status_changed_on = suspended_on WHERE status = 'S';

UPDATE orgs_org SET status_reason = NULL WHERE status = 'A' AND status_reason IS NOT NULL;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0210_backfill_org_status_fields"),
    ]

    operations = [
        migrations.RunSQL(BACKFILL_SQL, migrations.RunSQL.noop),
        migrations.RemoveConstraint(model_name="org", name="orgs_org_status_consistent"),
        # the columns stay until code that still writes them is no longer running, and they're already nullable
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RemoveField(model_name="org", name="restricted_reason"),
                migrations.RemoveField(model_name="org", name="suspended_on"),
            ],
        ),
        migrations.AddConstraint(
            model_name="org",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(("status", "A"), ("status_reason__isnull", True), ("suspends_on__isnull", True)),
                    models.Q(
                        ("status", "R"),
                        ("status_changed_on__isnull", False),
                        ("status_reason__isnull", False),
                        ("suspends_on__isnull", False),
                    ),
                    models.Q(("status", "S"), ("status_changed_on__isnull", False), ("suspends_on__isnull", True)),
                    _connector="OR",
                ),
                name="orgs_org_status_consistent",
            ),
        ),
    ]
