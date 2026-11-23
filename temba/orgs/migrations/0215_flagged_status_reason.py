from django.db import migrations, models

# a flag becomes a restriction of the top-level workspace (applied to its children), so a flag on a child moves to its
# parent along with its incident, and it replaces a billing or limits restriction but not a staff one or a suspension
BACKFILL_SQL = """
CREATE TEMPORARY TABLE flagged_orgs ON COMMIT DROP AS
SELECT o.id FROM orgs_org o
WHERE o.parent_id IS NULL AND o.is_active AND (
    o.is_flagged OR EXISTS (SELECT 1 FROM orgs_org c WHERE c.parent_id = o.id AND c.is_active AND c.is_flagged)
);

UPDATE orgs_org o SET
    status = 'R',
    status_reason = 'F',
    status_changed_on = COALESCE(
        (
            SELECT MIN(i.started_on) FROM notifications_incident i JOIN orgs_org io ON io.id = i.org_id
            WHERE (io.id = o.id OR io.parent_id = o.id) AND i.incident_type = 'org:flagged' AND i.ended_on IS NULL
        ),
        NOW()
    ),
    suspends_on = NULL,
    modified_on = NOW()
FROM flagged_orgs f
WHERE o.id = f.id AND (o.status = 'A' OR (o.status = 'R' AND o.status_reason IN ('B', 'L')));

UPDATE orgs_org c SET
    status = p.status,
    status_reason = p.status_reason,
    status_changed_on = p.status_changed_on,
    suspends_on = p.suspends_on,
    modified_on = NOW()
FROM orgs_org p
WHERE c.parent_id = p.id AND c.is_active AND p.status = 'R' AND p.status_reason = 'F'
AND c.status_reason IS DISTINCT FROM 'F';

UPDATE notifications_incident SET org_id = m.parent_id
FROM (
    SELECT DISTINCT ON (c.parent_id) i.id, c.parent_id
    FROM notifications_incident i
    JOIN orgs_org c ON c.id = i.org_id
    JOIN orgs_org p ON p.id = c.parent_id
    WHERE i.incident_type = 'org:flagged' AND i.ended_on IS NULL AND p.status = 'R' AND p.status_reason = 'F'
    AND NOT EXISTS (
        SELECT 1 FROM notifications_incident pi
        WHERE pi.org_id = p.id AND pi.incident_type = 'org:flagged' AND pi.ended_on IS NULL
    )
    ORDER BY c.parent_id, i.started_on
) m
WHERE notifications_incident.id = m.id;

UPDATE notifications_incident i SET ended_on = NOW()
FROM orgs_org o
WHERE i.org_id = o.id AND i.ended_on IS NULL AND (
    (i.incident_type = 'org:flagged' AND NOT (o.parent_id IS NULL AND o.status = 'R' AND o.status_reason = 'F'))
    OR (i.incident_type = 'org:restricted' AND o.status = 'R' AND o.status_reason = 'F')
);
"""


class Migration(migrations.Migration):
    dependencies = [
        ("notifications", "0035_squashed"),
        ("orgs", "0214_restrict_without_suspension"),
    ]

    operations = [
        migrations.AlterField(
            model_name="org",
            name="status_reason",
            field=models.CharField(
                choices=[("B", "Billing"), ("L", "Limits"), ("S", "Staff"), ("F", "Flagged")], max_length=1, null=True
            ),
        ),
        migrations.RunSQL(BACKFILL_SQL, migrations.RunSQL.noop),
        # the column stays until code that still writes it is no longer running
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    "ALTER TABLE orgs_org ALTER COLUMN is_flagged SET DEFAULT FALSE;", migrations.RunSQL.noop
                )
            ],
            state_operations=[migrations.RemoveField(model_name="org", name="is_flagged")],
        ),
    ]
