from django.urls import reverse
from django.utils import timezone

from temba.notifications.incidents.builtin import ChannelDisconnectedIncidentType
from temba.notifications.models import Incident
from temba.tests import CRUDLTestMixin, TembaTest


class IncidentCRUDLTest(TembaTest, CRUDLTestMixin):
    def test_list(self):
        list_url = reverse("notifications.incident_list")

        # create 2 channel disconnected incidents (1 ended, 1 ongoing)
        incident1 = ChannelDisconnectedIncidentType.get_or_create(self.channel)
        incident1.end()
        incident2 = ChannelDisconnectedIncidentType.get_or_create(self.channel)

        # create 2 flow webhook incidents (1 ended, 1 ongoing)
        incident3 = Incident.objects.create(
            org=self.org,
            incident_type="webhooks:unhealthy",
            scope="",
            started_on=timezone.now(),
            ended_on=timezone.now(),
        )
        incident4 = Incident.objects.create(org=self.org, incident_type="webhooks:unhealthy", scope="")

        # and incidents of a type which is no longer registered, which aren't listed
        Incident.objects.create(org=self.org, incident_type="foo:gone", scope="", ended_on=timezone.now())
        Incident.objects.create(org=self.org, incident_type="foo:gone", scope="")

        # main list items are the ended incidents
        self.assertRequestDisallowed(list_url, [None, self.editor, self.agent])
        response = self.assertListFetch(list_url, [self.admin], context_objects=[incident3, incident1])

        # with ongoing ones in separate list
        self.assertEqual({incident4, incident2}, set(response.context["ongoing"]))
