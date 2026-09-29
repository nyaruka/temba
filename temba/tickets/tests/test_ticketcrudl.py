from datetime import date, timedelta
from unittest.mock import call, patch

from django.urls import reverse
from django.utils import timezone

from temba.orgs.models import Export, Org, OrgRole
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

    def test_list_component(self):
        list_url = reverse("tickets.ticket_list")

        self.login(self.admin)

        # the ticket page uses the chat + card layout, sharing the contact card settings
        self.admin.settings = {"contact_cards": {"order": ["card-notepad", "card-fields"], "collapsed": []}}
        self.admin.save(update_fields=("settings",))

        response = self.client.get(list_url)
        self.assertContains(response, "temba-card-layout")
        self.assertContains(response, "temba-page-header")
        self.assertContains(response, 'id="card-details"')
        self.assertContains(response, "temba-contact-details")
        self.assertContains(response, "details.contact = contact.uuid;")
        self.assertContains(response, 'details.schemes = JSON.parse(document.getElementById("contact-urn-schemes")')
        self.assertNotContains(response, "temba-tabs")
        self.assertRegex(response.content.decode(), r"<temba-contact-details\b[^>]*\beditable(?:\s|>)")
        self.assertEqual(
            '{"order": ["card-notepad", "card-fields"], "collapsed": []}', response.context["card_settings"]
        )
        self.assertIn({"value": "tel", "name": "Phone Number"}, response.context["contact_urn_schemes"])

        # human agents can see contact details on tickets but can't edit them
        self.login(self.agent)
        response = self.client.get(list_url)
        self.assertContains(response, 'id="card-details"')
        self.assertContains(response, "temba-contact-details")
        self.assertContains(response, 'role="T"')
        self.assertNotRegex(response.content.decode(), r"<temba-contact-details\b[^>]*\beditable(?:\s|>)")

        # the cross-ticket search modal is only mounted for users who can access all topics
        self.assertTrue(response.context["can_search"])
        self.assertContains(response, "<temba-ticket-search")

        self.login(self.agent2, choose_org=self.org)
        response = self.client.get(list_url)
        self.assertFalse(response.context["can_search"])
        self.assertNotContains(response, "<temba-ticket-search")

    def test_list(self):
        list_url = reverse("tickets.ticket_list")

        ticket = self.create_ticket(self.contact, assignee=self.admin, topic=self.support)

        # just a placeholder view for frontend components
        self.assertRequestDisallowed(list_url, [None])
        self.assertListFetch(list_url, [self.editor, self.admin, self.agent, self.agent2, self.agent3])

        # link to our ticket within the All folder
        deep_link = f"{list_url}all/{ticket.uuid}/"

        response = self.assertListFetch(deep_link, [self.editor, self.admin, self.agent, self.agent3])
        self.assertEqual("All", response.context["title"])
        self.assertEqual("all", response.context["folder"])

        # our ticket exists on the first page, so it'll get flagged to be focused
        self.assertEqual(str(ticket.uuid), response.context["nextUUID"])

        # we have a specific ticket so we should show context menu for it
        self.assertContentMenu(deep_link, self.admin, ["Add Note", "Start Flow"])

        with self.assertNumQueries(10):
            self.client.get(deep_link)

        # try same request but for agent that can't see this ticket
        response = self.assertListFetch(deep_link, [self.agent2])
        self.assertEqual("All", response.context["title"])
        self.assertEqual("all", response.context["folder"])
        self.assertNotIn("nextUUID", response.context)

        # can also link to our ticket within the Support topic
        deep_link = f"{list_url}{self.support.uuid}/{ticket.uuid}/"

        self.assertRequestDisallowed(deep_link, [self.agent2])  # doesn't have access to that topic

        response = self.assertListFetch(deep_link, [self.editor, self.admin, self.agent, self.agent3])
        self.assertEqual("Support", response.context["title"])
        self.assertEqual(str(self.support.uuid), response.context["folder"])

        # try to link to our ticket but with mismatched topic - redirected to All
        deep_link = f"{list_url}{self.sales.uuid}/{str(ticket.uuid)}/"

        response = self.assertListFetch(deep_link, [self.agent])
        self.assertEqual("all", response.context["folder"])
        self.assertEqual(str(ticket.uuid), response.context["uuid"])

        # and again we have a specific ticket so we should show context menu for it
        self.assertContentMenu(deep_link, self.admin, ["Add Note", "Start Flow"])

        # deep link with assignee filter on all folder passes assignee_uuid to context
        assignee_link = f"{list_url}all/?assignee={self.admin.uuid}"
        response = self.assertListFetch(assignee_link, [self.agent])
        self.assertEqual("all", response.context["folder"])
        self.assertEqual(str(self.admin.uuid), response.context["assignee_uuid"])

        # assignee filter is not passed on non-all folders
        response = self.assertListFetch(f"{list_url}mine/?assignee={self.admin.uuid}", [self.admin])
        self.assertNotIn("assignee_uuid", response.context)

        # a malformed assignee is ignored, same as on the folder endpoint
        response = self.assertListFetch(f"{list_url}all/?assignee=notauuid", [self.admin])
        self.assertNotIn("assignee_uuid", response.context)

        # a deep link to a valid but unknown uuid stays in the requested folder
        response = self.assertListFetch(f"{list_url}unassigned/{uuid4()}/", [self.admin])
        self.assertEqual("Unassigned", response.context["title"])
        self.assertEqual("unassigned", response.context["folder"])
        self.assertNotIn("uuid", response.context)
        self.assertNotIn("nextUUID", response.context)

        # non-existent topic should give a 404
        bad_topic_link = f"{list_url}{uuid4()}/{ticket.uuid}/"
        response = self.requestView(bad_topic_link, self.agent)
        self.assertEqual(404, response.status_code)

        response = self.client.get(
            list_url,
            content_type="application/json",
            HTTP_X_TEMBA_REFERER_PATH=f"/tickets/mine/{ticket.uuid}",
        )
        self.assertEqual(("tickets", "mine", str(ticket.uuid)), response.context["temba_referer"])

        # contacts in a flow still get a start flow option - the start modal handles confirming
        # the interruption
        flow = self.create_flow("Test")
        self.contact.current_flow = flow
        self.contact.save()
        deep_link = f"{list_url}all/{str(ticket.uuid)}/"
        self.assertContentMenu(deep_link, self.admin, ["Add Note", "Start Flow"])

        # closed tickets don't get extra menu options
        ticket.status = Ticket.STATUS_CLOSED
        ticket.save(update_fields=("status",))
        self.assertContentMenu(deep_link, self.admin, [])

    def test_list_legacy_status_redirect(self):
        ticket = self.create_ticket(self.contact, assignee=self.admin)

        self.login(self.admin)

        # links with an open/closed status segment redirect to the folder, keeping the ticket and query string
        response = self.client.get(f"/ticket/mine/open/{ticket.uuid}/?tab=0")
        self.assertEqual(301, response.status_code)
        self.assertEqual(f"/ticket/mine/{ticket.uuid}/?tab=0", response.url)

        response = self.client.get(f"/ticket/{self.support.uuid}/closed/")
        self.assertEqual(301, response.status_code)
        self.assertEqual(f"/ticket/{self.support.uuid}/", response.url)

        # and the redirected link resolves as normal
        response = self.client.get(f"/ticket/mine/open/{ticket.uuid}/", follow=True)
        self.assertEqual("mine", response.context["folder"])
        self.assertEqual(str(ticket.uuid), response.context["nextUUID"])

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

        self.assertRequestDisallowed(analytics_url, [None])

        # should be able to fetch analytics
        response = self.assertReadFetch(analytics_url, [self.editor, self.admin])
        self.assertEqual(200, response.status_code)
        self.assertContains(response, "Analytics")
        self.assertContains(response, "Tickets Opened")
        self.assertContains(response, "Response Time")
        self.assertContains(response, "/ticket/all/?assignee=")
        self.assertIsNone(response.context["team"])
        self.assertContentMenu(analytics_url, self.admin, ["Export Raw"])

        # the search button is part of the tickets section menu so search has to be mounted here too
        self.assertContains(response, "<temba-ticket-search")

        # org doesn't have the teams feature so response count chart shouldn't be split by team
        self.assertFalse(response.context["has_teams"])
        self.assertNotContains(response, 'dataname="Teams"')

        # agents see analytics scoped to their team, so no response time chart (not tracked per team), no raw export
        # and no links from the leaderboard to other agents' tickets
        response = self.assertReadFetch(analytics_url, [self.agent])
        self.assertEqual(self.org.default_team, response.context["team"])
        self.assertContains(response, "Tickets Opened")
        self.assertNotContains(response, "Response Time")
        self.assertNotContains(response, "/ticket/all/?assignee=")
        self.assertContentMenu(analytics_url, self.agent, [])

        self.org.features = [Org.FEATURE_TEAMS]
        self.org.save(update_fields=("features",))

        response = self.assertReadFetch(analytics_url, [self.admin])
        self.assertTrue(response.context["has_teams"])
        self.assertContains(response, 'dataname="Teams"')

        # agents only see their own team so response count chart is never split by team
        response = self.assertReadFetch(analytics_url, [self.agent2])
        self.assertEqual(self.sales_only, response.context["team"])
        self.assertFalse(response.context["has_teams"])
        self.assertNotContains(response, 'dataname="Teams"')

        # should not be able to post to it
        response = self.client.post(analytics_url)
        self.assertEqual(405, response.status_code)

    def test_menu(self):
        menu_url = reverse("tickets.ticket_menu")

        self.create_ticket(self.contact, assignee=self.admin)
        self.create_ticket(self.contact, assignee=self.admin, topic=self.sales)
        self.create_ticket(self.contact, assignee=None)
        self.create_ticket(self.contact, closed_on=timezone.now())

        # agent3 is assigned a ticket in a topic their team doesn't have access to
        self.create_ticket(self.contact, assignee=self.agent3, topic=self.sales)

        self.assertRequestDisallowed(menu_url, [None])
        self.assertPageMenu(
            menu_url,
            self.admin,
            [
                "My Tickets (2)",
                "Unassigned (1)",
                "All (4)",
                "Shortcuts (0)",
                "Analytics",
                "Search",
                "Export",
                "New Topic",
                ("Topics", ["General (2)", "Sales (2)", "Support (0)"]),
            ],
        )
        # orgs with the agents feature access shortcuts and knowledge from the Knowledge section instead
        self.org.features.append(Org.FEATURE_AGENTS)
        self.org.save(update_fields=("features",))
        self.assertPageMenu(
            menu_url,
            self.admin,
            [
                "My Tickets (2)",
                "Unassigned (1)",
                "All (4)",
                ("Topics", ["General (2)", "Sales (2)", "Support (0)"]),
                "Analytics",
                "Search",
                "Export",
                "New Topic",
            ],
        )

        # agent isn't topic restricted so gets search, but no export
        self.assertPageMenu(
            menu_url,
            self.agent,
            [
                "My Tickets (0)",
                "Unassigned (1)",
                "All (4)",
                ("Topics", ["General (2)", "Sales (2)", "Support (0)"]),
                "Analytics",
                "Search",
            ],
        )
        self.assertPageMenu(
            menu_url,
            self.agent2,
            ["My Tickets (0)", "Unassigned (0)", "All (2)", ("Topics", ["Sales (2)"]), "Analytics"],
        )

        # agent3's assigned ticket isn't counted because it's not in a topic they can access
        self.assertPageMenu(
            menu_url,
            self.agent3,
            ["My Tickets (0)", "Unassigned (0)", "All (0)", ("Topics", ["Support (0)"]), "Analytics"],
        )

    def test_folder(self):
        self.login(self.admin)

        contact1 = self.create_contact("Joe", phone="123", last_seen_on=timezone.now())
        contact2 = self.create_contact("Frank", phone="124", last_seen_on=timezone.now())
        contact3 = self.create_contact("Anne", phone="125", last_seen_on=timezone.now())
        self.create_contact("Mary No tickets", phone="126", last_seen_on=timezone.now())
        self.create_contact("Mr Other Org", phone="126", last_seen_on=timezone.now(), org=self.org2)

        # the uuid part of the pattern is optional so URLs can only be reversed by folder
        all_url = reverse("tickets.ticket_folder", kwargs={"folder": "all"})
        mine_url = reverse("tickets.ticket_folder", kwargs={"folder": "mine"})
        unassigned_url = "/ticket/folder/unassigned/"
        general_url = f"/ticket/folder/{self.org.default_topic.uuid}/"
        sales_url = f"/ticket/folder/{self.sales.uuid}/"
        bad_topic_url = f"/ticket/folder/{uuid4()}/"

        def assert_tickets(url: str, user, *, expected: list | int, choose_org=None):
            response = self.requestView(url, user, choose_org=choose_org)

            if isinstance(expected, int):
                self.assertEqual(expected, response.status_code)
            else:
                actual_tickets = [t["ticket"]["uuid"] for t in response.json()["results"]]
                self.assertEqual([str(t.uuid) for t in expected], actual_tickets)

            return response

        # system topic has no menu options
        self.assertContentMenu(general_url, self.admin, [])

        # user topic gets edit too
        self.assertContentMenu(sales_url, self.admin, ["Edit", "Delete"])

        # no tickets yet so no contacts returned
        assert_tickets(all_url, self.admin, expected=[])
        assert_tickets(all_url, self.editor, expected=[])
        assert_tickets(all_url, self.agent, expected=[])
        assert_tickets(all_url, self.agent2, expected=[])
        assert_tickets(all_url, self.agent3, expected=[])
        assert_tickets(all_url, self.customer_support, expected=[], choose_org=self.org)

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

        # tickets created back to back can land in the same millisecond, and the timestamp cursors below only have
        # millisecond resolution, so space out activity to keep paging deterministic
        base = timezone.now().replace(microsecond=0) - timedelta(minutes=1)
        for i, ticket in enumerate([c1_t1, c1_t2, c2_t1, c2_t2, c3_t1, c3_t2]):
            Ticket.objects.filter(id=ticket.id).update(last_activity_on=base + timedelta(seconds=i))
            ticket.last_activity_on = base + timedelta(seconds=i)

        # a folder returns open tickets followed by closed tickets
        self.login(self.admin)
        with self.assertNumQueries(11):
            response = self.client.get(all_url)

        assert_tickets(all_url, self.admin, expected=[c2_t1, c1_t2, c1_t1, c3_t2, c3_t1, c2_t2])
        assert_tickets(all_url, self.editor, expected=[c2_t1, c1_t2, c1_t1, c3_t2, c3_t1, c2_t2])
        assert_tickets(all_url, self.agent, expected=[c2_t1, c1_t2, c1_t1, c3_t2, c3_t1, c2_t2])
        assert_tickets(all_url, self.agent2, expected=[c1_t2, c3_t1])  # only sales topic
        assert_tickets(all_url, self.agent3, expected=[])
        assert_tickets(
            all_url,
            self.customer_support,
            expected=[c2_t1, c1_t2, c1_t1, c3_t2, c3_t1, c2_t2],
            choose_org=self.org,
        )

        self.assertEqual(
            [
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
            ],
            response.json()["results"][:3],
        )

        # the newest closed ticket carries its closed_on
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
            response.json()["results"][3],
        )

        # fetching new activity returns both open and closed tickets (oldest first)
        response = self.client.get(f"{all_url}?after={datetime_to_timestamp(c2_t2.last_activity_on)}")
        self.assertEqual([str(c3_t1.uuid), str(c3_t2.uuid)], [t["ticket"]["uuid"] for t in response.json()["results"]])

        # refreshes are never paged, so even a full page of new activity doesn't get a next link
        with patch("temba.tickets.views.TicketCRUDL.Folder.paginate_by", 1):
            response = self.client.get(f"{all_url}?after={datetime_to_timestamp(c2_t2.last_activity_on)}")
            self.assertEqual([str(c3_t1.uuid)], [t["ticket"]["uuid"] for t in response.json()["results"]])
            self.assertNotIn("next", response.json())

        # test filtering by assignee on the all folder
        assert_tickets(f"{all_url}?assignee={self.admin.uuid}", self.admin, expected=[c1_t1])
        assert_tickets(f"{all_url}?assignee={self.agent3.uuid}", self.admin, expected=[c1_t2])
        assert_tickets(f"{all_url}?assignee={self.agent.uuid}", self.admin, expected=[])

        # assignee filter is ignored on non-all folders
        assert_tickets(f"{mine_url}?assignee={self.agent3.uuid}", self.admin, expected=[c1_t1])

        # assignee filter still respects topic access restrictions
        # agent2 only has access to sales topic, so filtering by admin (who has a General ticket) returns nothing
        assert_tickets(f"{all_url}?assignee={self.admin.uuid}", self.agent2, expected=[])
        # but filtering by agent3 (who has a Sales ticket) returns that ticket
        assert_tickets(f"{all_url}?assignee={self.agent3.uuid}", self.agent2, expected=[c1_t2])

        # invalid assignee UUID returns all tickets
        assert_tickets(f"{all_url}?assignee={uuid4()}", self.admin, expected=[c2_t1, c1_t2, c1_t1, c3_t2, c3_t1, c2_t2])

        # test assignee filter with pagination (paginate_by=25, so we need 25+ tickets)
        bulk_tickets = []
        for i in range(24):
            bulk_tickets.append(self.create_ticket(contact3, assignee=self.admin))
        # now we have 25 admin-assigned tickets total (c1_t1 + 24 new ones) which fills a page, so we get a next
        # link and it has to carry the assignee filter
        response = self.requestView(f"{all_url}?assignee={self.admin.uuid}", self.admin)
        actual = [t["ticket"]["uuid"] for t in response.json()["results"]]
        self.assertEqual(25, len(actual))
        self.assertIn(f"assignee={self.admin.uuid}", response.json()["next"])
        for bt in bulk_tickets:
            bt.delete()

        # unassigned tickets
        assert_tickets(unassigned_url, self.admin, expected=[c2_t1, c3_t2, c3_t1, c2_t2])
        assert_tickets(unassigned_url, self.agent2, expected=[c3_t1])
        assert_tickets(unassigned_url, self.agent3, expected=[])

        # assigned tickets
        assert_tickets(mine_url, self.admin, expected=[c1_t1])
        assert_tickets(mine_url, self.editor, expected=[])
        assert_tickets(mine_url, self.agent, expected=[])
        assert_tickets(mine_url, self.agent2, expected=[])
        assert_tickets(mine_url, self.agent3, expected=[])  # assigned to them but no access to sales topic
        assert_tickets(mine_url, self.customer_support, expected=[], choose_org=self.org)  # always empty for CS

        # try topic specific folders
        assert_tickets(general_url, self.admin, expected=[c2_t1, c1_t1, c3_t2, c2_t2])
        assert_tickets(general_url, self.agent2, expected=404)
        assert_tickets(general_url, self.agent3, expected=404)

        assert_tickets(sales_url, self.admin, expected=[c1_t2, c3_t1])
        assert_tickets(sales_url, self.agent2, expected=[c1_t2, c3_t1])
        assert_tickets(sales_url, self.agent3, expected=404)  # no access to sales topic

        # bad topic should be a 404
        assert_tickets(bad_topic_url, self.admin, expected=404)
        assert_tickets(bad_topic_url, self.agent, expected=404)
        assert_tickets(bad_topic_url, self.agent2, expected=404)
        assert_tickets(bad_topic_url, self.agent3, expected=404)

        # deep linking to a single ticket returns just that ticket
        assert_tickets(f"{all_url}{str(c1_t1.uuid)}", self.admin, expected=[c1_t1])
        assert_tickets(f"{all_url}{str(c1_t1.uuid)}", self.editor, expected=[c1_t1])
        assert_tickets(f"{all_url}{str(c1_t1.uuid)}", self.agent, expected=[c1_t1])
        assert_tickets(f"{all_url}{str(c1_t1.uuid)}", self.agent2, expected=[])
        assert_tickets(f"{all_url}{str(c1_t1.uuid)}", self.agent3, expected=[])

        assert_tickets(f"{all_url}{str(c1_t2.uuid)}", self.admin, expected=[c1_t2])
        assert_tickets(f"{all_url}{str(c1_t2.uuid)}", self.agent2, expected=[c1_t2])
        assert_tickets(f"{all_url}{str(c1_t2.uuid)}", self.agent3, expected=[])  # no access to sales topic

        assert_tickets(f"{mine_url}{str(c1_t2.uuid)}", self.admin, expected=[])
        assert_tickets(f"{mine_url}{str(c1_t2.uuid)}", self.agent3, expected=[])  # nor via Mine tho assigned

        # deep links work for closed tickets too
        assert_tickets(f"{all_url}{str(c2_t2.uuid)}", self.admin, expected=[c2_t2])

        # paging serves open pages first, crossing into closed tickets when open runs short
        with patch("temba.tickets.views.TicketCRUDL.Folder.paginate_by", 2):
            response = self.requestView(all_url, self.admin)
            self.assertEqual(
                [str(c2_t1.uuid), str(c1_t2.uuid)], [t["ticket"]["uuid"] for t in response.json()["results"]]
            )
            self.assertEqual(
                f"{all_url}?before={datetime_to_timestamp(c1_t2.last_activity_on)}&before_id={c1_t2.id}"
                f"&before_status=O",
                response.json()["next"],
            )

            # second page is the last open ticket plus the newest closed ticket
            response = self.requestView(response.json()["next"], self.admin)
            self.assertEqual(
                [str(c1_t1.uuid), str(c3_t2.uuid)], [t["ticket"]["uuid"] for t in response.json()["results"]]
            )
            self.assertEqual(
                f"{all_url}?before={datetime_to_timestamp(c3_t2.last_activity_on)}&before_id={c3_t2.id}"
                f"&before_status=C",
                response.json()["next"],
            )

            # subsequent pages continue within the closed tickets
            response = self.requestView(response.json()["next"], self.admin)
            self.assertEqual(
                [str(c3_t1.uuid), str(c2_t2.uuid)], [t["ticket"]["uuid"] for t in response.json()["results"]]
            )

            response = self.requestView(response.json()["next"], self.admin)
            self.assertEqual([], response.json()["results"])
            self.assertNotIn("next", response.json())

    def test_folder_refresh_bounding(self):
        contact = self.create_contact("Joe", phone="123")
        base = timezone.now().replace(microsecond=0)

        # 8 tickets in distinct milliseconds
        spread = [self.create_ticket(contact) for _ in range(8)]
        for i, ticket in enumerate(spread):
            Ticket.objects.filter(id=ticket.id).update(last_activity_on=base + timedelta(milliseconds=i))

        after = datetime_to_timestamp(base - timedelta(seconds=1))

        with patch("temba.tickets.views.TicketCRUDL.Folder.paginate_by", 5):
            # a full refresh page is capped, extended to a whole millisecond
            response = self.requestView(f"/ticket/folder/all/?after={after}", self.admin)
            self.assertEqual(
                [str(t.uuid) for t in spread[:5]], [t["ticket"]["uuid"] for t in response.json()["results"]]
            )

            # a bulk update can put more than a page of tickets inside a single millisecond - the cap must
            # yield so the client's millisecond resolution cursor can still advance
            tied = [self.create_ticket(contact) for _ in range(8)]
            for i, ticket in enumerate(tied):
                Ticket.objects.filter(id=ticket.id).update(
                    last_activity_on=base + timedelta(seconds=1, microseconds=i + 1)
                )

            after = datetime_to_timestamp(base + timedelta(seconds=1))
            response = self.requestView(f"/ticket/folder/all/?after={after}", self.admin)
            self.assertEqual([str(t.uuid) for t in tied], [t["ticket"]["uuid"] for t in response.json()["results"]])

    def test_folder_merged_page_ties(self):
        contact = self.create_contact("Joe", phone="123")
        open1 = self.create_ticket(contact)
        closed1 = self.create_ticket(contact, closed_on=timezone.now())
        closed2 = self.create_ticket(contact, closed_on=timezone.now())
        closed3 = self.create_ticket(contact, closed_on=timezone.now())

        # two newest closed tickets share the same last activity timestamp
        tied = timezone.now()
        Ticket.objects.filter(id__in=[closed2.id, closed3.id]).update(last_activity_on=tied)

        with patch("temba.tickets.views.TicketCRUDL.Folder.paginate_by", 2):
            # the cursor includes the ticket id so tickets sharing the timestamp we page from aren't lost
            response = self.requestView("/ticket/folder/all/", self.admin)
            self.assertEqual(
                [str(open1.uuid), str(closed3.uuid)],
                [t["ticket"]["uuid"] for t in response.json()["results"]],
            )

            response = self.requestView(response.json()["next"], self.admin)
            self.assertEqual(
                [str(closed2.uuid), str(closed1.uuid)],
                [t["ticket"]["uuid"] for t in response.json()["results"]],
            )

            response = self.requestView(response.json()["next"], self.admin)
            self.assertEqual([], response.json()["results"])
            self.assertNotIn("next", response.json())

    def test_folder_cursor_without_status(self):
        contact = self.create_contact("Joe", phone="123")
        open1 = self.create_ticket(contact)
        open2 = self.create_ticket(contact)
        closed1 = self.create_ticket(contact, closed_on=timezone.now())

        base = timezone.now().replace(microsecond=0) - timedelta(minutes=1)
        for i, ticket in enumerate([open1, open2, closed1]):
            Ticket.objects.filter(id=ticket.id).update(last_activity_on=base + timedelta(seconds=i))
            ticket.last_activity_on = base + timedelta(seconds=i)

        all_url = reverse("tickets.ticket_folder", kwargs={"folder": "all"})
        cursor = f"before={datetime_to_timestamp(open2.last_activity_on)}&before_id={open2.id}"

        # a link from before cursors carried the status - or one with a junk status - is assumed to be in the open
        # tickets, which is where paging always starts
        for params in (cursor, f"{cursor}&before_status=X"):
            response = self.requestView(f"{all_url}?{params}", self.admin)
            self.assertEqual(
                [str(open1.uuid), str(closed1.uuid)], [t["ticket"]["uuid"] for t in response.json()["results"]]
            )

    def test_folder_invalid_params(self):
        contact = self.create_contact("Joe", phone="123")
        ticket1 = self.create_ticket(contact)
        ticket2 = self.create_ticket(contact, assignee=self.admin)

        all_url = reverse("tickets.ticket_folder", kwargs={"folder": "all"})

        # a malformed ticket uuid in the path is treated as not found rather than blowing up
        response = self.requestView(f"{all_url}notauuid", self.admin)
        self.assertEqual(200, response.status_code)
        self.assertEqual([], response.json()["results"])

        # a malformed assignee is ignored, same as an unknown one
        response = self.requestView(f"{all_url}?assignee=notauuid", self.admin)
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            [str(ticket2.uuid), str(ticket1.uuid)], [t["ticket"]["uuid"] for t in response.json()["results"]]
        )

        # non-numeric cursor params are ignored so we just get the first page
        response = self.requestView(f"{all_url}?after=NaN&before=x&before_id=y", self.admin)
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            [str(ticket2.uuid), str(ticket1.uuid)], [t["ticket"]["uuid"] for t in response.json()["results"]]
        )

        # as are numeric cursor params too big (or small) to be a timestamp
        response = self.requestView(f"{all_url}?after=100000000000000000000", self.admin)
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            [str(ticket2.uuid), str(ticket1.uuid)], [t["ticket"]["uuid"] for t in response.json()["results"]]
        )

        response = self.requestView(f"{all_url}?before=-100000000000000000000&before_id={ticket1.id}", self.admin)
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            [str(ticket2.uuid), str(ticket1.uuid)], [t["ticket"]["uuid"] for t in response.json()["results"]]
        )

        # and a malformed ticket uuid in a list view deep link doesn't blow up either
        response = self.requestView(f"{reverse('tickets.ticket_list')}all/notauuid/", self.admin)
        self.assertEqual(200, response.status_code)
        self.assertNotIn("uuid", response.context)
        self.assertNotIn("nextUUID", response.context)

    @mock_mailroom
    def test_search(self, mr_mocks):
        contact1 = self.create_contact("Joe", phone="123")
        contact2 = self.create_contact("Frank", phone="124")

        ticket1 = self.create_ticket(contact1)
        ticket2 = self.create_ticket(contact2, topic=self.sales, closed_on=timezone.now())

        search_url = reverse("tickets.ticket_search")

        # search isn't available to agents in topic-restricted teams
        self.assertRequestDisallowed(search_url, [None, self.agent2])

        self.login(self.admin)

        # empty or missing text returns empty results without hitting mailroom
        response = self.client.get(search_url + "?text=")
        self.assertEqual(200, response.status_code)
        self.assertEqual({"results": []}, response.json())

        response = self.client.get(search_url)
        self.assertEqual(200, response.status_code)
        self.assertEqual({"results": []}, response.json())

        event1 = {
            "uuid": "019a9935-022e-7bb3-9d6f-03d773be623e",
            "type": "msg_received",
            "msg": {"text": "I need help"},
            "created_on": "2025-11-17T16:00:00+00:00",
            "ticket_uuid": str(ticket1.uuid),
        }
        event2 = {
            "uuid": "019a9935-022e-7bb3-9d6f-03d773be624e",
            "type": "msg_created",
            "msg": {"text": "Happy to help"},
            "created_on": "2025-11-17T16:01:00+00:00",
            "ticket_uuid": str(ticket2.uuid),
        }
        event3 = {
            "uuid": "019a9935-022e-7bb3-9d6f-03d773be625e",
            "type": "msg_received",
            "msg": {"text": "help but no ticket"},
            "created_on": "2025-11-17T16:02:00+00:00",
        }

        # results without a resolvable ticket are dropped
        mr_mocks.msg_search([(contact1, event1), (contact2, event2), (contact1, event3)])

        response = self.client.get(search_url + "?text=help")
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {
                "results": [
                    {
                        "contact": {"uuid": str(contact1.uuid), "name": "Joe"},
                        "ticket": {"uuid": str(ticket1.uuid), "status": "open"},
                        "event": event1,
                    },
                    {
                        "contact": {"uuid": str(contact2.uuid), "name": "Frank"},
                        "ticket": {"uuid": str(ticket2.uuid), "status": "closed"},
                        "event": event2,
                    },
                ],
            },
            response.json(),
        )
        self.assertEqual([call(self.org, "help", in_ticket=True)], mr_mocks.calls["msg_search"])

        # tickets in another org, and malformed uuids, are also dropped
        other_org_contact = self.create_contact("Jim", phone="125", org=self.org2)
        other_org_ticket = self.create_ticket(other_org_contact)

        event4 = {
            "uuid": "019a9935-022e-7bb3-9d6f-03d773be626e",
            "type": "msg_received",
            "msg": {"text": "help in another org"},
            "created_on": "2025-11-17T16:03:00+00:00",
            "ticket_uuid": str(other_org_ticket.uuid),
        }
        event5 = {
            "uuid": "019a9935-022e-7bb3-9d6f-03d773be627e",
            "type": "msg_received",
            "msg": {"text": "help with a junk ticket uuid"},
            "created_on": "2025-11-17T16:04:00+00:00",
            "ticket_uuid": "not-a-uuid",
        }

        mr_mocks.msg_search([(contact1, event4), (contact1, event5)])

        response = self.client.get(search_url + "?text=help")
        self.assertEqual(200, response.status_code)
        self.assertEqual({"results": []}, response.json())

    def test_note(self):
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

        # agent on a team with all topics sees the same as admins
        self.login(self.agent)

        response = self.client.get(opened_url + "?since=2024-03-01&until=2024-05-01")
        self.assertEqual(
            [
                {"label": "<Unknown>", "data": [1, 0]},
                {"label": "Cats", "data": [3, 5]},
                {"label": "Dogs", "data": [2, 4]},
            ],
            response.json()["data"]["datasets"],
        )

        # agent on a topic-limited team only sees openings in their team's topics
        self.sales_only.topics.add(cats)
        self.login(self.agent2)

        response = self.client.get(opened_url + "?since=2024-03-01&until=2024-05-01")
        self.assertEqual(
            {
                "period": ["2024-03-01", "2024-05-01"],
                "data": {"labels": ["2024-04-25", "2024-04-26"], "datasets": [{"label": "Cats", "data": [3, 5]}]},
            },
            response.json(),
        )

    def test_resptime_chart(self):
        opened_url = reverse("tickets.ticket_chart", args=["resptime"])

        # response times aren't tracked per team so agents can't fetch them
        self.assertRequestDisallowed(opened_url, [None, self.agent])

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

        # agents only see replies from their own team
        self.login(self.agent2)

        response = self.client.get(replies_url + "?since=2024-03-01&until=2024-05-01")
        self.assertEqual(
            {
                "period": ["2024-03-01", "2024-05-01"],
                "data": {"labels": ["2024-04-25", "2024-04-26"], "datasets": [{"label": "Sales", "data": [3, 7]}]},
            },
            response.json(),
        )

        # including no replies at all
        self.login(self.agent)

        response = self.client.get(replies_url + "?since=2024-03-01&until=2024-05-01")
        self.assertEqual(
            {
                "period": ["2024-03-01", "2024-05-01"],
                "data": {"labels": [], "datasets": [{"label": "All Topics", "data": []}]},
            },
            response.json(),
        )

    def test_leaderboard(self):
        leaderboard_url = reverse("tickets.ticket_leaderboard")

        self.assertRequestDisallowed(leaderboard_url, [None])

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

        # agents only see responders from their own team
        self.login(self.agent2)

        response = self.client.get(leaderboard_url + "?since=2024-03-01&until=2024-05-01")
        self.assertEqual(
            {"results": [{"name": "agent2@textit.com", "uuid": str(self.agent2.uuid), "replies": 10}]},
            response.json(),
        )

        self.login(self.agent)

        response = self.client.get(leaderboard_url + "?since=2024-03-01&until=2024-05-01")
        self.assertEqual({"results": []}, response.json())

    def test_analytics_export(self):
        export_url = reverse("tickets.ticket_analytics_export")

        # raw stats are workspace-wide so agents can't export them
        self.assertRequestDisallowed(export_url, [None, self.agent])

        self.login(self.editor)

        response = self.client.get(export_url)
        self.assertEqual(200, response.status_code)

        self.login(self.admin)

        response = self.client.get(export_url)
        self.assertEqual(200, response.status_code)
        self.assertEqual("application/ms-excel", response["Content-Type"])
        self.assertEqual(
            f"attachment; filename=ticket-stats-{timezone.now().strftime('%Y-%m-%d')}.xlsx",
            response["Content-Disposition"],
        )

    def test_export(self):
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
