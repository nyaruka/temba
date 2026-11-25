from django.utils import timezone

from temba.notifications.models import Incident, Notification
from temba.tests import MigrationTest


class FlaggedIncidentsToRestrictedTest(MigrationTest):
    app = "notifications"
    migrate_from = "0035_squashed"
    migrate_to = "0036_flagged_incidents_to_restricted"

    def setUpBeforeMigration(self, apps):
        def incident(org, incident_type, *, ended=False):
            return Incident.objects.create(
                org=org, incident_type=incident_type, scope="", ended_on=timezone.now() if ended else None
            )

        # an ongoing flagged incident in an org which already has an ongoing restricted incident
        self.org_restricted = incident(self.org, "org:restricted")
        self.org_flagged = incident(self.org, "org:flagged")

        # an ongoing and an ended flagged incident in an org with no restricted incident
        self.org2_flagged = incident(self.org2, "org:flagged")
        self.org2_ended = incident(self.org2, "org:flagged", ended=True)

        # an incident of another type
        self.org2_webhooks = incident(self.org2, "webhooks:unhealthy")

    def test_migration(self):
        def assert_incident(incident, incident_type: str, *, ongoing: bool):
            incident.refresh_from_db()
            self.assertEqual(incident_type, incident.incident_type)
            self.assertEqual(ongoing, incident.ended_on is None)

        assert_incident(self.org_restricted, "org:restricted", ongoing=True)
        assert_incident(self.org_flagged, "org:restricted", ongoing=False)
        assert_incident(self.org2_flagged, "org:restricted", ongoing=True)
        assert_incident(self.org2_ended, "org:restricted", ongoing=False)
        assert_incident(self.org2_webhooks, "webhooks:unhealthy", ongoing=True)


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
