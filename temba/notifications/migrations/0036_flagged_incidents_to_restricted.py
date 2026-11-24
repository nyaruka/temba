from django.db import migrations

# being flagged is a reason for a workspace to be restricted, so its incidents become restricted incidents
SQL = """
UPDATE notifications_incident f SET ended_on = NOW()
WHERE f.incident_type = 'org:flagged' AND f.ended_on IS NULL AND EXISTS (
    SELECT 1 FROM notifications_incident r
    WHERE r.org_id = f.org_id AND r.incident_type = 'org:restricted' AND r.scope = f.scope AND r.ended_on IS NULL
);

UPDATE notifications_incident SET incident_type = 'org:restricted' WHERE incident_type = 'org:flagged';
"""


class Migration(migrations.Migration):
    dependencies = [
        ("notifications", "0035_squashed"),
        ("orgs", "0215_flagged_status_reason"),
    ]

    operations = [migrations.RunSQL(SQL, migrations.RunSQL.noop)]
