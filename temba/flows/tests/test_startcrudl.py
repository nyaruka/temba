from django.urls import reverse

from temba.flows.models import FlowStart, FlowStartCount
from temba.mailroom.client.types import Exclusions
from temba.tests import CRUDLTestMixin, TembaTest, mock_mailroom


class FlowStartCRUDLTest(TembaTest, CRUDLTestMixin):
    @mock_mailroom
    def test_list(self, mr_mocks):
        list_url = reverse("flows.flowstart_list")

        flow1 = self.create_flow("Test Flow 1")
        flow2 = self.create_flow("Test 2")

        contact = self.create_contact("Bob", phone="+1234567890")
        group = self.create_group("Testers", contacts=[contact])
        start1 = self.create_flowstart(flow1, self.admin, contacts=[contact])
        start2 = self.create_flowstart(
            flow1,
            self.admin,
            query="name ~ Bob",
            typ="A",
            exclude=Exclusions(started_previously=True),
            params={"first_name": "Ryan", "last_name": "Lewis"},
        )
        start3 = self.create_flowstart(
            flow2, self.admin, groups=[group], typ="Z", exclude=Exclusions(in_a_flow=True), params={"event": "signup"}
        )
        # a non-manual start without params
        start4 = self.create_flowstart(flow1, self.admin, contacts=[contact], typ="A")

        flow2.release(self.admin)

        FlowStartCount.objects.create(start=start3, count=1000)
        FlowStartCount.objects.create(start=start3, count=234)

        other_org_flow = self.create_flow("Test", org=self.org2)
        self.create_flowstart(other_org_flow, self.admin2)

        self.assertRequestDisallowed(list_url, [None, self.agent])
        response = self.assertListFetch(
            list_url, [self.editor, self.admin], context_objects=[start4, start3, start2, start1]
        )

        self.assertContains(response, "Test Flow 1")
        self.assertNotContains(response, "Test Flow 2")
        self.assertContains(response, "A deleted flow")

        # the start type is shown in its own column rather than as prose
        self.assertNotContains(response, "was started by")
        self.assertContains(response, "<td>Zapier</td>")
        self.assertContains(response, "<td>API</td>")

        # each row links to its details modal and the details aren't rendered inline
        self.assertContains(response, "showStart(event, this)")
        self.assertContains(response, reverse("flows.flowstart_read", args=[start2.uuid]))
        self.assertNotContains(response, "No recent runs")
        self.assertNotContains(response, "&quot;first_name&quot;: &quot;Ryan&quot;")

        response = self.assertListFetch(list_url + "?type=manual", [self.admin], context_objects=[start1])
        self.assertTrue(response.context["filtered"])
        self.assertEqual(response.context["url_params"], "?type=manual&")

    @mock_mailroom
    def test_read(self, mr_mocks):
        flow1 = self.create_flow("Test Flow 1")
        flow2 = self.create_flow("Test 2")

        contact = self.create_contact("Bob", phone="+1234567890")
        group = self.create_group("Testers", contacts=[contact])

        start1 = self.create_flowstart(flow1, self.admin, contacts=[contact])
        start2 = self.create_flowstart(
            flow1,
            self.admin,
            query="name ~ Bob",
            typ="A",
            exclude=Exclusions(started_previously=True),
            params={"first_name": "Ryan", "last_name": "Lewis"},
        )
        start3 = self.create_flowstart(
            flow2, self.admin, groups=[group], typ="Z", exclude=Exclusions(in_a_flow=True), params={"event": "signup"}
        )
        flow2.release(self.admin)

        read1_url = reverse("flows.flowstart_read", args=[start1.uuid])
        read2_url = reverse("flows.flowstart_read", args=[start2.uuid])
        read3_url = reverse("flows.flowstart_read", args=[start3.uuid])

        self.assertRequestDisallowed(read1_url, [None, self.agent])

        # a manual start shows who started it and its recipients
        response = self.assertReadFetch(read1_url, [self.editor, self.admin], context_object=start1)
        self.assertContains(response, "Test Flow 1")
        self.assertContains(response, "admin@textit.com")
        self.assertContains(response, "Bob")

        # an API start shows its query, exclusions and params
        response = self.assertReadFetch(read2_url, [self.admin], context_object=start2)
        self.assertContains(response, "An API call")
        self.assertContains(response, "name ~ Bob")
        self.assertContains(response, "No recent runs")
        self.assertContains(response, "&quot;first_name&quot;: &quot;Ryan&quot;")

        # a Zapier start against a deleted flow still renders its group, exclusions and params
        response = self.assertReadFetch(read3_url, [self.admin], context_object=start3)
        self.assertContains(response, "A deleted flow")
        self.assertContains(response, "Zapier")
        self.assertContains(response, "Testers")
        self.assertContains(response, "Not in a flow")
        self.assertContains(response, "&quot;event&quot;: &quot;signup&quot;")

        # a start against raw URNs (e.g. from the API) renders its URN recipients
        start4 = self.create_flowstart(flow1, self.admin, typ="A", urns=["tel:+15156686221"])
        read4_url = reverse("flows.flowstart_read", args=[start4.uuid])
        response = self.assertReadFetch(read4_url, [self.admin], context_object=start4)
        self.assertContains(response, "+1 515-668-6221")

        # starts from other orgs aren't accessible
        other_flow = self.create_flow("Other Flow", org=self.org2)
        other_start = self.create_flowstart(other_flow, self.admin2)
        self.assertRequestDisallowed(reverse("flows.flowstart_read", args=[other_start.uuid]), [self.admin])

    def test_status(self):
        flow = self.create_flow("Test Flow 1")
        start = self.create_flowstart(flow, self.admin)

        status_url = f"{reverse('flows.flowstart_status')}?id={start.id}&status=P"
        self.assertRequestDisallowed(status_url, [self.agent])
        response = self.assertReadFetch(status_url, [self.editor, self.admin])

        # status returns json
        self.assertEqual("Pending", response.json()["results"][0]["status"])

        # starts from other orgs should not be accessible even by id
        other_flow = self.create_flow("Other Flow", org=self.org2)
        other_start = self.create_flowstart(other_flow, self.admin2)

        other_status_url = f"{reverse('flows.flowstart_status')}?id={other_start.id}&status=P"
        response = self.requestView(other_status_url, self.admin)
        self.assertEqual(200, response.status_code)
        self.assertEqual([], response.json()["results"])

    def test_interrupt(self):
        flow = self.create_flow("Test Flow 1")
        start = self.create_flowstart(flow, self.admin)

        interrupt_url = reverse("flows.flowstart_interrupt", args=[start.id])
        self.assertRequestDisallowed(interrupt_url, [None, self.agent])

        self.assertUpdateFetch(interrupt_url, [self.admin, self.editor])
        self.requestView(interrupt_url, self.admin, post_data={})

        start.refresh_from_db()
        self.assertEqual(FlowStart.STATUS_INTERRUPTED, start.status)
