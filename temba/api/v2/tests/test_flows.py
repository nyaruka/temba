from django.urls import reverse
from django.utils import timezone

from temba.api.v2.serializers import format_datetime
from temba.flows.models import FlowLabel, FlowRun
from temba.tests import matchers
from temba.utils.uuid import uuid7

from . import APITest


class FlowsEndpointTest(APITest):
    def test_endpoint(self):
        endpoint_url = reverse("api.v2.flows") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        survey = self.get_flow("media_survey")
        color = self.get_flow("color")
        archived = self.get_flow("favorites")
        archived.archive(self.admin, interrupt_sessions=False)

        # add a flow label
        reporting = FlowLabel.create(self.org, self.admin, "Reporting")
        color.labels.add(reporting)

        # make it look like joe completed the color flow
        joe = self.create_contact("Joe Blow", phone="+250788123123")
        FlowRun.objects.create(
            org=self.org,
            flow=color,
            contact=joe,
            session_uuid=uuid7(),
            status=FlowRun.STATUS_COMPLETED,
            exited_on=timezone.now(),
        )
        color.tallies.create(scope=f"status:{FlowRun.STATUS_COMPLETED}", count=1)

        # flow belong to other org
        other_org = self.create_flow("Other", org=self.org2)

        # no filtering
        self.assertGet(
            endpoint_url,
            [self.editor, self.admin],
            results=[
                {
                    "uuid": str(archived.uuid),
                    "name": "Favorites",
                    "type": "message",
                    "archived": True,
                    "labels": [],
                    "expires": 720,
                    "runs": {"active": 0, "waiting": 0, "completed": 0, "interrupted": 0, "expired": 0, "failed": 0},
                    "results": [
                        {
                            "key": "color",
                            "name": "Color",
                            "categories": ["Red", "Green", "Blue", "Cyan", "Other"],
                            "node_uuids": [matchers.UUIDString(version=4)],
                        },
                        {
                            "key": "beer",
                            "name": "Beer",
                            "categories": ["Mutzig", "Primus", "Turbo King", "Skol", "Other"],
                            "node_uuids": [matchers.UUIDString(version=4)],
                        },
                        {
                            "key": "name",
                            "name": "Name",
                            "categories": ["All Responses"],
                            "node_uuids": [matchers.UUIDString(version=4)],
                        },
                    ],
                    "parent_refs": [],
                    "created_on": format_datetime(archived.created_on),
                    "modified_on": format_datetime(archived.modified_on),
                },
                {
                    "uuid": str(color.uuid),
                    "name": "Colors",
                    "type": "message",
                    "archived": False,
                    "labels": [{"uuid": str(reporting.uuid), "name": "Reporting"}],
                    "expires": 720,
                    "runs": {"active": 0, "waiting": 0, "completed": 1, "interrupted": 0, "expired": 0, "failed": 0},
                    "results": [
                        {
                            "key": "color",
                            "name": "Color",
                            "categories": ["Orange", "Blue", "Other", "Nothing"],
                            "node_uuids": [matchers.UUIDString(version=4)],
                        }
                    ],
                    "parent_refs": [],
                    "created_on": format_datetime(color.created_on),
                    "modified_on": format_datetime(color.modified_on),
                },
                {
                    "uuid": str(survey.uuid),
                    "name": "Media Survey",
                    "type": "survey",
                    "archived": False,
                    "labels": [],
                    "expires": 0,
                    "runs": {"active": 0, "waiting": 0, "completed": 0, "interrupted": 0, "expired": 0, "failed": 0},
                    "results": [
                        {
                            "key": "name",
                            "name": "Name",
                            "categories": ["All Responses"],
                            "node_uuids": [matchers.UUIDString(version=4)],
                        },
                        {
                            "key": "photo",
                            "name": "Photo",
                            "categories": ["All Responses"],
                            "node_uuids": [matchers.UUIDString(version=4)],
                        },
                        {
                            "key": "location",
                            "name": "Location",
                            "categories": ["All Responses"],
                            "node_uuids": [matchers.UUIDString(version=4)],
                        },
                        {
                            "key": "video",
                            "name": "Video",
                            "categories": ["All Responses"],
                            "node_uuids": [matchers.UUIDString(version=4)],
                        },
                    ],
                    "parent_refs": [],
                    "created_on": format_datetime(survey.created_on),
                    "modified_on": format_datetime(survey.modified_on),
                },
            ],
            num_queries=self.BASE_SESSION_QUERIES + 3,
        )

        self.assertGet(endpoint_url, [self.admin2], results=[other_org])

        # filter by key
        self.assertGet(endpoint_url + f"?uuid={color.uuid}", [self.editor], results=[color])

        # filter by type
        self.assertGet(endpoint_url + "?type=message", [self.editor], results=[archived, color])
        self.assertGet(endpoint_url + "?type=survey", [self.editor], results=[survey])

        # filter by archived
        self.assertGet(endpoint_url + "?archived=1", [self.editor], results=[archived])
        self.assertGet(endpoint_url + "?archived=0", [self.editor], results=[color, survey])
        self.assertGet(endpoint_url + "?archived=false", [self.editor], results=[color, survey])

        # filter by before / after
        self.assertGet(
            endpoint_url + f"?before={format_datetime(color.modified_on)}", [self.editor], results=[color, survey]
        )
        self.assertGet(
            endpoint_url + f"?after={format_datetime(color.modified_on)}", [self.editor], results=[archived, color]
        )

        # inactive flows are never returned
        archived.is_active = False
        archived.save(update_fields=("is_active",))

        self.assertGet(endpoint_url, [self.editor], results=[color, survey])
