from temba.notifications.models import Incident, Notification
from temba.tests import MigrationTest


class DeleteTemplatesFailedIncidentsTest(MigrationTest):
    app = "notifications"
    migrate_from = "0036_flagged_incidents_to_restricted"
    migrate_to = "0037_delete_templates_failed_incidents"

    def setUpBeforeMigration(self, apps):
        def incident(incident_type):
            return Incident.objects.create(
                org=self.org, incident_type=incident_type, scope=str(self.channel.id), channel=self.channel
            )

        def notify(incident):
            Notification.objects.create(
                org=self.org,
                notification_type="incident:started",
                scope=str(incident.id),
                user=self.admin,
                incident=incident,
                medium="UE",
            )

        self.failed = incident("channel:templates_failed")
        notify(self.failed)
        self.disconnected = incident("channel:disconnected")
        notify(self.disconnected)

    def test_migration(self):
        self.assertFalse(Incident.objects.filter(id=self.failed.id).exists())
        self.assertEqual([self.disconnected.id], list(Incident.objects.values_list("id", flat=True)))
        self.assertEqual([self.disconnected.id], list(Notification.objects.values_list("incident_id", flat=True)))
