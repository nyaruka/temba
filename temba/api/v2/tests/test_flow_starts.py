from unittest.mock import call

from django.urls import reverse

from temba.api.v2.serializers import format_datetime
from temba.flows.models import FlowStart
from temba.mailroom.client.types import Exclusions
from temba.tests import mock_mailroom

from . import APITest


class FlowStartsEndpointTest(APITest):
    @mock_mailroom
    def test_endpoint(self, mr_mocks):
        endpoint_url = reverse("api.v2.flow_starts") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotPermitted(endpoint_url, [None, self.agent])
        self.assertDeleteNotAllowed(endpoint_url)

        flow = self.create_flow("Test")

        # try to create an empty flow start
        self.assertPost(endpoint_url, self.editor, {}, errors={"flow": "This field is required."})

        # start a flow with the minimum required parameters
        joe = self.create_contact("Joe Blow", phone="+250788123123")
        response = self.assertPost(endpoint_url, self.editor, {"flow": flow.uuid, "contacts": [joe.uuid]}, status=201)

        self.assertEqual(
            mr_mocks.calls["flow_start"],
            [
                call(
                    self.org,
                    self.editor,
                    typ="A",
                    flow=flow,
                    groups=[],
                    contacts=[joe],
                    urns=[],
                    query=None,
                    exclude=Exclusions(
                        non_active=False, in_a_flow=False, started_previously=False, not_seen_since_days=0
                    ),
                    params={},
                )
            ],
        )

        # start a flow with all parameters
        hans = self.create_contact("Hans Gruber", phone="+4921551511")
        hans_group = self.create_group("hans", contacts=[hans])
        response = self.assertPost(
            endpoint_url,
            self.admin,
            {
                "urns": ["tel:+12067791212"],
                "contacts": [joe.uuid],
                "groups": [hans_group.uuid],
                "flow": flow.uuid,
                "restart_participants": False,
                "extra": {"first_name": "Ryan", "last_name": "Lewis"},
            },
            status=201,
        )

        self.assertEqual(
            mr_mocks.calls["flow_start"][-1],
            call(
                self.org,
                self.admin,
                typ="A",
                flow=flow,
                groups=[hans_group],
                contacts=[joe],
                urns=["tel:+12067791212"],
                query=None,
                exclude=Exclusions(non_active=False, in_a_flow=False, started_previously=True, not_seen_since_days=0),
                params={"first_name": "Ryan", "last_name": "Lewis"},
            ),
        )

        # if both params and extra are provided, params should be used
        response = self.assertPost(
            endpoint_url,
            self.admin,
            {
                "urns": ["tel:+12067791212"],
                "contacts": [joe.uuid],
                "groups": [hans_group.uuid],
                "flow": flow.uuid,
                "restart_participants": False,
                "extra": {"first_name": "Ryan", "last_name": "Lewis"},
                "params": {"first_name": "Bob", "last_name": "Marley"},
            },
            status=201,
        )

        self.assertEqual(
            mr_mocks.calls["flow_start"][-1],
            call(
                self.org,
                self.admin,
                typ="A",
                flow=flow,
                groups=[hans_group],
                contacts=[joe],
                urns=["tel:+12067791212"],
                query=None,
                exclude=Exclusions(non_active=False, in_a_flow=False, started_previously=True, not_seen_since_days=0),
                params={"first_name": "Bob", "last_name": "Marley"},
            ),
        )

        # calls from Zapier have user-agent set to Zapier
        response = self.assertPost(
            endpoint_url,
            self.admin,
            {"contacts": [joe.uuid], "flow": flow.uuid},
            status=201,
            zapier=True,
        )

        self.assertEqual(
            mr_mocks.calls["flow_start"][-1],
            call(
                self.org,
                self.admin,
                typ="Z",
                flow=flow,
                groups=[],
                contacts=[joe],
                urns=[],
                query=None,
                exclude=Exclusions(non_active=False, in_a_flow=False, started_previously=False, not_seen_since_days=0),
                params={},
            ),
        )

        # try to start a flow with no contact/group/URN
        self.assertPost(
            endpoint_url,
            self.admin,
            {"flow": flow.uuid, "restart_participants": True},
            errors={"non_field_errors": "Must specify at least one group, contact or URN"},
        )

        # should raise validation error for invalid JSON in extra
        self.assertPost(
            endpoint_url,
            self.admin,
            {
                "urns": ["tel:+12067791212"],
                "contacts": [joe.uuid],
                "groups": [hans_group.uuid],
                "flow": flow.uuid,
                "restart_participants": False,
                "extra": "YES",
            },
            errors={"extra": "Must be a valid JSON object"},
        )

        # a list is valid JSON, but extra has to be a dict
        self.assertPost(
            endpoint_url,
            self.admin,
            {
                "urns": ["tel:+12067791212"],
                "contacts": [joe.uuid],
                "groups": [hans_group.uuid],
                "flow": flow.uuid,
                "restart_participants": False,
                "extra": [1],
            },
            errors={"extra": "Must be a valid JSON object"},
        )

        self.assertPost(
            endpoint_url,
            self.admin,
            {
                "urns": ["tel:+12067791212"],
                "contacts": [joe.uuid],
                "groups": [hans_group.uuid],
                "flow": flow.uuid,
                "restart_participants": False,
                "params": "YES",
            },
            errors={"params": "Must be a valid JSON object"},
        )

        # a list is valid JSON, but params has to be a dict
        self.assertPost(
            endpoint_url,
            self.admin,
            {
                "urns": ["tel:+12067791212"],
                "contacts": [joe.uuid],
                "groups": [hans_group.uuid],
                "flow": flow.uuid,
                "restart_participants": False,
                "params": [1],
            },
            errors={"params": "Must be a valid JSON object"},
        )

        # params can be at most 10K characters encoded
        self.assertPost(
            endpoint_url,
            self.admin,
            {
                "urns": ["tel:+12067791212"],
                "contacts": [joe.uuid],
                "groups": [hans_group.uuid],
                "flow": flow.uuid,
                "restart_participants": False,
                "params": {"foo": "a" * 10000},
            },
            errors={"params": "Cannot exceed 10,000 characters encoded."},
        )

        # invalid URN
        self.assertPost(
            endpoint_url,
            self.admin,
            {"flow": flow.uuid, "urns": ["foo:bar"], "contacts": [joe.uuid]},
            errors={("urns", "0"): "Invalid URN: foo:bar. Ensure phone numbers contain country codes."},
        )

        # invalid contact uuid
        self.assertPost(
            endpoint_url,
            self.admin,
            {"flow": flow.uuid, "urns": ["tel:+12067791212"], "contacts": ["abcde"]},
            errors={"contacts": "No such object: abcde"},
        )

        # invalid group uuid
        self.assertPost(
            endpoint_url,
            self.admin,
            {"flow": flow.uuid, "urns": ["tel:+12067791212"], "groups": ["abcde"]},
            errors={"groups": "No such object: abcde"},
        )

        # invalid flow uuid
        self.assertPost(
            endpoint_url,
            self.admin,
            {
                "flow": "abcde",
                "urns": ["tel:+12067791212"],
            },
            errors={"flow": "No such object: abcde"},
        )

        # too many groups
        group_uuids = []
        for g in range(101):
            group_uuids.append(self.create_group("Group %d" % g).uuid)

        self.assertPost(
            endpoint_url,
            self.admin,
            {"flow": flow.uuid, "groups": group_uuids},
            errors={"groups": "Ensure this field has no more than 100 elements."},
        )

        start1, start2, start3, start4 = FlowStart.objects.order_by("id")

        # check fetching with no filtering
        response = self.assertGet(
            endpoint_url,
            [self.editor, self.admin],
            results=[start4, start3, start2, start1],
            num_queries=self.BASE_SESSION_QUERIES + 5,
        )
        self.assertEqual(
            response.json()["results"][1],
            {
                "uuid": str(start3.uuid),
                "flow": {"uuid": flow.uuid, "name": "Test"},
                "contacts": [{"uuid": joe.uuid, "name": "Joe Blow"}],
                "groups": [{"uuid": hans_group.uuid, "name": "hans"}],
                "status": "pending",
                "progress": {"total": -1, "started": 0},
                "params": {"first_name": "Bob", "last_name": "Marley"},
                "created_on": format_datetime(start3.created_on),
                "modified_on": format_datetime(start3.modified_on),
                # deprecated
                "id": start3.id,
                "extra": {"first_name": "Bob", "last_name": "Marley"},
                "restart_participants": False,
                "exclude_active": False,
            },
        )

        # check filtering by UUID
        self.assertGet(endpoint_url + f"?uuid={start2.uuid}", [self.admin], results=[start2])

        # check filtering by in invalid UUID
        self.assertGet(
            endpoint_url + "?uuid=xyz", [self.editor], errors={None: "Param 'uuid': xyz is not a valid UUID."}
        )
