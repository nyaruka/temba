from datetime import datetime, timedelta, timezone as tzone
from unittest.mock import patch

from django.utils import timezone

from temba.flows.models import FlowSession
from temba.flows.tasks import trim_flow_sessions
from temba.tests import TembaTest
from temba.utils.uuid import uuid4


class FlowSessionTest(TembaTest):
    @patch("temba.flows.tasks.TRIM_SESSIONS_BATCH_SIZE", 2)
    def test_trim(self):
        contact = self.create_contact("Ben Haggerty", phone="+250788123123")

        session1 = FlowSession.objects.create(
            uuid=uuid4(),
            contact_uuid=contact.uuid,
            output={"status": "completed"},
            status=FlowSession.STATUS_COMPLETED,
            ended_on=datetime(2025, 1, 15, 0, 0, 0, 0, tzone.utc),
        )
        session2 = FlowSession.objects.create(
            uuid=uuid4(),
            contact_uuid=contact.uuid,
            output={"status": "completed"},
            status=FlowSession.STATUS_COMPLETED,
            ended_on=datetime(2025, 1, 16, 0, 0, 0, 0, tzone.utc),
        )
        session3 = FlowSession.objects.create(
            uuid=uuid4(),
            contact_uuid=contact.uuid,
            output={"status": "waiting"},
            status=FlowSession.STATUS_WAITING,
        )
        session4 = FlowSession.objects.create(
            uuid=uuid4(),
            contact_uuid=contact.uuid,
            output={"status": "completed"},
            status=FlowSession.STATUS_COMPLETED,
            ended_on=timezone.now() - timedelta(days=3),
        )

        # sessions sharing an ended_on that straddle batch boundaries
        others = [
            FlowSession.objects.create(
                uuid=uuid4(),
                contact_uuid=contact.uuid,
                output={"status": "completed"},
                status=FlowSession.STATUS_COMPLETED,
                ended_on=datetime(2025, 2, 1, 0, 0, 0, 0, tzone.utc) + timedelta(days=i // 3),
            )
            for i in range(7)
        ]

        self.assertEqual({"deleted": 9}, trim_flow_sessions())

        self.assertFalse(FlowSession.objects.filter(id=session1.id).exists())
        self.assertFalse(FlowSession.objects.filter(id=session2.id).exists())
        self.assertTrue(FlowSession.objects.filter(id=session3.id).exists())  # not ended
        self.assertTrue(FlowSession.objects.filter(id=session4.id).exists())  # ended too recently
        self.assertFalse(FlowSession.objects.filter(id__in=[s.id for s in others]).exists())
