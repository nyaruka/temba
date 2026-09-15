from datetime import datetime, timedelta, timezone as tzone
from unittest.mock import patch

from django.urls import reverse

from temba.ivr.models import Call
from temba.tests import TembaTest
from temba.utils.uuid import uuid7


class CallTest(TembaTest):
    def test_model(self):
        contact = self.create_contact("Bob", phone="+123456789")
        call = Call.objects.create(
            uuid=uuid7(),
            org=self.org,
            channel=self.channel,
            direction=Call.DIRECTION_IN,
            contact=contact,
            contact_urn=contact.get_urn(),
            status=Call.STATUS_IN_PROGRESS,
            started_on=datetime(2022, 9, 20, 13, 46, 30, 0, tzone.utc),
        )

        with patch("django.utils.timezone.now", return_value=datetime(2022, 9, 20, 13, 46, 50, 0, tzone.utc)):
            self.assertEqual(timedelta(seconds=20), call.get_duration())  # calculated
            self.assertEqual("In Progress", call.status_display)

        call.duration = 15
        call.status = Call.STATUS_ERRORED
        call.error_reason = Call.ERROR_NOANSWER
        call.save(update_fields=("status", "error_reason"))

        self.assertEqual(timedelta(seconds=15), call.get_duration())  # from duration field
        self.assertEqual("Errored (No Answer)", call.status_display)

        call.status = Call.STATUS_FAILED
        call.error_reason = Call.ERROR_SUSPENDED
        call.save(update_fields=("status", "error_reason"))

        self.assertEqual("Failed (Workspace suspended)", call.status_display)

    def test_as_json(self):
        flow = self.create_flow("IVR")
        contact = self.create_contact("Bob", phone="+250788123123")
        call = self.create_incoming_call(flow, contact)
        logs_url = reverse("channels.channel_logs_read", args=[self.channel.uuid, "call", call.uuid])

        self.assertEqual(
            {
                "uuid": str(call.uuid),
                "direction": "in",
                "status": "completed",
                "status_display": "Complete",
                "contact": {"uuid": str(contact.uuid), "name": "Bob"},
                "duration": 15,
                "created_on": call.created_on.isoformat(),
                "logs_url": logs_url,
            },
            call.as_json({"user": self.admin, "org": self.org}),
        )

        # without a context there's no way to know if the user can see the logs
        self.assertIsNone(call.as_json()["logs_url"])

        # editors can't see channel logs
        self.assertIsNone(call.as_json({"user": self.editor, "org": self.org})["logs_url"])

        # an errored call includes the reason in its status display
        call.direction = Call.DIRECTION_OUT
        call.status = Call.STATUS_ERRORED
        call.error_reason = Call.ERROR_NOANSWER
        call.save(update_fields=("direction", "status", "error_reason"))

        as_json = call.as_json()
        self.assertEqual("out", as_json["direction"])
        self.assertEqual("errored", as_json["status"])
        self.assertEqual("Errored (No Answer)", as_json["status_display"])

        # a contact without a name is displayed by the URN that was called
        contact.name = ""
        contact.save(update_fields=("name",))
        call.refresh_from_db()

        self.assertEqual({"uuid": str(contact.uuid), "name": "0788 123 123"}, call.as_json()["contact"])

        with self.anonymous(self.org):
            call = Call.objects.select_related("org").get(id=call.id)

            self.assertEqual({"uuid": str(contact.uuid), "name": contact.ref}, call.as_json()["contact"])
