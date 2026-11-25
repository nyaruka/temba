from datetime import date, timedelta
from unittest.mock import patch

from django.urls import reverse
from django.utils import timezone

from temba.orgs.models import Export, OrgRole
from temba.tests import CRUDLTestMixin, TembaTest, matchers, mock_mailroom
from temba.tickets.models import Team, Ticket, TicketExport, Topic
from temba.utils.dates import datetime_to_timestamp
from temba.utils.uuid import uuid4


class TicketCRUDLTest(TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        self.contact = self.create_contact("Bob", urns=["twitter:bobby"])
        self.sales = Topic.create(self.org, self.admin, "Sales")
        self.support = Topic.create(self.org, self.admin, "Support")

        # create other agent users in teams with limited topic access
        self.agent2 = self.create_user("agent2@textit.com")
        self.sales_only = Team.create(self.org, self.admin, "Sales", topics=[self.sales])
        self.org.add_user(self.agent2, OrgRole.AGENT, team=self.sales_only)

        self.agent3 = self.create_user("agent3@textit.com")
        self.support_only = Team.create(self.org, self.admin, "Support", topics=[self.support])
        self.org.add_user(self.agent3, OrgRole.AGENT, team=self.support_only)

    def test_list(self):
        list_url = reverse("tickets.ticket_list")

        ticket = self.create_ticket(self.contact, assignee=self.admin, topic=self.support)

        # just a placeholder view for frontend components
        self.assertRequestDisallowed(list_url, [None])
        self.assertListFetch(
            list_url, [self.editor, self.admin, self.agent, self.agent2, self.agent3], context_objects=[]
        )

        # link to our ticket within the All folder
        deep_link = f"{list_url}all/open/{ticket.uuid}/"

        response = self.assertListFetch(
            deep_link, [self.editor, self.admin, self.agent, self.agent3], context_objects=[]
        )
        self.assertEqual("All", response.context["title"])
        self.assertEqual("all", response.context["folder"])
        self.assertEqual("open", response.context["status"])

        # our ticket exists on the first page, so it'll get flagged to be focused
        self.assertEqual(str(ticket.uuid), response.context["nextUUID"])

        # we have a specific ticket so we should show context menu for it
        self.assertContentMenu(deep_link, self.admin, ["Add Note", "Start Flow"])

        with self.assertNumQueries(10):
            self.client.get(deep_link)

        # try same request but for agent that can't see this ticket
        response = self.assertListFetch(deep_link, [self.agent2], context_objects=[])
        self.assertEqual("All", response.context["title"])
        self.assertEqual("all", response.context["folder"])
        self.assertEqual("open", response.context["status"])
        self.assertNotIn("nextUUID", response.context)

        # can also link to our ticket within the Support topic
        deep_link = f"{list_url}{self.support.uuid}/open/{ticket.uuid}/"

        self.assertRequestDisallowed(deep_link, [self.agent2])  # doesn't have access to that topic

        response = self.assertListFetch(
            deep_link, [self.editor, self.admin, self.agent, self.agent3], context_objects=[]
        )
        self.assertEqual("Support", response.context["title"])
        self.assertEqual(str(self.support.uuid), response.context["folder"])
        self.assertEqual("open", response.context["status"])

        # try to link to our ticket but with mismatched topic
        deep_link = f"{list_url}{self.sales.uuid}/closed/{str(ticket.uuid)}/"

        # redirected to All
        response = self.assertListFetch(deep_link, [self.agent], context_objects=[])
        self.assertEqual("all", response.context["folder"])
        self.assertEqual("open", response.context["status"])
        self.assertEqual(str(ticket.uuid), response.context["uuid"])

        # try to link to our ticket but with mismatched status
        deep_link = f"{list_url}all/closed/{ticket.uuid}/"

        # now our ticket is listed as the uuid and we were redirected to All folder with Open status
        response = self.assertListFetch(deep_link, [self.agent], context_objects=[])
        self.assertEqual("all", response.context["folder"])
        self.assertEqual("open", response.context["status"])
        self.assertEqual(str(ticket.uuid), response.context["uuid"])

        # and again we have a specific ticket so we should show context menu for it
        self.assertContentMenu(deep_link, self.admin, ["Add Note", "Start Flow"])

        # deep link with assignee filter on all folder passes assignee_uuid to context
        assignee_link = f"{list_url}all/open/?assignee={self.admin.uuid}"
        response = self.assertListFetch(assignee_link, [self.agent], context_objects=[])
        self.assertEqual("all", response.context["folder"])
        self.assertEqual(str(self.admin.uuid), response.context["assignee_uuid"])

        # assignee filter is not passed on non-all folders
        response = self.assertListFetch(
            f"{list_url}mine/open/?assignee={self.admin.uuid}", [self.admin], context_objects=[]
        )
        self.assertNotIn("assignee_uuid", response.context)

        # non-existent topic should give a 404
        bad_topic_link = f"{list_url}{uuid4()}/open/{ticket.uuid}/"
        response = self.requestView(bad_topic_link, self.agent)
        self.assertEqual(404, response.status_code)

        response = self.client.get(
            list_url,
            content_type="application/json",
            HTTP_X_TEMBA_REFERER_PATH=f"/tickets/mine/open/{ticket.uuid}",
        )
        self.assertEqual(("tickets", "mine", "open", str(ticket.uuid)), response.context["temba_referer"])

        # contacts in a flow don't get a start flow option
        flow = self.create_flow("Test")
        self.contact.current_flow = flow
        self.contact.save()
        deep_link = f"{list_url}all/open/{str(ticket.uuid)}/"
        self.assertContentMenu(deep_link, self.admin, ["Add Note"])

        # closed our tickets don't get extra menu options
        ticket.status = Ticket.STATUS_CLOSED
        ticket.save(update_fields=("status",))
        deep_link = f"{list_url}all/closed/{str(ticket.uuid)}/"
        self.assertContentMenu(deep_link, self.admin, [])

    def test_update(self):
        ticket = self.create_ticket(self.contact, assignee=self.admin)

        update_url = reverse("tickets.ticket_update", args=[ticket.uuid])

        self.assertRequestDisallowed(update_url, [None, self.admin2])
        self.assertUpdateFetch(update_url, [self.agent, self.editor, self.admin], form_fields=["topic"])

        user_topic = Topic.objects.create(org=self.org, name="Hot Topic", created_by=self.admin, modified_by=self.admin)

        # edit successfully
        self.assertUpdateSubmit(update_url, self.admin, {"topic": user_topic.id}, success_status=302)

        ticket.refresh_from_db()
        self.assertEqual(user_topic, ticket.topic)

    def test_analytics(self):
        analytics_url = reverse("tickets.ticket_analytics")

        self.assertRequestDisallowed(analytics_url, [None, self.agent])

        # should be able to fetch analytics
        response = self.assertReadFetch(analytics_url, [self.editor, self.admin])
        self.assertEqual(200, response.status_code)
        self.assertContains(response, "Analytics")
        self.assertContains(response, "Tickets Opened")

        # should not be able to post to it
        response = self.client.post(analytics_url)
        self.assertEqual(405, response.status_code)

    def test_menu(self):
        menu_url = reverse("tickets.ticket_menu")

        self.create_ticket(self.contact, assignee=self.admin)
        self.create_ticket(self.contact, assignee=self.admin, topic=self.sales)
        self.create_ticket(self.contact, assignee=None)
        self.create_ticket(self.contact, closed_on=timezone.now())

        self.assertRequestDisallowed(menu_url, [None])
        self.assertPageMenu(
            menu_url,
            self.admin,
            [
                "My Tickets (2)",
                "Unassigned (1)",
                "All (3)",
                "Shortcuts (0)",
                "Analytics",
                "Export",
                "New Topic",
                "General (2)",
                "Sales (1)",
                "Support (0)",
            ],
        )
        self.assertPageMenu(
            menu_url,
            self.agent,
            ["My Tickets (0)", "Unassigned (1)", "All (3)", "General (2)", "Sales (1)", "Support (0)"],
        )
        self.assertPageMenu(menu_url, self.agent2, ["My Tickets (0)", "Unassigned (0)", "All (1)", "Sales (1)"])
        self.assertPageMenu(menu_url, self.agent3, ["My Tickets (0)", "Unassigned (0)", "All (0)", "Support (0)"])

    @mock_mailroom
    def test_folder(self, mr_mocks):
        self.login(self.admin)

        contact1 = self.create_contact("Joe", phone="123", last_seen_on=timezone.now())
        contact2 = self.create_contact("Frank", phone="124", last_seen_on=timezone.now())
        contact3 = self.create_contact("Anne", phone="125", last_seen_on=timezone.now())
        self.create_contact("Mary No tickets", phone="126", last_seen_on=timezone.now())
        self.create_contact("Mr Other Org", phone="126", last_seen_on=timezone.now(), org=self.org2)

        all_open_url = reverse("tickets.ticket_folder", kwargs={"folder": "all", "status": "open"})
        all_closed_url = reverse("tickets.ticket_folder", kwargs={"folder": "all", "status": "closed"})
        mine_open_url = reverse("tickets.ticket_folder", kwargs={"folder": "mine", "status": "open"})
        unassigned_open_url = reverse("tickets.ticket_folder", kwargs={"folder": "unassigned", "status": "open"})
        general_open_url = reverse(
            "tickets.ticket_folder", kwargs={"folder": self.org.default_topic.uuid, "status": "open"}
        )
        sales_open_url = reverse("tickets.ticket_folder", kwargs={"folder": self.sales.uuid, "status": "open"})
        sales_closed_url = reverse("tickets.ticket_folder", kwargs={"folder": self.sales.uuid, "status": "closed"})
        bad_topic_url = reverse("tickets.ticket_folder", kwargs={"folder": uuid4(), "status": "open"})

        def assert_tickets(url: str, user, *, expected: list | int, choose_org=None):
            response = self.requestView(url, user, choose_org=choose_org)

            if isinstance(expected, int):
                self.assertEqual(expected, response.status_code)
            else:
                actual_tickets = [t["ticket"]["uuid"] for t in response.json()["results"]]
                self.assertEqual([str(t.uuid) for t in expected], actual_tickets)

            return response

        # system topic has no menu options
        self.assertContentMenu(general_open_url, self.admin, [])

        # user topic gets edit too
        self.assertContentMenu(sales_open_url, self.admin, ["Edit", "Delete"])

        # no tickets yet so no contacts returned
        assert_tickets(all_open_url, self.admin, expected=[])
        assert_tickets(all_open_url, self.editor, expected=[])
        assert_tickets(all_open_url, self.agent, expected=[])
        assert_tickets(all_open_url, self.agent2, expected=[])
        assert_tickets(all_open_url, self.agent3, expected=[])
        assert_tickets(all_open_url, self.customer_support, expected=[], choose_org=self.org)

        # contact 1 has two open tickets and some messages
        c1_t1 = self.create_ticket(contact1, topic=self.org.default_topic, assignee=self.admin)
        c1_t2 = self.create_ticket(contact1, topic=self.sales, assignee=self.agent3)  # doesn't have access to sales

        self.create_incoming_msg(contact1, "I have an issue")
        self.create_outgoing_msg(contact1, "We can help", created_by=self.admin)

        # contact 2 has an open ticket and a closed ticket
        c2_t1 = self.create_ticket(contact2)
        c2_t2 = self.create_ticket(contact2, closed_on=timezone.now())

        self.create_incoming_msg(contact2, "Anyone there?")
        self.create_incoming_msg(contact2, "Hello?")

        # contact 3 has two closed tickets
        c3_t1 = self.create_ticket(contact3, closed_on=timezone.now(), topic=self.sales)
        c3_t2 = self.create_ticket(contact3, closed_on=timezone.now())

        self.create_outgoing_msg(contact3, "Yes", created_by=self.agent)

        # fetching open folder returns all open tickets
        self.login(self.admin)
        with self.assertNumQueries(11):
            response = self.client.get(all_open_url)

        assert_tickets(all_open_url, self.admin, expected=[c2_t1, c1_t2, c1_t1])
        assert_tickets(all_open_url, self.editor, expected=[c2_t1, c1_t2, c1_t1])
        assert_tickets(all_open_url, self.agent, expected=[c2_t1, c1_t2, c1_t1])
        assert_tickets(all_open_url, self.agent2, expected=[c1_t2])  # only sales topic
        assert_tickets(all_open_url, self.agent3, expected=[])
        assert_tickets(all_open_url, self.customer_support, expected=[c2_t1, c1_t2, c1_t1], choose_org=self.org)

        self.assertEqual(
            {
                "results": [
                    {
                        "uuid": str(contact2.uuid),
                        "name": "Frank",
                        "last_seen_on": matchers.ISODatetime(),
                        "last_msg": {
                            "text": "Hello?",
                            "direction": "I",
                            "type": "T",
                            "created_on": matchers.ISODatetime(),
                            "sender": None,
                            "attachments": [],
                        },
                        "ticket": {
                            "uuid": str(c2_t1.uuid),
                            "assignee": None,
                            "topic": {"uuid": matchers.UUIDString(version=4), "name": "General"},
                            "last_activity_on": matchers.ISODatetime(),
                            "closed_on": None,
                        },
                    },
                    {
                        "uuid": str(contact1.uuid),
                        "name": "Joe",
                        "last_seen_on": matchers.ISODatetime(),
                        "last_msg": {
                            "text": "We can help",
                            "direction": "O",
                            "type": "T",
                            "created_on": matchers.ISODatetime(),
                            "sender": {"id": self.admin.id, "email": "admin@textit.com"},
                            "attachments": [],
                        },
                        "ticket": {
                            "uuid": str(c1_t2.uuid),
                            "assignee": {
                                "id": self.agent3.id,
                                "first_name": "",
                                "last_name": "",
                                "email": "agent3@textit.com",
                                "uuid": str(self.agent3.uuid),
                            },
                            "topic": {"uuid": matchers.UUIDString(version=4), "name": "Sales"},
                            "last_activity_on": matchers.ISODatetime(),
                            "closed_on": None,
                        },
                    },
                    {
                        "uuid": str(contact1.uuid),
                        "name": "Joe",
                        "last_seen_on": matchers.ISODatetime(),
                        "last_msg": {
                            "text": "We can help",
                            "direction": "O",
                            "type": "T",
                            "created_on": matchers.ISODatetime(),
                            "sender": {"id": self.admin.id, "email": "admin@textit.com"},
                            "attachments": [],
                        },
                        "ticket": {
                            "uuid": str(c1_t1.uuid),
                            "assignee": {
                                "id": self.admin.id,
                                "first_name": "Andy",
                                "last_name": "",
                                "email": "admin@textit.com",
                                "uuid": str(self.admin.uuid),
                            },
                            "topic": {"uuid": matchers.UUIDString(version=4), "name": "General"},
                            "last_activity_on": matchers.ISODatetime(),
                            "closed_on": None,
                        },
                    },
                ]
            },
            response.json(),
        )

        # test before and after windowing
        response = self.client.get(f"{all_open_url}?before={datetime_to_timestamp(c2_t1.last_activity_on)}")
        self.assertEqual(2, len(response.json()["results"]))

        response = self.client.get(f"{all_open_url}?after={datetime_to_timestamp(c1_t2.last_activity_on)}")
        self.assertEqual(1, len(response.json()["results"]))

        # test filtering by assignee on the all folder
        assert_tickets(f"{all_open_url}?assignee={self.admin.uuid}", self.admin, expected=[c1_t1])
        assert_tickets(f"{all_open_url}?assignee={self.agent3.uuid}", self.admin, expected=[c1_t2])
        assert_tickets(f"{all_open_url}?assignee={self.agent.uuid}", self.admin, expected=[])

        # assignee filter is ignored on non-all folders
        assert_tickets(f"{mine_open_url}?assignee={self.agent3.uuid}", self.admin, expected=[c1_t1])
        assert_tickets(f"{unassigned_open_url}?assignee={self.admin.uuid}", self.admin, expected=[c2_t1])

        # assignee filter still respects topic access restrictions
        # agent2 only has access to sales topic, so filtering by admin (who has a General ticket) returns nothing
        assert_tickets(f"{all_open_url}?assignee={self.admin.uuid}", self.agent2, expected=[])
        # but filtering by agent3 (who has a Sales ticket) returns that ticket
        assert_tickets(f"{all_open_url}?assignee={self.agent3.uuid}", self.agent2, expected=[c1_t2])

        # invalid assignee UUID returns all tickets
        assert_tickets(f"{all_open_url}?assignee={uuid4()}", self.admin, expected=[c2_t1, c1_t2, c1_t1])

        # test assignee filter with pagination (paginate_by=25, so we need 25+ tickets)
        bulk_tickets = []
        for i in range(24):
            bulk_tickets.append(self.create_ticket(contact3, assignee=self.admin))
        # now we have 25 admin-assigned tickets total (c1_t1 + 24 new ones), which triggers pagination re-query
        response = self.requestView(f"{all_open_url}?assignee={self.admin.uuid}", self.admin)
        actual = [t["ticket"]["uuid"] for t in response.json()["results"]]
        self.assertEqual(25, len(actual))
        for bt in bulk_tickets:
            bt.delete()

        # unassigned tickets
        assert_tickets(unassigned_open_url, self.admin, expected=[c2_t1])
        assert_tickets(unassigned_open_url, self.editor, expected=[c2_t1])
        assert_tickets(unassigned_open_url, self.agent, expected=[c2_t1])
        assert_tickets(unassigned_open_url, self.agent2, expected=[])
        assert_tickets(unassigned_open_url, self.agent3, expected=[])
        assert_tickets(unassigned_open_url, self.customer_support, expected=[c2_t1], choose_org=self.org)

        # assigned tickets
        assert_tickets(mine_open_url, self.admin, expected=[c1_t1])
        assert_tickets(mine_open_url, self.editor, expected=[])
        assert_tickets(mine_open_url, self.agent, expected=[])
        assert_tickets(mine_open_url, self.agent2, expected=[])
        assert_tickets(mine_open_url, self.agent3, expected=[c1_t2])  # because they're assigned to it
        assert_tickets(mine_open_url, self.customer_support, expected=[], choose_org=self.org)  # always empty for CS

        # try topic specific folders
        assert_tickets(general_open_url, self.admin, expected=[c2_t1, c1_t1])
        assert_tickets(general_open_url, self.editor, expected=[c2_t1, c1_t1])
        assert_tickets(general_open_url, self.agent, expected=[c2_t1, c1_t1])
        assert_tickets(general_open_url, self.agent2, expected=404)
        assert_tickets(general_open_url, self.agent3, expected=404)

        assert_tickets(sales_open_url, self.admin, expected=[c1_t2])
        assert_tickets(sales_open_url, self.editor, expected=[c1_t2])
        assert_tickets(sales_open_url, self.agent, expected=[c1_t2])
        assert_tickets(sales_open_url, self.agent2, expected=[c1_t2])
        assert_tickets(sales_open_url, self.agent3, expected=404)  # no access to sales topic

        assert_tickets(sales_closed_url, self.admin, expected=[c3_t1])
        assert_tickets(sales_closed_url, self.editor, expected=[c3_t1])
        assert_tickets(sales_closed_url, self.agent, expected=[c3_t1])
        assert_tickets(sales_closed_url, self.agent2, expected=[c3_t1])
        assert_tickets(sales_closed_url, self.agent3, expected=404)

        # bad topic should be a 404
        assert_tickets(bad_topic_url, self.admin, expected=404)
        assert_tickets(bad_topic_url, self.agent, expected=404)
        assert_tickets(bad_topic_url, self.agent2, expected=404)
        assert_tickets(bad_topic_url, self.agent3, expected=404)

        # fetching closed folder returns all closed tickets
        response = assert_tickets(all_closed_url, self.admin, expected=[c3_t2, c3_t1, c2_t2])
        self.assertEqual(
            {
                "uuid": str(contact3.uuid),
                "name": "Anne",
                "last_seen_on": matchers.ISODatetime(),
                "last_msg": {
                    "text": "Yes",
                    "direction": "O",
                    "type": "T",
                    "created_on": matchers.ISODatetime(),
                    "sender": {"id": self.agent.id, "email": "agent@textit.com"},
                    "attachments": [],
                },
                "ticket": {
                    "uuid": str(c3_t2.uuid),
                    "assignee": None,
                    "topic": {"uuid": matchers.UUIDString(version=4), "name": "General"},
                    "last_activity_on": matchers.ISODatetime(),
                    "closed_on": matchers.ISODatetime(),
                },
            },
            response.json()["results"][0],
        )

        # deep linking to a single ticket returns just that ticket
        assert_tickets(f"{all_open_url}{str(c1_t1.uuid)}", self.admin, expected=[c1_t1])
        assert_tickets(f"{all_open_url}{str(c1_t1.uuid)}", self.editor, expected=[c1_t1])
        assert_tickets(f"{all_open_url}{str(c1_t1.uuid)}", self.agent, expected=[c1_t1])
        assert_tickets(f"{all_open_url}{str(c1_t1.uuid)}", self.agent2, expected=[])
        assert_tickets(f"{all_open_url}{str(c1_t1.uuid)}", self.agent3, expected=[])

        assert_tickets(f"{all_open_url}{str(c1_t2.uuid)}", self.admin, expected=[c1_t2])
        assert_tickets(f"{all_open_url}{str(c1_t2.uuid)}", self.editor, expected=[c1_t2])
        assert_tickets(f"{all_open_url}{str(c1_t2.uuid)}", self.agent, expected=[c1_t2])
        assert_tickets(f"{all_open_url}{str(c1_t2.uuid)}", self.agent2, expected=[c1_t2])
        assert_tickets(f"{all_open_url}{str(c1_t2.uuid)}", self.agent3, expected=[])  # can't access via All

        assert_tickets(f"{mine_open_url}{str(c1_t2.uuid)}", self.admin, expected=[])
        assert_tickets(f"{mine_open_url}{str(c1_t2.uuid)}", self.agent3, expected=[c1_t2])  # can access via Mine

        # make sure when paging we get a next url
        with patch("temba.tickets.views.TicketCRUDL.Folder.paginate_by", 1):
            response = self.requestView(all_open_url + "?_format=json", self.admin)
            self.assertIsNotNone(response.json()["next"])

    @mock_mailroom
    def test_note(self, mr_mocks):
        ticket = self.create_ticket(self.contact)

        update_url = reverse("tickets.ticket_note", args=[ticket.uuid])

        self.assertRequestDisallowed(update_url, [None, self.admin2])
        self.assertUpdateFetch(update_url, [self.agent, self.editor, self.admin], form_fields=["note"])

        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"note": ""},
            form_errors={"note": "This field is required."},
            object_unchanged=ticket,
        )

        self.assertUpdateSubmit(
            update_url, self.admin, {"note": "I have a bad feeling about this."}, success_status=200
        )

    def test_opened_chart(self):
        opened_url = reverse("tickets.ticket_chart", args=["opened"])

        cats = Topic.create(self.org, self.admin, "Cats")
        dogs = Topic.create(self.org, self.admin, "Dogs")

        self.login(self.admin)

        response = self.client.get(opened_url + "?since=2024-03-01&until=2024-05-01")
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {
                "period": ["2024-03-01", "2024-05-01"],
                "data": {"datasets": [], "labels": []},
            },
            response.json(),
        )

        self.org.daily_counts.create(day=date(2024, 4, 25), scope="tickets:opened:0", count=1)
        self.org.daily_counts.create(day=date(2024, 4, 25), scope=f"tickets:opened:{cats.id}", count=3)
        self.org.daily_counts.create(day=date(2024, 4, 25), scope=f"tickets:opened:{dogs.id}", count=2)
        self.org.daily_counts.create(day=date(2024, 4, 26), scope=f"tickets:opened:{cats.id}", count=5)
        self.org.daily_counts.create(day=date(2024, 4, 26), scope=f"tickets:opened:{dogs.id}", count=4)
        self.org.daily_counts.create(day=date(2024, 5, 3), scope="tickets:opened:0", count=2)  # out of period

        response = self.client.get(opened_url + "?since=2024-03-01&until=2024-05-01")
        self.assertEqual(
            {
                "period": ["2024-03-01", "2024-05-01"],
                "data": {
                    "labels": ["2024-04-25", "2024-04-26"],
                    "datasets": [
                        {"label": "<Unknown>", "data": [1, 0]},
                        {"label": "Cats", "data": [3, 5]},
                        {"label": "Dogs", "data": [2, 4]},
                    ],
                },
            },
            response.json(),
        )

        # if date param not given or invalid, period defaults to last 90 days
        response = self.client.get(opened_url + "?since=xyz")
        self.assertEqual(
            {
                "period": [matchers.ISODate(), matchers.ISODate()],
                "data": {"datasets": [], "labels": []},
            },
            response.json(),
        )

    def test_resptime_chart(self):
        opened_url = reverse("tickets.ticket_chart", args=["resptime"])

        self.login(self.admin)

        response = self.client.get(opened_url + "?since=2024-03-01&until=2024-05-01")
        self.assertEqual(200, response.status_code)

        self.assertEqual(
            {
                "period": ["2024-03-01", "2024-05-01"],
                "data": {"labels": [], "datasets": [{"label": "Response Time", "data": []}]},
            },
            response.json(),
        )

        self.org.daily_counts.create(day=date(2024, 4, 25), scope="ticketresptime:total", count=1000)
        self.org.daily_counts.create(day=date(2024, 4, 25), scope="ticketresptime:count", count=5)
        self.org.daily_counts.create(day=date(2024, 4, 26), scope="ticketresptime:total", count=500)
        self.org.daily_counts.create(day=date(2024, 4, 26), scope="ticketresptime:count", count=2)
        self.org.daily_counts.create(day=date(2024, 5, 3), scope="ticketresptime:total", count=100)  # out of period
        self.org.daily_counts.create(day=date(2024, 5, 3), scope="ticketresptime:count", count=3)

        response = self.client.get(opened_url + "?since=2024-03-01&until=2024-05-01")
        self.assertEqual(
            {
                "period": ["2024-03-01", "2024-05-01"],
                "data": {
                    "labels": ["2024-04-25", "2024-04-26"],
                    "datasets": [{"label": "Response Time", "data": [200, 250]}],
                },
            },
            response.json(),
        )

    def test_replies_chart(self):
        replies_url = reverse("tickets.ticket_chart", args=["replies"])

        self.login(self.admin)

        response = self.client.get(replies_url + "?since=2024-03-01&until=2024-05-01")
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {
                "period": ["2024-03-01", "2024-05-01"],
                "data": {"datasets": [], "labels": []},
            },
            response.json(),
        )

        # Create some test data - msgs:ticketreplies:{team_id}:{user_id}
        self.org.daily_counts.create(day=date(2024, 4, 25), scope="msgs:ticketreplies:0:1", count=2)  # No Team
        self.org.daily_counts.create(
            day=date(2024, 4, 25), scope=f"msgs:ticketreplies:{self.sales_only.id}:2", count=3
        )  # Sales team
        self.org.daily_counts.create(
            day=date(2024, 4, 25), scope=f"msgs:ticketreplies:{self.support_only.id}:3", count=1
        )  # Support team
        self.org.daily_counts.create(
            day=date(2024, 4, 26), scope=f"msgs:ticketreplies:{self.sales_only.id}:2", count=5
        )  # Sales team next day
        self.org.daily_counts.create(
            day=date(2024, 4, 26), scope=f"msgs:ticketreplies:{self.sales_only.id}:4", count=2
        )  # Sales team, different user
        self.org.daily_counts.create(day=date(2024, 5, 3), scope="msgs:ticketreplies:0:1", count=1)  # out of period

        response = self.client.get(replies_url + "?since=2024-03-01&until=2024-05-01")
        self.assertEqual(
            {
                "period": ["2024-03-01", "2024-05-01"],
                "data": {
                    "labels": ["2024-04-25", "2024-04-26"],
                    "datasets": [
                        {"label": "No Team", "data": [2, 0]},
                        {"label": "Sales", "data": [3, 7]},  # 5 + 2 from different users
                        {"label": "Support", "data": [1, 0]},
                    ],
                },
            },
            response.json(),
        )

    def test_leaderboard(self):
        leaderboard_url = reverse("tickets.ticket_leaderboard")

        self.assertRequestDisallowed(leaderboard_url, [None, self.agent])

        self.login(self.admin)

        response = self.client.get(leaderboard_url + "?since=2024-03-01&until=2024-05-01")
        self.assertEqual(200, response.status_code)
        self.assertEqual({"results": []}, response.json())

        # create reply counts - scope format: msgs:ticketreplies:{team_id}:{user_id}
        self.org.daily_counts.create(day=date(2024, 4, 25), scope=f"msgs:ticketreplies:0:{self.admin.id}", count=5)
        self.org.daily_counts.create(day=date(2024, 4, 26), scope=f"msgs:ticketreplies:0:{self.admin.id}", count=3)
        self.org.daily_counts.create(
            day=date(2024, 4, 25), scope=f"msgs:ticketreplies:{self.sales_only.id}:{self.agent2.id}", count=10
        )
        self.org.daily_counts.create(day=date(2024, 4, 25), scope=f"msgs:ticketreplies:0:{self.editor.id}", count=2)
        self.org.daily_counts.create(
            day=date(2024, 5, 3), scope=f"msgs:ticketreplies:0:{self.admin.id}", count=100
        )  # out of period

        response = self.client.get(leaderboard_url + "?since=2024-03-01&until=2024-05-01")
        data = response.json()

        self.assertEqual(3, len(data["results"]))
        # ordered by reply count descending
        self.assertEqual("agent2@textit.com", data["results"][0]["name"])
        self.assertEqual(str(self.agent2.uuid), data["results"][0]["uuid"])
        self.assertEqual(10, data["results"][0]["replies"])

        self.assertEqual(str(self.admin), data["results"][1]["name"])
        self.assertEqual(str(self.admin.uuid), data["results"][1]["uuid"])
        self.assertEqual(8, data["results"][1]["replies"])

        self.assertEqual(str(self.editor), data["results"][2]["name"])
        self.assertEqual(str(self.editor.uuid), data["results"][2]["uuid"])
        self.assertEqual(2, data["results"][2]["replies"])

    def test_analytics_export(self):
        export_url = reverse("tickets.ticket_analytics_export")

        self.login(self.admin)

        response = self.client.get(export_url)
        self.assertEqual(200, response.status_code)
        self.assertEqual("application/ms-excel", response["Content-Type"])
        self.assertEqual(
            f"attachment; filename=ticket-stats-{timezone.now().strftime('%Y-%m-%d')}.xlsx",
            response["Content-Disposition"],
        )

    @mock_mailroom
    def test_export(self, mr_mocks):
        export_url = reverse("tickets.ticket_export")

        self.assertRequestDisallowed(export_url, [None, self.agent])
        response = self.assertUpdateFetch(
            export_url,
            [self.editor, self.admin],
            form_fields=("start_date", "end_date", "with_fields", "with_groups"),
        )
        self.assertNotContains(response, "already an export in progress")

        # create a dummy export task so that we won't be able to export
        blocking_export = TicketExport.create(
            self.org, self.admin, start_date=date.today() - timedelta(days=7), end_date=date.today()
        )

        response = self.client.get(export_url)
        self.assertContains(response, "already an export in progress")

        # check we can't submit in case a user opens the form and whilst another user is starting an export
        response = self.client.post(export_url, {"start_date": "2022-06-28", "end_date": "2022-09-28"})
        self.assertContains(response, "already an export in progress")
        self.assertEqual(1, Export.objects.count())

        # mark that one as finished so it's no longer a blocker
        blocking_export.status = Export.STATUS_COMPLETE
        blocking_export.save(update_fields=("status",))

        # try to submit with no values
        response = self.client.post(export_url, {})
        self.assertFormError(response.context["form"], "start_date", "This field is required.")
        self.assertFormError(response.context["form"], "end_date", "This field is required.")

        # try to submit with start date in future
        response = self.client.post(export_url, {"start_date": "2200-01-01", "end_date": "2022-09-28"})
        self.assertFormError(response.context["form"], None, "Start date can't be in the future.")

        # try to submit with start date > end date
        response = self.client.post(export_url, {"start_date": "2022-09-01", "end_date": "2022-03-01"})
        self.assertFormError(response.context["form"], None, "End date can't be before start date.")

        # try to submit with too many fields or groups
        too_many_fields = [self.create_field(f"Field {i}", f"field{i}") for i in range(11)]
        too_many_groups = [self.create_group(f"Group {i}", contacts=[]) for i in range(11)]

        response = self.client.post(
            export_url,
            {
                "start_date": "2022-06-28",
                "end_date": "2022-09-28",
                "with_fields": [cf.id for cf in too_many_fields],
                "with_groups": [cg.id for cg in too_many_groups],
            },
        )
        self.assertFormError(response.context["form"], "with_fields", "You can only include up to 10 fields.")
        self.assertFormError(response.context["form"], "with_groups", "You can only include up to 10 groups.")

        testers = self.create_group("Testers", contacts=[])
        gender = self.create_field("gender", "Gender")

        response = self.client.post(
            export_url,
            {
                "start_date": "2022-06-28",
                "end_date": "2022-09-28",
                "with_groups": [testers.id],
                "with_fields": [gender.id],
            },
        )
        self.assertEqual(200, response.status_code)

        export = Export.objects.exclude(id=blocking_export.id).get()
        self.assertEqual("ticket", export.export_type)
        self.assertEqual(date(2022, 6, 28), export.start_date)
        self.assertEqual(date(2022, 9, 28), export.end_date)
        self.assertEqual(
            {"with_groups": [testers.id], "with_fields": [gender.id]},
            export.config,
        )
