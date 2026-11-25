from datetime import datetime, timezone as tzone
from decimal import Decimal
from unittest.mock import patch

from django.test import override_settings

from temba.ai.models import LLM
from temba.ai.types.openai.type import OpenAIType
from temba.campaigns.models import Campaign, CampaignEvent
from temba.contacts.models import ContactField, ContactImport
from temba.flows.models import Flow, FlowStart
from temba.schedules.models import Schedule
from temba.tests import MockJsonResponse, MockResponse, TembaTest
from temba.tickets.models import Topic
from temba.utils import json

from .. import modifiers
from .client import MailroomClient
from .exceptions import (
    AIServiceException,
    FlowValidationException,
    QueryValidationException,
    RequestException,
    URNValidationException,
)
from .types import ContactSpec, Exclusions, Inclusions, RecipientsPreview, ScheduleSpec, URNResult


class MailroomClientTest(TembaTest):
    def setUp(self):
        super().setUp()

        self.client = MailroomClient("http://localhost:8090", "sesame")

    @patch("requests.post")
    def test_android_event(self, mock_post):
        mock_post.return_value = MockJsonResponse(200, {"id": 12345})
        response = self.client.android_event(
            org=self.org,
            channel=self.channel,
            phone="+1234567890",
            event_type="mo_miss",
            extra={"duration": 45},
            occurred_on=datetime(2024, 4, 1, 16, 28, 30, 0, tzone.utc),
        )

        self.assertEqual({"id": 12345}, response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/android/event",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "channel_id": self.channel.id,
                "phone": "+1234567890",
                "event_type": "mo_miss",
                "extra": {"duration": 45},
                "occurred_on": "2024-04-01T16:28:30+00:00",
            },
        )

    @patch("requests.post")
    def test_android_message(self, mock_post):
        mock_post.return_value = MockJsonResponse(200, {"id": 12345})
        response = self.client.android_message(
            org=self.org,
            channel=self.channel,
            phone="+1234567890",
            text="hello",
            received_on=datetime(2024, 4, 1, 16, 28, 30, 0, tzone.utc),
        )

        self.assertEqual({"id": 12345}, response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/android/message",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "channel_id": self.channel.id,
                "phone": "+1234567890",
                "text": "hello",
                "received_on": "2024-04-01T16:28:30+00:00",
            },
        )

    @patch("requests.post")
    def test_android_sync(self, mock_post):
        mock_post.return_value = MockJsonResponse(200, {"id": 12345})
        response = self.client.android_sync(self.channel)

        self.assertEqual({"id": 12345}, response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/android/sync",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"channel_id": self.channel.id},
        )

    @patch("requests.post")
    def test_campaign_schedule(self, mock_post):
        farmers = self.create_group("Farmers", [])
        campaign = Campaign.create(self.org, self.admin, "Reminders", farmers)
        planting_date = self.create_field("planting_date", "Planting Date", value_type=ContactField.TYPE_DATETIME)
        flow = Flow.create(self.org, self.admin, "Flow")
        event = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, planting_date, offset=1, unit="W", flow=flow, delivery_hour=13
        )

        mock_post.return_value = MockJsonResponse(200, {})
        response = self.client.campaign_schedule(self.org, event)

        self.assertIsNone(response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/campaign/schedule",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "point_id": event.id},
        )

    @patch("requests.post")
    def test_channel_interrupt(self, mock_post):
        mock_post.return_value = MockJsonResponse(200, {})
        response = self.client.channel_interrupt(self.org, self.channel)

        self.assertIsNone(response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/channel/interrupt",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "channel_id": self.channel.id},
        )

    @patch("requests.post")
    def test_contact_create(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])
        mock_post.return_value = MockJsonResponse(200, {"contact": {"id": ann.id, "name": "Bob", "language": ""}})

        # try with empty contact spec
        result = self.client.contact_create(
            self.org, self.admin, ContactSpec(name="", language="", status="", urns=[], fields={}, groups=[]), "ui"
        )

        self.assertEqual(ann, result)
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/create",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "user_id": self.admin.id,
                "contact": {"name": "", "language": "", "status": "", "urns": [], "fields": {}, "groups": []},
                "via": "ui",
            },
        )

        mock_post.reset_mock()
        mock_post.return_value = MockJsonResponse(200, {"contact": {"id": bob.id, "name": "Bob", "language": "eng"}})

        result = self.client.contact_create(
            self.org,
            self.admin,
            ContactSpec(
                name="Bob",
                language="eng",
                status="active",
                urns=["tel:+123456789"],
                fields={"age": "39", "gender": "M"},
                groups=["d5b1770f-0fb6-423b-86a0-b4d51096b99a"],
            ),
            "api",
        )

        self.assertEqual(bob, result)
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/create",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "user_id": self.admin.id,
                "contact": {
                    "name": "Bob",
                    "language": "eng",
                    "status": "active",
                    "urns": ["tel:+123456789"],
                    "fields": {"age": "39", "gender": "M"},
                    "groups": ["d5b1770f-0fb6-423b-86a0-b4d51096b99a"],
                },
                "via": "api",
            },
        )

    @patch("requests.post")
    def test_contact_deindex(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])
        mock_post.return_value = MockJsonResponse(200, {"deindexed": 2})
        response = self.client.contact_deindex(self.org, [ann, bob])

        self.assertEqual({"deindexed": 2}, response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/deindex",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "contact_uuids": [str(ann.uuid), str(bob.uuid)],
            },
        )

    @patch("requests.post")
    def test_contact_reindex(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])
        mock_post.return_value = MockJsonResponse(200, {"indexed": 2})
        response = self.client.contact_reindex(self.org, [ann, bob])

        self.assertEqual({"indexed": 2}, response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/reindex",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "contact_uuids": [str(ann.uuid), str(bob.uuid)],
            },
        )

    @patch("requests.post")
    def test_contact_export(self, mock_post):
        group = self.create_group("Doctors", contacts=[])
        ann = self.create_contact("Ann", phone="+1234567001")
        bob = self.create_contact("Bob", phone="+1234567002")

        mock_post.return_value = MockJsonResponse(200, {"contact_uuids": [str(bob.uuid), str(ann.uuid)]})

        result = self.client.contact_export(self.org, group, "age = 42")

        self.assertEqual([str(bob.uuid), str(ann.uuid)], result)
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/export",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "group_id": group.id, "query": "age = 42"},
        )

    @patch("requests.post")
    def test_contact_export_preview(self, mock_post):
        group = self.create_group("Doctors", contacts=[])
        mock_post.return_value = MockJsonResponse(200, {"total": 123})

        result = self.client.contact_export_preview(self.org, group, "age = 42")

        self.assertEqual(123, result)
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/export_preview",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "group_id": group.id, "query": "age = 42"},
        )

    @patch("requests.post")
    def test_contact_import(self, mock_post):
        mock_post.return_value = MockJsonResponse(200, {"batches": 2})

        result = self.client.contact_import(self.org, ContactImport(id=1234))

        self.assertEqual(2, result)
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/import",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "import_id": 1234},
        )

    @patch("requests.post")
    def test_contact_inspect(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])
        mock_post.return_value = MockJsonResponse(200, {ann.id: {}, bob.id: {}})

        result = self.client.contact_inspect(self.org, [ann, bob])

        self.assertEqual({ann: {}, bob: {}}, result)
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/inspect",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "contact_ids": [ann.id, bob.id]},
        )

    @patch("requests.post")
    def test_contact_interrupt(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])
        mock_post.return_value = MockJsonResponse(200, {"sessions": 2})

        self.client.contact_interrupt(self.org, self.admin, [ann, bob])

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/interrupt",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "user_id": self.admin.id, "contact_ids": [ann.id, bob.id]},
        )

    @patch("requests.post")
    def test_contact_modify(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        mock_post.return_value = MockJsonResponse(
            200,
            {
                str(ann.id): {
                    "contact": {
                        "uuid": str(ann.uuid),
                        "id": ann.id,
                        "name": "Frank",
                        "timezone": "America/Los_Angeles",
                        "created_on": "2018-07-06T12:30:00.123457Z",
                    },
                    "events": [
                        {
                            "type": "contact_groups_changed",
                            "created_on": "2018-07-06T12:30:03.123456789Z",
                            "groups_added": [{"uuid": "c153e265-f7c9-4539-9dbc-9b358714b638", "name": "Doctors"}],
                        }
                    ],
                }
            },
        )

        response = self.client.contact_modify(
            self.org,
            self.admin,
            [ann],
            [
                modifiers.Name(name="Bob"),
                modifiers.Language(language="fra"),
                modifiers.Field(field=modifiers.FieldRef(key="age", name="Age"), value="43"),
                modifiers.Status(status="blocked"),
                modifiers.Groups(
                    groups=[modifiers.GroupRef(uuid="c153e265-f7c9-4539-9dbc-9b358714b638", name="Doctors")],
                    modification="add",
                ),
                modifiers.URNs(urns=["+tel+1234567890"], modification="append"),
            ],
            "ui",
        )
        self.assertEqual(str(ann.uuid), response[str(ann.id)]["contact"]["uuid"])
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/modify",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "user_id": self.admin.id,
                "contact_ids": [ann.id],
                "modifiers": [
                    {"type": "name", "name": "Bob"},
                    {"type": "language", "language": "fra"},
                    {"type": "field", "field": {"key": "age", "name": "Age"}, "value": "43"},
                    {"type": "status", "status": "blocked"},
                    {
                        "type": "groups",
                        "groups": [{"uuid": "c153e265-f7c9-4539-9dbc-9b358714b638", "name": "Doctors"}],
                        "modification": "add",
                    },
                    {"type": "urns", "urns": ["+tel+1234567890"], "modification": "append"},
                ],
                "via": "ui",
            },
        )

    @patch("requests.post")
    def test_contact_parse_query(self, mock_post):
        mock_post.return_value = MockJsonResponse(
            200, {"query": 'name ~ "frank"', "metadata": {"attributes": ["name"]}}
        )
        parsed = self.client.contact_parse_query(self.org, "frank")

        self.assertEqual('name ~ "frank"', parsed.query)
        self.assertEqual(["name"], parsed.metadata.attributes)
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/parse_query",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"query": "frank", "org_id": self.org.id, "parse_only": False},
        )

        mock_post.return_value = MockJsonResponse(400, {"error": "no such field age"})

        with self.assertRaises(RequestException):
            self.client.contact_parse_query(self.org, "age > 10")

    @patch("requests.post")
    def test_contact_populate_group(self, mock_post):
        group = self.create_group("Doctors", contacts=[])

        mock_post.return_value = MockJsonResponse(200, {})
        self.client.contact_populate_group(self.org, group)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/populate_group",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "group_id": group.id},
        )

    @patch("requests.post")
    def test_contact_search(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])
        joe = self.create_contact("Joe", urns=["tel:+12340000003"])
        group = self.create_group("Doctors", contacts=[])

        mock_post.return_value = MockJsonResponse(
            200,
            {
                "query": 'name ~ "ann"',
                "contact_uuids": [str(ann.uuid), str(bob.uuid)],
                "total": 2,
                "metadata": {"attributes": ["name"]},
            },
        )
        response = self.client.contact_search(self.org, group, "ann", "-created_on", exclude=[joe])

        self.assertEqual('name ~ "ann"', response.query)
        self.assertEqual([str(ann.uuid), str(bob.uuid)], response.contact_uuids)
        self.assertEqual(2, response.total)
        self.assertEqual(["name"], response.metadata.attributes)
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/search",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "query": "ann",
                "org_id": self.org.id,
                "group_id": group.id,
                "exclude_uuids": [str(joe.uuid)],
                "sort": "-created_on",
                "offset": 0,
                "limit": 50,
            },
        )

        # empty results
        mock_post.return_value = MockJsonResponse(
            200,
            {
                "query": 'name ~ "ann"',
                "contact_uuids": [],
                "total": 0,
                "metadata": {"attributes": ["name"]},
            },
        )
        response = self.client.contact_search(self.org, group, "ann", "-created_on")

        self.assertEqual([], response.contact_uuids)
        self.assertEqual(0, response.total)

    @patch("requests.post")
    def test_contact_urns(self, mock_post):
        mock_post.return_value = MockJsonResponse(
            200, {"urns": [{"normalized": "tel:+1234", "contact_id": 345}, {"normalized": "webchat:3a2ef3"}]}
        )

        response = self.client.contact_urns(self.org, ["tel:+1234", "webchat:3a2ef3"])

        self.assertEqual(
            [URNResult(normalized="tel:+1234", contact_id=345), URNResult(normalized="webchat:3a2ef3")], response
        )
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/contact/urns",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "urns": ["tel:+1234", "webchat:3a2ef3"]},
        )

    def test_flow_change_language(self):
        flow_def = {"nodes": [{"val": Decimal("1.23")}]}

        with patch("requests.post") as mock_post:
            mock_post.return_value = MockJsonResponse(200, {"language": "spa"})
            migrated = self.client.flow_change_language(flow_def, language="spa")

            self.assertEqual({"language": "spa"}, migrated)

        call = mock_post.call_args

        self.assertEqual(("http://localhost:8090/mi/flow/change_language",), call[0])
        self.assertEqual(
            {"User-Agent": "Temba", "Authorization": "Token sesame", "Content-Type": "application/json"},
            call[1]["headers"],
        )
        self.assertEqual({"flow": flow_def, "language": "spa"}, json.loads(call[1]["data"]))

    @override_settings(TESTING=False)
    def test_flow_inspect(self):
        flow_def = {"nodes": [{"val": Decimal("1.23")}]}

        with patch("requests.post") as mock_post:
            mock_post.return_value = MockJsonResponse(200, {"dependencies": []})
            info = self.client.flow_inspect(self.org, flow_def)

            self.assertEqual({"dependencies": []}, info)

        call = mock_post.call_args

        self.assertEqual(("http://localhost:8090/mi/flow/inspect",), call[0])
        self.assertEqual(
            {"User-Agent": "Temba", "Authorization": "Token sesame", "Content-Type": "application/json"},
            call[1]["headers"],
        )
        self.assertEqual({"org_id": self.org.id, "flow": flow_def, "is_import": False}, json.loads(call[1]["data"]))

    def test_flow_migrate(self):
        flow_def = {"nodes": [{"val": Decimal("1.23")}]}

        with patch("requests.post") as mock_post:
            mock_post.return_value = MockJsonResponse(200, {"name": "Migrated!"})
            migrated = self.client.flow_migrate(flow_def, to_version="13.1.0")

            self.assertEqual({"name": "Migrated!"}, migrated)

        call = mock_post.call_args

        self.assertEqual(("http://localhost:8090/mi/flow/migrate",), call[0])
        self.assertEqual(
            {"User-Agent": "Temba", "Authorization": "Token sesame", "Content-Type": "application/json"},
            call[1]["headers"],
        )
        self.assertEqual({"flow": flow_def, "to_version": "13.1.0"}, json.loads(call[1]["data"]))

    @patch("requests.post")
    def test_flow_start(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])
        group = self.create_group("Doctors", contacts=[])
        flow = Flow.create(self.org, self.admin, "Flow")
        start = self.create_flowstart(flow, self.admin)

        mock_post.return_value = MockJsonResponse(200, {"id": start.id})
        result = self.client.flow_start(
            self.org,
            self.admin,
            FlowStart.TYPE_MANUAL,
            flow,
            [group],
            [ann, bob],
            ["tel:1234"],
            "age > 20",
            Exclusions(in_a_flow=True),
            params={"foo": "bar"},
        )

        self.assertEqual(start, result)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/flow/start",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "user_id": self.admin.id,
                "type": "M",
                "flow_id": flow.id,
                "group_ids": [group.id],
                "contact_ids": [ann.id, bob.id],
                "urns": ["tel:1234"],
                "query": "age > 20",
                "exclude": {
                    "in_a_flow": True,
                    "non_active": False,
                    "not_seen_since_days": 0,
                    "started_previously": False,
                },
                "params": {"foo": "bar"},
            },
        )

    def test_flow_start_preview(self):
        flow = self.create_flow("Test Flow")

        with patch("requests.post") as mock_post:
            mock_resp = {"query": 'group = "Farmers" AND status = "active"', "total": 2345}
            mock_post.return_value = MockJsonResponse(200, mock_resp)
            preview = self.client.flow_start_preview(
                self.org,
                flow,
                include=Inclusions(
                    group_uuids=["1e42a9dd-3683-477d-a3d8-19db951bcae0"],
                    contact_uuids=["ad32f9a9-e26e-4628-b39b-a54f177abea8"],
                ),
                exclude=Exclusions(non_active=True, not_seen_since_days=30),
            )

            self.assertEqual(RecipientsPreview(query='group = "Farmers" AND status = "active"', total=2345), preview)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/flow/start_preview",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "flow_id": flow.id,
                "include": {
                    "group_uuids": ["1e42a9dd-3683-477d-a3d8-19db951bcae0"],
                    "contact_uuids": ["ad32f9a9-e26e-4628-b39b-a54f177abea8"],
                    "query": "",
                },
                "exclude": {
                    "non_active": True,
                    "in_a_flow": False,
                    "started_previously": False,
                    "not_seen_since_days": 30,
                },
            },
        )

    @patch("requests.post")
    def test_llm_translate(self, mock_post):
        llm = LLM.create(self.org, self.admin, OpenAIType(), "gpt-4o", "GPT-4", {})

        items = {
            "a1f0e2c4:text": ["Hello world"],
            "a1f0e2c4:quick_replies": ["Yes", "No"],
        }
        translated = {
            "a1f0e2c4:text": ["Hola mundo"],
            "a1f0e2c4:quick_replies": ["Sí", "No"],
        }

        mock_post.return_value = MockJsonResponse(200, {"items": translated})
        response = self.client.llm_translate(llm, source="eng", target="spa", items=items)

        self.assertEqual(translated, response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/llm/translate",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "llm_id": llm.id,
                "source": "eng",
                "target": "spa",
                "items": items,
            },
        )

        mock_post.return_value = MockJsonResponse(
            422,
            {
                "code": "ai:unknown",
                "error": "rate limit exceeded",
                "extra": {"instructions": "", "input": ""},
            },
        )

        with self.assertRaises(AIServiceException) as e:
            self.client.llm_translate(llm, source="eng", target="spa", items=items)

        self.assertEqual("rate limit exceeded", e.exception.error)
        self.assertEqual("unknown", e.exception.code)

    @patch("requests.post")
    def test_msg_broadcast(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])
        group = self.create_group("Doctors", contacts=[])
        optin = self.create_optin("Cat Facts")
        bcast = self.create_broadcast(self.admin, {"eng": {"text": "Hello"}}, groups=[group])
        template = self.create_template("reminder", [])

        mock_post.return_value = MockJsonResponse(200, {"id": bcast.id})
        result = self.client.msg_broadcast(
            self.org,
            self.admin,
            {"eng": {"text": "Hello"}},
            "eng",
            [group],
            [ann, bob],
            ["tel:1234"],
            "age > 20",
            "",
            Exclusions(in_a_flow=True),
            optin,
            template,
            ["@contact"],
            ScheduleSpec(start="2024-06-20T16:23:30Z", repeat_period=Schedule.REPEAT_DAILY),
        )

        self.assertEqual(bcast, result)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/msg/broadcast",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "user_id": self.admin.id,
                "translations": {"eng": {"text": "Hello"}},
                "base_language": "eng",
                "group_ids": [group.id],
                "contact_ids": [ann.id, bob.id],
                "urns": ["tel:1234"],
                "query": "age > 20",
                "node_uuid": "",
                "exclude": {
                    "in_a_flow": True,
                    "non_active": False,
                    "not_seen_since_days": 0,
                    "started_previously": False,
                },
                "optin_id": optin.id,
                "template_id": template.id,
                "template_variables": ["@contact"],
                "schedule": {"start": "2024-06-20T16:23:30Z", "repeat_period": "D", "repeat_days_of_week": None},
            },
        )

    @patch("requests.post")
    def test_msg_broadcast_preview(self, mock_post):
        mock_resp = {"query": 'group = "Farmers" AND status = "active"', "total": 2345}
        mock_post.return_value = MockJsonResponse(200, mock_resp)
        preview = self.client.msg_broadcast_preview(
            self.org,
            include=Inclusions(
                group_uuids=["1e42a9dd-3683-477d-a3d8-19db951bcae0"],
                contact_uuids=["ad32f9a9-e26e-4628-b39b-a54f177abea8"],
            ),
            exclude=Exclusions(non_active=True, not_seen_since_days=30),
        )

        self.assertEqual(RecipientsPreview(query='group = "Farmers" AND status = "active"', total=2345), preview)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/msg/broadcast_preview",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "include": {
                    "group_uuids": ["1e42a9dd-3683-477d-a3d8-19db951bcae0"],
                    "contact_uuids": ["ad32f9a9-e26e-4628-b39b-a54f177abea8"],
                    "query": "",
                },
                "exclude": {
                    "non_active": True,
                    "in_a_flow": False,
                    "started_previously": False,
                    "not_seen_since_days": 30,
                },
            },
        )

    @patch("requests.post")
    def test_msg_delete(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        msg1 = self.create_incoming_msg(ann, "Hi")
        msg2 = self.create_incoming_msg(ann, "Hi again")
        mock_post.return_value = MockJsonResponse(200, {})
        response = self.client.msg_delete(self.org, self.admin, [msg1, msg2])

        self.assertEqual({}, response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/msg/delete",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "user_id": self.admin.id, "msg_uuids": [str(msg1.uuid), str(msg2.uuid)]},
        )

    @patch("requests.post")
    def test_msg_handle(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        msg1 = self.create_incoming_msg(ann, "Hi")
        msg2 = self.create_incoming_msg(ann, "Hi again")
        mock_post.return_value = MockJsonResponse(200, {"msg_uuids": [str(msg1.uuid)]})
        response = self.client.msg_handle(self.org, [msg1, msg2])

        self.assertEqual({"msg_uuids": [str(msg1.uuid)]}, response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/msg/handle",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "msg_uuids": [str(msg1.uuid), str(msg2.uuid)]},
        )

    @patch("requests.post")
    def test_msg_resend(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        msg1 = self.create_outgoing_msg(ann, "Hi")
        msg2 = self.create_outgoing_msg(ann, "Hi again")
        mock_post.return_value = MockJsonResponse(200, {"msg_uuids": [str(msg1.uuid)]})
        response = self.client.msg_resend(self.org, self.admin, msgs=[msg1, msg2])

        self.assertEqual({"msg_uuids": [str(msg1.uuid)]}, response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/msg/resend",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "user_id": self.admin.id, "msg_uuids": [str(msg1.uuid), str(msg2.uuid)]},
        )

    @patch("requests.post")
    def test_msg_search(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])

        mock_post.return_value = MockJsonResponse(
            200,
            {
                "results": [
                    {
                        "contact": {"uuid": str(bob.uuid)},
                        "event": {
                            "uuid": "3af672d8-b10f-4bbf-9e3b-f93955fgb95b",
                            "type": "msg_received",
                            "text": "hello there friend",
                            "created_on": "2025-05-01T13:00:00Z",
                        },
                    },
                    {
                        "contact": {"uuid": str(ann.uuid)},
                        "event": {
                            "uuid": "2ef672d8-a10f-4aaf-8e2a-e83844efa94a",
                            "type": "msg_received",
                            "text": "hello world",
                            "created_on": "2025-05-01T12:00:00Z",
                        },
                    },
                ],
            },
        )

        result = self.client.msg_search(self.org, "hello")

        self.assertEqual(
            [
                (
                    bob,
                    {
                        "uuid": "3af672d8-b10f-4bbf-9e3b-f93955fgb95b",
                        "type": "msg_received",
                        "text": "hello there friend",
                        "created_on": "2025-05-01T13:00:00Z",
                    },
                ),
                (
                    ann,
                    {
                        "uuid": "2ef672d8-a10f-4aaf-8e2a-e83844efa94a",
                        "type": "msg_received",
                        "text": "hello world",
                        "created_on": "2025-05-01T12:00:00Z",
                    },
                ),
            ],
            result,
        )

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/msg/search",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "text": "hello", "contact_uuid": None, "in_ticket": False},
        )
        mock_post.reset_mock()

        result = self.client.msg_search(self.org, "hello", contact=bob, in_ticket=True)

        self.assertEqual(
            [
                (
                    bob,
                    {
                        "uuid": "3af672d8-b10f-4bbf-9e3b-f93955fgb95b",
                        "type": "msg_received",
                        "text": "hello there friend",
                        "created_on": "2025-05-01T13:00:00Z",
                    },
                ),
                (
                    ann,
                    {
                        "uuid": "2ef672d8-a10f-4aaf-8e2a-e83844efa94a",
                        "type": "msg_received",
                        "text": "hello world",
                        "created_on": "2025-05-01T12:00:00Z",
                    },
                ),
            ],
            result,
        )

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/msg/search",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "text": "hello", "contact_uuid": str(bob.uuid), "in_ticket": True},
        )

    @patch("requests.post")
    def test_msg_send(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        ticket = self.create_ticket(ann)
        mock_post.return_value = MockJsonResponse(200, {"id": 12345})
        response = self.client.msg_send(
            self.org,
            self.admin,
            ann,
            "hi",
            [],
            [{"type": "text", "text": "Yes", "extra": "Let's go!"}, {"type": "text", "text": "No"}],
            ticket,
        )

        self.assertEqual({"id": 12345}, response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/msg/send",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "user_id": self.admin.id,
                "contact_id": ann.id,
                "text": "hi",
                "attachments": [],
                "quick_replies": [
                    {"type": "text", "text": "Yes", "extra": "Let's go!"},
                    {"type": "text", "text": "No"},
                ],
                "ticket_uuid": str(ticket.uuid),
            },
        )

    @patch("requests.post")
    def test_org_deindex(self, mock_post):
        mock_post.return_value = MockJsonResponse(200, {})
        response = self.client.org_deindex(self.org)

        self.assertEqual({}, response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/org/deindex",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id},
        )

    def test_po_export(self):
        flow1 = self.create_flow("Flow 1")
        flow2 = self.create_flow("Flow 2")

        with patch("requests.post") as mock_post:
            mock_post.return_value = MockResponse(200, 'msgid "Red"\nmsgstr "Rojo"\n\n')
            response = self.client.po_export(self.org, [flow1, flow2], "spa")

        self.assertEqual(b'msgid "Red"\nmsgstr "Rojo"\n\n', response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/po/export",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={"org_id": self.org.id, "flow_ids": [flow1.id, flow2.id], "language": "spa"},
        )

    def test_po_import(self):
        flow1 = self.create_flow("Flow 1")
        flow2 = self.create_flow("Flow 2")

        with patch("requests.post") as mock_post:
            mock_post.return_value = MockJsonResponse(200, {"flows": []})
            response = self.client.po_import(self.org, [flow1, flow2], "spa", b'msgid "Red"\nmsgstr "Rojo"\n\n')

        self.assertEqual({"flows": []}, response)

        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/po/import",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            data={"org_id": self.org.id, "flow_ids": [flow1.id, flow2.id], "language": "spa"},
            files={"po": b'msgid "Red"\nmsgstr "Rojo"\n\n'},
        )

    @patch("requests.post")
    def test_ticket_add_note(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])
        ticket1 = self.create_ticket(ann)
        ticket2 = self.create_ticket(bob)

        mock_post.return_value = MockJsonResponse(200, {"changed_uuids": [str(ticket1.uuid)]})
        response = self.client.ticket_add_note(self.org, self.admin, [ticket1, ticket2], "please handle", "ui")

        self.assertEqual({"changed_uuids": [str(ticket1.uuid)]}, response)
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/ticket/add_note",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "user_id": self.admin.id,
                "ticket_uuids": [str(ticket1.uuid), str(ticket2.uuid)],
                "note": "please handle",
                "via": "ui",
            },
        )

    @patch("requests.post")
    def test_ticket_change_assignee(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])
        ticket1 = self.create_ticket(ann)
        ticket2 = self.create_ticket(bob)

        mock_post.return_value = MockJsonResponse(200, {"changed_uuids": [str(ticket1.uuid)]})
        response = self.client.ticket_change_assignee(self.org, self.admin, [ticket1, ticket2], self.agent, "ui")

        self.assertEqual({"changed_uuids": [str(ticket1.uuid)]}, response)
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/ticket/change_assignee",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "user_id": self.admin.id,
                "ticket_uuids": [str(ticket1.uuid), str(ticket2.uuid)],
                "assignee_id": self.agent.id,
                "via": "ui",
            },
        )

    @patch("requests.post")
    def test_ticket_change_topic(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])
        ticket1 = self.create_ticket(ann)
        ticket2 = self.create_ticket(bob)
        topic = Topic.create(self.org, self.admin, "Support")

        mock_post.return_value = MockJsonResponse(200, {"changed_uuids": [str(ticket1.uuid)]})
        response = self.client.ticket_change_topic(self.org, self.admin, [ticket1, ticket2], topic, "ui")

        self.assertEqual({"changed_uuids": [str(ticket1.uuid)]}, response)
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/ticket/change_topic",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "user_id": self.admin.id,
                "ticket_uuids": [str(ticket1.uuid), str(ticket2.uuid)],
                "topic_uuid": str(topic.uuid),
                "via": "ui",
            },
        )

    @patch("requests.post")
    def test_ticket_close(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])
        ticket1 = self.create_ticket(ann)
        ticket2 = self.create_ticket(bob)

        mock_post.return_value = MockJsonResponse(200, {"changed_uuids": [str(ticket1.uuid)]})
        response = self.client.ticket_close(self.org, self.admin, [ticket1, ticket2], "ui")

        self.assertEqual({"changed_uuids": [str(ticket1.uuid)]}, response)
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/ticket/close",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "user_id": self.admin.id,
                "ticket_uuids": [str(ticket1.uuid), str(ticket2.uuid)],
                "via": "ui",
            },
        )

    @patch("requests.post")
    def test_ticket_reopen(self, mock_post):
        ann = self.create_contact("Ann", urns=["tel:+12340000001"])
        bob = self.create_contact("Bob", urns=["tel:+12340000002"])
        ticket1 = self.create_ticket(ann)
        ticket2 = self.create_ticket(bob)

        mock_post.return_value = MockJsonResponse(200, {"changed_uuids": [str(ticket1.uuid)]})
        response = self.client.ticket_reopen(self.org, self.admin, [ticket1, ticket2], "ui")

        self.assertEqual({"changed_uuids": [str(ticket1.uuid)]}, response)
        mock_post.assert_called_once_with(
            "http://localhost:8090/mi/ticket/reopen",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            json={
                "org_id": self.org.id,
                "user_id": self.admin.id,
                "ticket_uuids": [str(ticket1.uuid), str(ticket2.uuid)],
                "via": "ui",
            },
        )

    @patch("requests.post")
    def test_errors(self, mock_post):
        group = self.create_group("Doctors", contacts=[])

        mock_post.return_value = MockJsonResponse(422, {"error": "node isn't valid", "code": "flow:invalid"})

        with self.assertRaises(FlowValidationException) as e:
            self.client.flow_inspect(self.org, {})

        self.assertEqual("node isn't valid", e.exception.error)
        self.assertEqual("node isn't valid", str(e.exception))

        mock_post.return_value = MockJsonResponse(
            422, {"error": "no such field age", "code": "query:unknown_property", "extra": {"property": "age"}}
        )

        with self.assertRaises(QueryValidationException) as e:
            self.client.contact_search(self.org, group, "age > 10", "-created_on")

        self.assertEqual("no such field age", e.exception.error)
        self.assertEqual("unknown_property", e.exception.code)
        self.assertEqual({"property": "age"}, e.exception.extra)
        self.assertEqual("Can't resolve 'age' to a field or URN scheme.", str(e.exception))

        mock_post.return_value = MockJsonResponse(
            422, {"error": "URN 1 is taken", "code": "urn:taken", "extra": {"index": 1}}
        )

        with self.assertRaises(URNValidationException) as e:
            self.client.contact_create(
                self.org,
                self.admin,
                ContactSpec(name="Bob", language="eng", status="active", urns=["tel:+123456789"], fields={}, groups=[]),
                "ui",
            )

        self.assertEqual("URN 1 is taken", e.exception.error)
        self.assertEqual("taken", e.exception.code)
        self.assertEqual(1, e.exception.index)
        self.assertEqual("URN 1 is taken", str(e.exception))

        mock_post.return_value = MockJsonResponse(500, {"error": "error loading fields"})

        with self.assertRaises(RequestException) as e:
            self.client.contact_search(self.org, group, "age > 10", "-created_on")

        self.assertEqual("error loading fields", e.exception.error)

        mock_post.return_value = MockResponse(502, "Bad Gateway")

        with self.assertRaises(RequestException) as e:
            self.client.contact_search(self.org, group, "age > 10", "-created_on")

        self.assertEqual("Bad Gateway", e.exception.error)


class QueryExceptionTest(TembaTest):
    def test_str(self):
        tests = (
            (
                QueryValidationException("mismatched input '$' expecting {'(', TEXT, STRING}", "syntax"),
                "Invalid query syntax.",
            ),
            (
                QueryValidationException("can't convert 'XZ' to a number", "invalid_number", {"value": "XZ"}),
                "Unable to convert 'XZ' to a number.",
            ),
            (
                QueryValidationException("can't convert 'AB' to a date", "invalid_date", {"value": "AB"}),
                "Unable to convert 'AB' to a date.",
            ),
            (
                QueryValidationException(
                    "'Cool Kids' is not a valid group name", "invalid_group", {"value": "Cool Kids"}
                ),
                "'Cool Kids' is not a valid group name.",
            ),
            (
                QueryValidationException(
                    "'zzzzzz' is not a valid language code", "invalid_language", {"value": "zzzz"}
                ),
                "'zzzz' is not a valid language code.",
            ),
            (
                QueryValidationException(
                    "contains operator on name requires token of minimum length 2",
                    "invalid_partial_name",
                    {"min_token_length": "2"},
                ),
                "Using ~ with name requires token of at least 2 characters.",
            ),
            (
                QueryValidationException(
                    "contains operator on URN requires value of minimum length 3",
                    "invalid_partial_urn",
                    {"min_value_length": "3"},
                ),
                "Using ~ with URN requires value of at least 3 characters.",
            ),
            (
                QueryValidationException(
                    "contains conditions can only be used with name or URN values",
                    "unsupported_contains",
                    {"property": "uuid"},
                ),
                "Can only use ~ with name or URN values.",
            ),
            (
                QueryValidationException(
                    "comparisons with > can only be used with date and number fields",
                    "unsupported_comparison",
                    {"property": "uuid", "operator": ">"},
                ),
                "Can only use > with number or date values.",
            ),
            (
                QueryValidationException(
                    "can't check whether 'uuid' is set or not set",
                    "unsupported_setcheck",
                    {"property": "uuid", "operator": "!="},
                ),
                "Can't check whether 'uuid' is set or not set.",
            ),
            (
                QueryValidationException(
                    "can't resolve 'beers' to attribute, scheme or field", "unknown_property", {"property": "beers"}
                ),
                "Can't resolve 'beers' to a field or URN scheme.",
            ),
            (
                QueryValidationException("unknown property type 'xxx'", "unknown_property_type", {"type": "xxx"}),
                "Prefixes must be 'fields' or 'urns'.",
            ),
            (
                QueryValidationException("cannot query on redacted URNs", "redacted_urns", {}),
                "Can't query on URNs in an anonymous workspace.",
            ),
            (QueryValidationException("no code here", "", {}), "no code here"),
        )

        for exception, expected in tests:
            self.assertEqual(expected, str(exception))
