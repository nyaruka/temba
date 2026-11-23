from datetime import datetime, timezone as tzone

from temba.notifications.incidents.builtin import ChannelDisconnectedIncidentType, WebhooksUnhealthyIncidentType
from temba.notifications.models import Incident, Notification
from temba.tests import TembaTest, matchers


class IncidentTest(TembaTest):
    def test_create(self):
        # we use a unique constraint to enforce uniqueness on org+type+scope for ongoing incidents which allows use of
        # INSERT .. ON CONFLICT DO NOTHING
        incident1 = Incident.get_or_create(self.org, "webhooks:unhealthy", scope="scope1")

        # try to create another for the same scope
        incident2 = Incident.get_or_create(self.org, "webhooks:unhealthy", scope="scope1")

        # different scope
        incident3 = Incident.get_or_create(self.org, "webhooks:unhealthy", scope="scope2")

        self.assertEqual(incident1, incident2)
        self.assertNotEqual(incident1, incident3)

        # each created incident creates a notification for the workspace admin
        self.assertEqual(2, Notification.objects.count())
        self.assertEqual(1, incident1.notifications.count())
        self.assertEqual(1, incident2.notifications.count())

        # check that once incident 1 ends, new incidents can be created for same scope
        incident1.end()

        incident4 = Incident.get_or_create(self.org, "webhooks:unhealthy", scope="scope1")

        self.assertNotEqual(incident1, incident4)
        self.assertEqual(3, Notification.objects.count())
        self.assertEqual(1, incident4.notifications.count())

    def test_end_ongoing(self):
        incident1 = Incident.get_or_create(self.org, "webhooks:unhealthy", scope="")
        incident2 = Incident.get_or_create(self.org2, "webhooks:unhealthy", scope="")
        incident3 = ChannelDisconnectedIncidentType.get_or_create(self.channel)

        WebhooksUnhealthyIncidentType.end_ongoing(self.org)

        incident1.refresh_from_db()
        incident2.refresh_from_db()
        incident3.refresh_from_db()
        self.assertIsNotNone(incident1.ended_on)
        self.assertIsNone(incident2.ended_on)  # other org
        self.assertIsNone(incident3.ended_on)  # other type

    def test_webhooks_unhealthy(self):
        incident = Incident.objects.create(  # mailroom will create these
            org=self.org,
            incident_type="webhooks:unhealthy",
            scope="",
            started_on=datetime(2021, 11, 12, 14, 23, 30, 123456, tzinfo=tzone.utc),
        )

        self.assertEqual(
            {
                "type": "webhooks:unhealthy",
                "started_on": "2021-11-12T14:23:30.123456+00:00",
                "ended_on": None,
            },
            incident.as_json(),
        )

        # incidents without anything more specific to link to link to the incident list
        self.assertEqual("/incident/", incident.type.get_notification_target_url(incident))

    def test_channel_disconnected(self):
        ChannelDisconnectedIncidentType.get_or_create(self.channel)
        incident = Incident.objects.get()

        self.assertEqual(
            {
                "type": "channel:disconnected",
                "started_on": matchers.ISODatetime(),
                "ended_on": None,
            },
            incident.as_json(),
        )
        self.assertEqual(
            f"/channels/channel/read/{self.channel.uuid}/", incident.type.get_notification_target_url(incident)
        )
