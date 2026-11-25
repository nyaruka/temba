from django.db import migrations

# a failed template sync is recorded on the channel rather than raised as an incident, so its type is gone
SQL = """
DELETE FROM notifications_notification WHERE incident_id IN (
    SELECT id FROM notifications_incident WHERE incident_type = 'channel:templates_failed'
);

DELETE FROM notifications_incident WHERE incident_type = 'channel:templates_failed';
"""


class Migration(migrations.Migration):
    dependencies = [("notifications", "0036_flagged_incidents_to_restricted")]

    operations = [migrations.RunSQL(SQL, migrations.RunSQL.noop)]
