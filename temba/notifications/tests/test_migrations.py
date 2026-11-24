from django.utils import timezone

from temba.notifications.models import Incident
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
