import iso8601

from django.urls import reverse

from temba.api.v2.serializers import format_datetime
from temba.contacts.models import Contact
from temba.flows.models import FlowRun
from temba.tests.engine import MockSessionWriter

from . import APITest


class RunsEndpointTest(APITest):
    def test_readonly_routing(self):
        # custom Prefetch querysets should be routed to the same database as the instances they're prefetched for
        # (regressed in Django 6.1) as otherwise prefetched relations are read from a different database than their
        # instances
        run = FlowRun()
        run._state.db = "readonly"

        queryset = FlowRun.contact.get_prefetch_querysets([run], [Contact.objects.only("uuid", "name")])[0]

        self.assertEqual("readonly", queryset.db)

    def test_endpoint(self):
        endpoint_url = reverse("api.v2.runs") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        flow1 = self.get_flow("color")
        flow2 = flow1.clone(self.editor)

        flow1_nodes = flow1.get_definition()["nodes"]
        color_prompt = flow1_nodes[0]
        color_split = flow1_nodes[4]
        blue_reply = flow1_nodes[2]

        joe = self.create_contact("Joe Blow", phone="+250788123123")
        frank = self.create_contact("Frank", urns=["tel:123456"])
        start1 = self.create_flowstart(flow1, self.admin, contacts=[joe])
        joe_msg = self.create_incoming_msg(joe, "it is blue")
        frank_msg = self.create_incoming_msg(frank, "Indigo")

        joe_run1 = (
            MockSessionWriter(joe, flow1, start=start1)
            .visit(color_prompt)
            .visit(color_split)
            .wait()
            .resume(msg=joe_msg)
            .set_result("Color", "blue", "Blue", "it is blue")
            .visit(blue_reply)
            .complete()
            .save()
        )[0]

        frank_run1 = (
            MockSessionWriter(frank, flow1)
            .visit(color_prompt)
            .visit(color_split)
            .wait()
            .resume(msg=frank_msg)
            .set_result("Color", "Indigo", "Other", "Indigo")
            .wait()
            .save()
        )[0]

        joe_run2 = (MockSessionWriter(joe, flow1).visit(color_prompt).visit(color_split).wait().save())[0]
        frank_run2 = (MockSessionWriter(frank, flow1).visit(color_prompt).visit(color_split).wait().save())[0]

        joe_run3 = MockSessionWriter(joe, flow2).wait().save()[0]

        # add a run for another org
        flow3 = self.create_flow("Test", org=self.org2)
        hans = self.create_contact("Hans Gruber", phone="+4921551511", org=self.org2)
        MockSessionWriter(hans, flow3).wait().save()

        # refresh runs which will have been modified by being interrupted
        joe_run1.refresh_from_db()
        joe_run2.refresh_from_db()
        frank_run1.refresh_from_db()
        frank_run2.refresh_from_db()

        # no filtering
        response = self.assertGet(
            endpoint_url,
            [self.editor, self.admin],
            results=[joe_run3, joe_run2, frank_run2, frank_run1, joe_run1],
            num_queries=self.BASE_SESSION_QUERIES + 6,
        )
        resp_json = response.json()
        self.assertEqual(
            {
                "id": frank_run2.id,
                "uuid": str(frank_run2.uuid),
                "flow": {"uuid": str(flow1.uuid), "name": "Colors"},
                "contact": {
                    "uuid": str(frank.uuid),
                    "name": frank.name,
                    "urn": "tel:123456",
                    "urn_display": "123456",
                },
                "start": None,
                "responded": False,
                "path": [
                    {
                        "node": color_prompt["uuid"],
                        "time": format_datetime(frank_run2.path_times[0]),
                    },
                    {
                        "node": color_split["uuid"],
                        "time": format_datetime(frank_run2.path_times[1]),
                    },
                ],
                "values": {},
                "created_on": format_datetime(frank_run2.created_on),
                "modified_on": format_datetime(frank_run2.modified_on),
                "exited_on": None,
                "exit_type": None,
            },
            resp_json["results"][2],
        )
        self.assertEqual(
            {
                "id": joe_run1.id,
                "uuid": str(joe_run1.uuid),
                "flow": {"uuid": str(flow1.uuid), "name": "Colors"},
                "contact": {
                    "uuid": str(joe.uuid),
                    "name": joe.name,
                    "urn": "tel:+250788123123",
                    "urn_display": "0788 123 123",
                },
                "start": {"uuid": str(joe_run1.start.uuid)},
                "responded": True,
                "path": [
                    {
                        "node": color_prompt["uuid"],
                        "time": format_datetime(joe_run1.path_times[0]),
                    },
                    {
                        "node": color_split["uuid"],
                        "time": format_datetime(joe_run1.path_times[1]),
                    },
                    {
                        "node": blue_reply["uuid"],
                        "time": format_datetime(joe_run1.path_times[2]),
                    },
                ],
                "values": {
                    "color": {
                        "value": "blue",
                        "category": "Blue",
                        "node": color_split["uuid"],
                        "time": format_datetime(iso8601.parse_date(joe_run1.results["color"]["created_on"])),
                        "name": "Color",
                    }
                },
                "created_on": format_datetime(joe_run1.created_on),
                "modified_on": format_datetime(joe_run1.modified_on),
                "exited_on": format_datetime(joe_run1.exited_on),
                "exit_type": "completed",
            },
            resp_json["results"][4],
        )

        # can request without path data
        response = self.assertGet(
            endpoint_url + "?paths=false", [self.editor], results=[joe_run3, joe_run2, frank_run2, frank_run1, joe_run1]
        )
        resp_json = response.json()
        self.assertEqual(
            {
                "id": frank_run2.id,
                "uuid": str(frank_run2.uuid),
                "flow": {"uuid": str(flow1.uuid), "name": "Colors"},
                "contact": {
                    "uuid": str(frank.uuid),
                    "name": frank.name,
                    "urn": "tel:123456",
                    "urn_display": "123456",
                },
                "start": None,
                "responded": False,
                "path": None,
                "values": {},
                "created_on": format_datetime(frank_run2.created_on),
                "modified_on": format_datetime(frank_run2.modified_on),
                "exited_on": None,
                "exit_type": None,
            },
            resp_json["results"][2],
        )

        # reversed
        self.assertGet(
            endpoint_url + "?reverse=true",
            [self.editor],
            results=[joe_run1, frank_run1, frank_run2, joe_run2, joe_run3],
        )

        # filter by id (deprecated, so recorded)
        self.assertGet(endpoint_url + f"?id={frank_run2.id}", [self.admin], results=[frank_run2])
        self.assertDeprecatedRecorded("runs#filter:id", 1)

        # anon orgs should not have a URN field
        with self.anonymous(self.org):
            response = self.assertGet(endpoint_url + f"?id={frank_run2.id}", [self.admin], results=[frank_run2])
            self.assertEqual(
                {
                    "id": frank_run2.pk,
                    "uuid": str(frank_run2.uuid),
                    "flow": {"uuid": str(flow1.uuid), "name": "Colors"},
                    "contact": {
                        "uuid": frank.uuid,
                        "name": frank.name,
                        "ref": frank.ref,
                        "urn": "tel:********",
                        "urn_display": None,
                        "anon_display": frank.ref,  # deprecated
                    },
                    "start": None,
                    "responded": False,
                    "path": [
                        {
                            "node": color_prompt["uuid"],
                            "time": format_datetime(frank_run2.path_times[0]),
                        },
                        {
                            "node": color_split["uuid"],
                            "time": format_datetime(frank_run2.path_times[1]),
                        },
                    ],
                    "values": {},
                    "created_on": format_datetime(frank_run2.created_on),
                    "modified_on": format_datetime(frank_run2.modified_on),
                    "exited_on": None,
                    "exit_type": None,
                },
                response.json()["results"][0],
            )

        # filter by uuid
        self.assertGet(endpoint_url + f"?uuid={frank_run2.uuid}", [self.admin], results=[frank_run2])

        # filter by id and uuid
        self.assertGet(endpoint_url + f"?uuid={frank_run2.uuid}&id={joe_run1.id}", [self.admin], results=[])
        self.assertGet(endpoint_url + f"?uuid={frank_run2.uuid}&id={frank_run2.id}", [self.admin], results=[frank_run2])

        # filter by flow
        self.assertGet(
            endpoint_url + f"?flow={flow1.uuid}", [self.admin], results=[joe_run2, frank_run2, frank_run1, joe_run1]
        )

        # doesn't work if flow is inactive
        flow1.is_active = False
        flow1.save(update_fields=("is_active",))

        self.assertGet(endpoint_url + f"?flow={flow1.uuid}", [self.admin], results=[])

        # restore to active
        flow1.is_active = True
        flow1.save(update_fields=("is_active",))

        # filter by invalid flow
        self.assertGet(
            endpoint_url + "?flow=invalid", [self.admin], errors={None: "Param 'flow': invalid is not a valid UUID."}
        )
        self.assertGet(endpoint_url + "?flow=5fb61ca5-bdb1-4a05-af8d-274127f8186f", [self.admin], results=[])

        # filter by flow + responded
        self.assertGet(
            endpoint_url + f"?flow={flow1.uuid}&responded=TrUe", [self.admin], results=[frank_run1, joe_run1]
        )

        # filter by contact (deprecated, so recorded)
        self.assertGet(endpoint_url + f"?contact={joe.uuid}", [self.admin], results=[joe_run3, joe_run2, joe_run1])
        self.assertDeprecatedRecorded("runs#filter:contact", 1)

        # filter by invalid contact
        self.assertGet(endpoint_url + "?contact=invalid", [self.admin], results=[])

        # filter by contact + responded
        self.assertGet(endpoint_url + f"?contact={joe.uuid}&responded=yes", [self.admin], results=[joe_run1])

        # filter by before / after
        self.assertGet(
            endpoint_url + f"?before={format_datetime(frank_run1.modified_on)}",
            [self.admin],
            results=[frank_run1, joe_run1],
        )
        self.assertGet(
            endpoint_url + f"?after={format_datetime(frank_run1.modified_on)}",
            [self.admin],
            results=[joe_run3, joe_run2, frank_run2, frank_run1],
        )

        # filter by invalid before / after
        self.assertGet(endpoint_url + "?before=longago", [self.admin], results=[])
        self.assertGet(endpoint_url + "?after=thefuture", [self.admin], results=[])

        # can't filter by both contact and flow together
        self.assertGet(
            endpoint_url + f"?contact={joe.uuid}&flow={flow1.uuid}",
            [self.admin],
            errors={None: "You may only specify one of the contact, flow parameters"},
        )
