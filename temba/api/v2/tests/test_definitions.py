from django.urls import reverse

from temba.campaigns.models import Campaign, CampaignEvent
from temba.contacts.models import ContactField
from temba.flows.models import Flow
from temba.tests import mock_mailroom
from temba.triggers.models import Trigger

from . import APITest


class DefinitionsEndpointTest(APITest):
    @mock_mailroom
    def test_endpoint(self, mr_mocks):
        endpoint_url = reverse("api.v2.definitions") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        # create a flow with subflow dependencies
        flow1 = self.create_flow("Parent Flow")
        flow2 = self.create_flow("Child Flow 1")
        flow3 = self.create_flow("Child Flow 2")
        flow1.flow_dependencies.add(flow2, flow3)

        # that's used in a campaign
        field = self.create_field("registered", "Registered", ContactField.TYPE_DATETIME)
        group = self.create_group("Others", [])
        campaign1 = Campaign.create(self.org, self.admin, "Reminders", group)
        CampaignEvent.create_flow_event(self.org, self.admin, campaign1, field, 1, "D", flow1, -1)

        # and has a trigger
        Trigger.create(
            self.org, self.editor, Trigger.TYPE_KEYWORD, flow1, keywords=["test"], match_type=Trigger.MATCH_FIRST_WORD
        )

        # nothing specified, nothing exported
        self.assertGet(
            endpoint_url,
            [self.editor],
            raw=lambda j: len(j["flows"]) == 0 and len(j["campaigns"]) == 0 and len(j["triggers"]) == 0,
        )

        # flow + all dependencies by default
        self.assertGet(
            endpoint_url + f"?flow={flow1.uuid}",
            [self.editor],
            raw=lambda j: (
                {f["name"] for f in j["flows"]} == {"Parent Flow", "Child Flow 1", "Child Flow 2"}
                and len(j["campaigns"]) == 1
                and len(j["triggers"]) == 1
            ),
        )

        # flow + all dependencies explicitly
        self.assertGet(
            endpoint_url + f"?flow={flow1.uuid}&dependencies=all",
            [self.editor],
            raw=lambda j: (
                {f["name"] for f in j["flows"]} == {"Parent Flow", "Child Flow 1", "Child Flow 2"}
                and len(j["campaigns"]) == 1
                and len(j["triggers"]) == 1
            ),
        )

        # flow + no dependencies
        self.assertGet(
            endpoint_url + f"?flow={flow1.uuid}&dependencies=none",
            [self.editor],
            raw=lambda j: (
                {f["name"] for f in j["flows"]} == {"Parent Flow"}
                and len(j["campaigns"]) == 0
                and len(j["triggers"]) == 0
            ),
        )

        # flow + just flow dependencies (includes triggers)
        self.assertGet(
            endpoint_url + f"?flow={flow1.uuid}&dependencies=flows",
            [self.editor],
            raw=lambda j: (
                {f["name"] for f in j["flows"]} == {"Parent Flow", "Child Flow 1", "Child Flow 2"}
                and len(j["campaigns"]) == 0
                and len(j["triggers"]) == 1
            ),
        )

        # campaign + all dependencies
        self.assertGet(
            endpoint_url + f"?campaign={campaign1.uuid}",
            [self.editor],
            raw=lambda j: len(j["flows"]) == 3 and len(j["campaigns"]) == 1 and len(j["triggers"]) == 1,
        )

        # test an invalid value for dependencies
        self.assertGet(
            endpoint_url + f"?flow={flow1.uuid}&dependencies=xx",
            [self.editor],
            errors={None: "dependencies must be one of none, flows, all"},
        )

        # test that flows are migrated
        self.import_file("test_flows/favorites_v13.json")

        flow = Flow.objects.get(name="Favorites")
        self.assertGet(
            endpoint_url + f"?flow={flow.uuid}",
            [self.editor],
            raw=lambda j: len(j["flows"]) == 1 and j["flows"][0]["spec_version"] == Flow.CURRENT_SPEC_VERSION,
        )

        # test fetching docs anonymously
        self.client.logout()
        response = self.client.get(reverse("api.v2.definitions"))
        self.assertContains(response, "Deprecated endpoint")
