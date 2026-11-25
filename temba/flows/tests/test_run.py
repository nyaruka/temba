from datetime import datetime, timezone as tzone
from uuid import UUID

from django.utils import timezone

from temba.flows.models import FlowRun, FlowSession
from temba.tests import TembaTest, matchers, mock_mailroom
from temba.tests.engine import MockSessionWriter
from temba.utils.uuid import uuid4


class FlowRunTest(TembaTest):
    def setUp(self):
        super().setUp()

        self.contact = self.create_contact("Ben Haggerty", phone="+250788123123")

    def test_get_path(self):
        flow = self.create_flow("Test")

        run = FlowRun.objects.create(
            uuid=uuid4(),
            org=self.org,
            flow=flow,
            contact=self.contact,
            status=FlowRun.STATUS_WAITING,
            session_uuid="082cb7a8-a8fc-468d-b0a4-06f5a5179e2b",
            path_nodes=[UUID("857a1498-3d5f-40f5-8185-2ce596ce2677"), UUID("59d992c6-c491-473d-a7e9-4f431d705c01")],
            path_times=[
                datetime(2021, 12, 20, 8, 47, 30, 123000, tzinfo=tzone.utc),
                datetime(2021, 12, 20, 8, 47, 30, 234000, tzinfo=tzone.utc),
            ],
            current_node_uuid="59d992c6-c491-473d-a7e9-4f431d705c01",
        )

        self.assertEqual(
            [
                FlowRun.Step(
                    node=UUID("857a1498-3d5f-40f5-8185-2ce596ce2677"),
                    time=datetime(2021, 12, 20, 8, 47, 30, 123000, tzinfo=tzone.utc),
                ),
                FlowRun.Step(
                    node=UUID("59d992c6-c491-473d-a7e9-4f431d705c01"),
                    time=datetime(2021, 12, 20, 8, 47, 30, 234000, tzinfo=tzone.utc),
                ),
            ],
            run.get_path(),
        )

    @mock_mailroom
    def test_as_archive_json(self, mr_mocks):
        flow = self.get_flow("color_v13")
        flow_nodes = flow.get_definition()["nodes"]
        color_prompt = flow_nodes[0]
        color_split = flow_nodes[4]
        color_other = flow_nodes[3]

        msg_in = self.create_incoming_msg(self.contact, "green")

        run = (
            MockSessionWriter(self.contact, flow)
            .visit(color_prompt)
            .send_msg("What is your favorite color?", self.channel)
            .visit(color_split)
            .wait()
            .resume(msg=msg_in)
            .set_result("Color", "green", "Other", "green")
            .visit(color_other)
            .send_msg("That is a funny color. Try again.", self.channel)
            .visit(color_split)
            .wait()
            .save()
        )[0]

        run_json = run.as_archive_json()

        self.assertEqual(
            set(run_json.keys()),
            set(
                [
                    "id",
                    "uuid",
                    "flow",
                    "contact",
                    "responded",
                    "path",
                    "values",
                    "created_on",
                    "modified_on",
                    "exited_on",
                    "exit_type",
                ]
            ),
        )

        self.assertEqual(run.id, run_json["id"])
        self.assertEqual({"uuid": str(flow.uuid), "name": "Colors"}, run_json["flow"])
        self.assertEqual({"uuid": str(self.contact.uuid), "name": "Ben Haggerty"}, run_json["contact"])
        self.assertTrue(run_json["responded"])

        self.assertEqual(
            [
                {"node": matchers.UUIDString(version=4), "time": matchers.ISODatetime()},
                {"node": matchers.UUIDString(version=4), "time": matchers.ISODatetime()},
                {"node": matchers.UUIDString(version=4), "time": matchers.ISODatetime()},
                {"node": matchers.UUIDString(version=4), "time": matchers.ISODatetime()},
            ],
            run_json["path"],
        )

        self.assertEqual(
            {
                "color": {
                    "category": "Other",
                    "name": "Color",
                    "node": matchers.UUIDString(version=4),
                    "time": matchers.ISODatetime(),
                    "value": "green",
                    "input": "green",
                }
            },
            run_json["values"],
        )

        self.assertEqual(run.created_on.isoformat(), run_json["created_on"])
        self.assertEqual(run.modified_on.isoformat(), run_json["modified_on"])
        self.assertIsNone(run_json["exit_type"])
        self.assertIsNone(run_json["exited_on"])

    def test_big_ids(self):
        # create a session and run with big ids
        session = FlowSession.objects.create(
            id=3_000_000_000,
            uuid=uuid4(),
            contact_uuid=self.contact.uuid,
            status=FlowSession.STATUS_WAITING,
            output={"status": "waiting"},
            created_on=timezone.now(),
        )
        FlowRun.objects.create(
            id=4_000_000_000,
            uuid=uuid4(),
            org=self.org,
            flow=self.create_flow("Test"),
            contact=self.contact,
            status=FlowRun.STATUS_WAITING,
            session_uuid=session.uuid,
            created_on=timezone.now(),
            modified_on=timezone.now(),
            current_node_uuid="59d992c6-c491-473d-a7e9-4f431d705c01",
        )
