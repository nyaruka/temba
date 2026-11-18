from datetime import datetime, timezone as tzone

from django.urls import reverse
from django.utils import timezone

from temba.notifications.incidents.builtin import OrgFlaggedIncidentType
from temba.notifications.models import Incident
from temba.orgs.models import Org
from temba.tests import CRUDLTestMixin, TembaTest


class IncidentCRUDLTest(TembaTest, CRUDLTestMixin):
    def test_list(self):
        list_url = reverse("notifications.incident_list")

        # create 2 org flagged incidents (1 ended, 1 ongoing)
        incident1 = OrgFlaggedIncidentType.get_or_create(self.org)
        OrgFlaggedIncidentType.get_or_create(self.org).end()
        incident2 = OrgFlaggedIncidentType.get_or_create(self.org)

        # create 2 flow webhook incidents (1 ended, 1 ongoing)
        incident3 = Incident.objects.create(
            org=self.org,
            incident_type="webhooks:unhealthy",
            scope="",
            started_on=timezone.now(),
            ended_on=timezone.now(),
        )
        incident4 = Incident.objects.create(org=self.org, incident_type="webhooks:unhealthy", scope="")

        # main list items are the ended incidents
        self.assertRequestDisallowed(list_url, [None, self.editor, self.agent])
        response = self.assertListFetch(list_url, [self.admin], context_objects=[incident3, incident1])

        # with ongoing ones in separate list
        self.assertEqual({incident4, incident2}, set(response.context["ongoing"]))

    def test_list_restricted(self):
        list_url = reverse("notifications.incident_list")
        suspends_on = datetime(2026, 12, 1, 12, 0, 0, tzinfo=tzone.utc)

        self.org.restrict(Org.RESTRICTED_BILLING, suspends_on=suspends_on)

        # an ongoing restriction says when the workspace will be suspended
        self.login(self.admin)
        response = self.client.get(list_url)
        self.assertContains(response, "Your workspace has been restricted.")
        self.assertContains(response, "your workspace will be suspended on Dec. 1, 2026")

        # an ended one doesn't
        self.org.reactivate()

        response = self.client.get(list_url)
        self.assertContains(response, "Your workspace has been restricted.")
        self.assertNotContains(response, "will be suspended on")
