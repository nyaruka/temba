from django.db import migrations

# 0215 moved a child's flag to its top-level workspace, which applied it to every child, but a flag is now only for the
# workspace it was raised on, as are staff restrictions - is_flagged still records which ones were flagged before that
REPAIR_SQL = """
CREATE TEMPORARY TABLE unflagged_roots ON COMMIT DROP AS
SELECT o.id FROM orgs_org o
WHERE o.parent_id IS NULL AND o.is_active AND o.status = 'R' AND o.status_reason = 'F' AND NOT o.is_flagged
AND EXISTS (SELECT 1 FROM orgs_org c WHERE c.parent_id = o.id AND c.is_active AND c.is_flagged);

UPDATE orgs_org o SET status = 'A', status_reason = NULL, status_changed_on = NOW(), suspends_on = NULL, modified_on = NOW()
FROM unflagged_roots r WHERE o.id = r.id;

UPDATE orgs_org c SET
    status = CASE WHEN p.status != 'A' AND p.status_reason IN ('B', 'L') THEN p.status ELSE 'A' END,
    status_reason = CASE WHEN p.status != 'A' AND p.status_reason IN ('B', 'L') THEN p.status_reason END,
    status_changed_on = NOW(),
    suspends_on = CASE WHEN p.status != 'A' AND p.status_reason IN ('B', 'L') THEN p.suspends_on END,
    modified_on = NOW()
FROM orgs_org p
WHERE c.parent_id = p.id AND c.is_active AND c.status = 'R' AND c.status_reason = 'F' AND NOT c.is_flagged;

UPDATE notifications_incident SET ended_on = NULL
FROM (
    SELECT DISTINCT ON (i.org_id) i.id
    FROM notifications_incident i
    JOIN orgs_org c ON c.id = i.org_id
    WHERE c.parent_id IS NOT NULL AND c.is_active AND c.status = 'R' AND c.status_reason = 'F'
    AND i.incident_type = 'org:restricted'
    ORDER BY i.org_id, i.started_on DESC
) latest
WHERE notifications_incident.id = latest.id AND notifications_incident.ended_on IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM notifications_incident o
    WHERE o.org_id = notifications_incident.org_id AND o.incident_type = 'org:restricted' AND o.ended_on IS NULL
);

UPDATE notifications_incident SET org_id = m.child_id
FROM (
    SELECT DISTINCT ON (r.id) i.id, c.id AS child_id
    FROM unflagged_roots r
    JOIN notifications_incident i ON i.org_id = r.id AND i.incident_type = 'org:restricted' AND i.ended_on IS NULL
    JOIN orgs_org c ON c.parent_id = r.id AND c.is_active AND c.status = 'R' AND c.status_reason = 'F'
    WHERE NOT EXISTS (
        SELECT 1 FROM notifications_incident ci
        WHERE ci.org_id = c.id AND ci.incident_type = 'org:restricted' AND ci.ended_on IS NULL
    )
    ORDER BY r.id, c.id
) m
WHERE notifications_incident.id = m.id;

UPDATE notifications_incident i SET ended_on = NOW()
FROM orgs_org o
WHERE i.org_id = o.id AND i.incident_type = 'org:restricted' AND i.ended_on IS NULL AND o.status = 'A';
"""


class Migration(migrations.Migration):
    dependencies = [
        ("notifications", "0036_flagged_incidents_to_restricted"),
        ("orgs", "0215_flagged_status_reason"),
    ]

    operations = [migrations.RunSQL(REPAIR_SQL, migrations.RunSQL.noop)]
