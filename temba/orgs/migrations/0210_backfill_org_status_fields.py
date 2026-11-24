from django.db import migrations

# a restricted org changed status when its restricted incident started, which for a child is its parent's incident
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
"""


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0209_org_status_reason_status_changed_on"),
    ]

    operations = [migrations.RunSQL(BACKFILL_SQL, migrations.RunSQL.noop)]
