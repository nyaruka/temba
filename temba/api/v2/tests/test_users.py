from django.urls import reverse

from temba.api.v2.serializers import format_datetime
from temba.utils.uuid import uuid4

from . import APITest


class UsersEndpointTest(APITest):
    def test_endpoint(self):
        endpoint_url = reverse("api.v2.users") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        self.assertGet(
            endpoint_url,
            [self.agent, self.editor, self.admin],
            results=[
                {
                    "uuid": str(self.agent.uuid),
                    "name": "Agnes",
                    "email": "agent@textit.com",
                    "first_name": "Agnes",
                    "last_name": "",
                    "role": "agent",
                    "team": {"uuid": str(self.org.default_team.uuid), "name": "All Topics"},
                    "created_on": format_datetime(self.agent.date_joined),
                    "avatar": None,
                },
                {
                    "uuid": str(self.editor.uuid),
                    "name": "Ed McEdits",
                    "email": "editor@textit.com",
                    "first_name": "Ed",
                    "last_name": "McEdits",
                    "role": "editor",
                    "team": None,
                    "created_on": format_datetime(self.editor.date_joined),
                    "avatar": None,
                },
                {
                    "uuid": str(self.admin.uuid),
                    "name": "Andy",
                    "email": "admin@textit.com",
                    "first_name": "Andy",
                    "last_name": "",
                    "role": "administrator",
                    "team": None,
                    "created_on": format_datetime(self.admin.date_joined),
                    "avatar": None,
                },
            ],
            # one query per user for their settings
            num_queries=self.BASE_SESSION_QUERIES + 2,
        )

        # filter by UUID
        self.assertGet(
            f"{endpoint_url}?uuid={self.editor.uuid}&uuid={self.admin.uuid}",
            [self.agent],
            results=[self.editor, self.admin],
            num_queries=self.BASE_SESSION_QUERIES + 2,
        )

        self.assertGet(
            endpoint_url + "?uuid=xyz", [self.editor], errors={None: "Param 'uuid': xyz is not a valid UUID."}
        )
        self.assertGet(
            endpoint_url + "?" + "&".join([f"uuid={uuid4()}" for i in range(101)]),
            [self.editor],
            errors={None: "Param 'uuid' can have a maximum of 100 values."},
        )

        # filter by email
        self.assertGet(
            f"{endpoint_url}?email=agent@textit.com&email=EDITOR@textit.com",
            [self.agent],
            results=[self.agent, self.editor],
            num_queries=self.BASE_SESSION_QUERIES + 2,
        )

        # filter by roles
        self.assertGet(endpoint_url + "?role=agent&role=editor", [self.editor], results=[self.agent, self.editor])

        # non-existent roles ignored
        self.assertGet(endpoint_url + "?role=caretaker&role=editor", [self.editor], results=[self.editor])
