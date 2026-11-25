from datetime import datetime, timedelta, timezone as tzone
from unittest.mock import call, patch
from urllib.parse import quote

import iso8601

from django.conf import settings
from django.urls import reverse
from django.utils import timezone

from temba import mailroom
from temba.campaigns.models import Campaign, CampaignEvent
from temba.contacts.models import Contact, ContactExport, ContactField
from temba.locations.models import AdminBoundary
from temba.mailroom.client.types import Exclusions
from temba.msgs.models import Media
from temba.orgs.models import Export, OrgMembership, OrgRole
from temba.schedules.models import Schedule
from temba.tests import CRUDLTestMixin, MockResponse, TembaTest, matchers, mock_mailroom
from temba.tests.engine import MockSessionWriter
from temba.tickets.models import Ticket
from temba.triggers.models import Trigger
from temba.utils import json
from temba.utils.uuid import uuid7
from temba.utils.views.mixins import TEMBA_MENU_SELECTION


class ContactCRUDLTest(CRUDLTestMixin, TembaTest):
    def setUp(self):
        super().setUp()

        self.country = AdminBoundary.create(osm_id="171496", name="Rwanda", level=0)
        AdminBoundary.create(osm_id="1708283", name="Kigali", level=1, parent=self.country)

        self.create_field("age", "Age", value_type="N", show_in_table=True)
        self.create_field("home", "Home", value_type="S", show_in_table=True, priority=10)

        # sample flows don't actually get created by org initialization during tests because there are no users at that
        # point so create them explicitly here, so that we also get the sample groups
        self.org.create_sample_flows("https://api.rapidpro.io")

    def create_campaign(self, contact):
        self.farmers = self.create_group("Farmers", [contact])
        self.reminder_flow = self.create_flow("Reminder Flow")
        self.planting_date = self.create_field("planting_date", "Planting Date", value_type=ContactField.TYPE_DATETIME)
        self.campaign = Campaign.create(self.org, self.admin, "Planting Reminders", self.farmers)

        # create af flow event
        self.planting_reminder = CampaignEvent.create_flow_event(
            self.org,
            self.admin,
            self.campaign,
            relative_to=self.planting_date,
            offset=0,
            unit="D",
            flow=self.reminder_flow,
            delivery_hour=17,
        )

        # and a message event
        self.message_event = CampaignEvent.create_message_event(
            self.org,
            self.admin,
            self.campaign,
            relative_to=self.planting_date,
            offset=7,
            unit="D",
            translations={"eng": {"text": "Sent 7 days after planting date"}},
            base_language="eng",
        )

    def test_menu(self):
        menu_url = reverse("contacts.contact_menu")

        self.assertRequestDisallowed(menu_url, [None, self.agent])
        self.assertPageMenu(
            menu_url,
            self.admin,
            [
                "Active (0)",
                "Archived (0)",
                "Blocked (0)",
                "Stopped (0)",
                "Import",
                "Fields (2)",
                ("Groups", ["Open Tickets (0)", "Survey Audience (0)", "Unsatisfied Customers (0)"]),
            ],
        )

    @mock_mailroom
    def test_create(self, mr_mocks):
        create_url = reverse("contacts.contact_create")

        self.assertRequestDisallowed(create_url, [None, self.agent])
        self.assertCreateFetch(create_url, [self.editor, self.admin], form_fields=("name", "phone"))

        # simulate validation failing because phone number taken
        mr_mocks.contact_urns({"tel:+250781111111": 12345678})

        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Joe", "phone": "+250781111111"},
            form_errors={"phone": "In use by another contact."},
        )

        # simulate validation failing because phone number isn't E164
        mr_mocks.contact_urns({"tel:+250781111111": False})

        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Joe", "phone": "+250781111111"},
            form_errors={"phone": "Ensure number includes country code."},
        )

        # simulate validation failing because phone number isn't valid
        mr_mocks.contact_urns({"tel:xx": "URN 0 invalid"})

        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Joe", "phone": "xx"},
            form_errors={"phone": "Invalid phone number."},
        )

        # try valid number
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Joe", "phone": "+250782222222"},
            new_obj_query=Contact.objects.filter(org=self.org, name="Joe", urns__identity="tel:+250782222222"),
            success_status=200,
        )

    @mock_mailroom
    def test_list(self, mr_mocks):
        list_url = reverse("contacts.contact_list")

        self.assertRequestDisallowed(list_url, [None, self.agent])

        joe = self.create_contact("Joe", phone="123", fields={"age": "20", "home": "Kigali"})
        frank = self.create_contact("Frank", phone="124", fields={"age": "18"})

        mr_mocks.contact_search('name != ""', contacts=[])
        self.create_group("No Name", query='name = ""')

        self.login(self.editor)

        with self.assertNumQueries(15):
            response = self.client.get(list_url)

        self.assertEqual([frank, joe], list(response.context["object_list"]))
        self.assertIsNone(response.context["search_error"])
        self.assertEqual(["block", "archive", "send", "start-flow"], list(response.context["actions"]))
        self.assertContentMenu(list_url, self.editor, ["New Contact", "New Group", "Export"])

        active_contacts = self.org.active_contacts_group

        # test with search query
        mr_mocks.contact_search("age = 18", contacts=[frank])

        response = self.assertListFetch(list_url + "?search=age+%3D+18", [self.editor], context_objects=[frank])
        self.assertEqual(response.context["search"], "age = 18")
        self.assertEqual(response.context["search_is_saveable"], True)
        self.assertIsNone(response.context["search_error"])
        self.assertEqual(
            [f.name for f in response.context["contact_fields"]], ["Home", "Age", "Last Seen On", "Created On"]
        )

        mr_mocks.contact_search("age = 18", contacts=[frank], total=10020)

        # we return up to 10000 contacts when searching with ES, so last page is 200
        self.assertListFetch(list_url + "?search=age+%3D+18&page=200", [self.editor], status=200)
        self.assertListFetch(list_url + "?search=age+%3D+18&page=201", [self.editor], status=404)

        mr_mocks.contact_search('age > 18 and home = "Kigali"', cleaned='age > 18 AND home = "Kigali"', contacts=[joe])

        response = self.assertListFetch(
            list_url + '?search=age+>+18+and+home+%3D+"Kigali"', [self.editor], context_objects=[joe]
        )
        self.assertEqual(response.context["search"], 'age > 18 AND home = "Kigali"')
        self.assertEqual(response.context["search_is_saveable"], True)
        self.assertIsNone(response.context["search_error"])

        mr_mocks.contact_search("Joe", cleaned='name ~ "Joe"', contacts=[joe])

        response = self.assertListFetch(list_url + "?search=Joe", [self.editor], context_objects=[joe])
        self.assertEqual(response.context["search"], 'name ~ "Joe"')
        self.assertEqual(response.context["search_is_saveable"], True)
        self.assertIsNone(response.context["search_error"])

        with self.anonymous(self.org):
            mr_mocks.contact_search(f"{joe.id}", cleaned=f"id = {joe.id}", contacts=[joe])

            response = self.client.get(list_url + f"?search={joe.id}")
            self.assertEqual(list(response.context["object_list"]), [joe])
            self.assertIsNone(response.context["search_error"])
            self.assertEqual(response.context["search"], f"id = {joe.id}")
            self.assertEqual(response.context["search_is_saveable"], False)

        # try with invalid search string
        mr_mocks.exception(mailroom.QueryValidationException("mismatched input at (((", "syntax"))

        response = self.client.get(list_url + "?search=(((")
        self.assertEqual(list(response.context["object_list"]), [])
        self.assertEqual(response.context["search_error"], "Invalid query syntax.")
        self.assertContains(response, "Invalid query syntax.")

        mr_mocks.exception(mailroom.QueryValidationException("mismatched input at (((", "syntax"))

        self.assertContentMenu(list_url + "?search=(((", self.editor, ["New Contact", "New Group"])  # no export

        # error response if query too long
        response = self.client.get(list_url + "?search=" + "x" * 10001)
        self.assertEqual(413, response.status_code)

        self.login(self.admin)

        # admins can see bulk actions
        age_query = "?search=age%20%3E%2050"
        response = self.client.get(list_url)
        self.assertEqual([frank, joe], list(response.context["object_list"]))
        self.assertEqual(["block", "archive", "send", "start-flow"], list(response.context["actions"]))

        self.assertContentMenu(
            list_url,
            self.admin,
            ["New Contact", "New Group", "Export"],
        )
        self.assertContentMenu(
            list_url + age_query,
            self.admin,
            ["Create Smart Group", "New Contact", "New Group", "Export"],
        )

        # TODO: group labeling as a feature is on probation
        # self.client.post(list_url, {"action": "label", "objects": frank.id, "label": survey_audience.id})
        # self.assertIn(frank, survey_audience.contacts.all())

        # try label bulk action against search results
        # self.client.post(list_url + "?search=Joe", {"action": "label", "objects": joe.id, "label": survey_audience.id})
        # self.assertIn(joe, survey_audience.contacts.all())

        # self.assertEqual(
        #    call(self.org.id, group_uuid=str(active_contacts.uuid), query="Joe", sort="", offset=0, exclude_ids=[]),
        #    mr_mocks.calls["contact_search"][-1],
        # )

        # try archive bulk action
        self.client.post(list_url + "?search=Joe", {"action": "archive", "objects": joe.id})

        # we re-run the search for the response, but exclude Joe
        self.assertEqual(
            call(self.org, active_contacts, "Joe", sort="", offset=0, exclude=[joe]),
            mr_mocks.calls["contact_search"][-1],
        )

        response = self.client.get(list_url)
        self.assertEqual([frank], list(response.context["object_list"]))

        joe.refresh_from_db()
        self.assertEqual(Contact.STATUS_ARCHIVED, joe.status)

    @mock_mailroom
    def test_preview_list(self, mr_mocks):
        joe = self.create_contact("Joe", phone="123")
        frank = self.create_contact("Frank", phone="124")
        group = self.create_group("Crew", contacts=[joe, frank])

        list_url = reverse("contacts.contact_list")
        group_url = reverse("contacts.contact_group", args=[group.uuid])

        self.login(self.admin)

        # default render is still the legacy table
        response = self.client.get(list_url)
        self.assertNotContains(response, "temba-contact-list")

        # entering preview mode swaps in the temba-contact-list component, pointed at the internal contacts api
        self.client.cookies["temba-preview"] = "1"

        response = self.client.get(list_url)
        self.assertContains(response, "temba-contact-list")
        self.assertEqual(
            f"{reverse('api.internal.contacts')}.json?folder=active", response.context["new_list_endpoint"]
        )

        # send / start-flow are clientOnly (they open a modal); the group dropdown carries a labelsEndpoint of the
        # workspace's static groups; the rest post to the action endpoint
        actions = {a["key"]: a for a in response.context["new_list_bulk_actions"]}
        self.assertEqual(["label", "block", "archive", "send", "start-flow"], list(actions.keys()))
        self.assertTrue(actions["send"]["clientOnly"])
        self.assertTrue(actions["start-flow"]["clientOnly"])
        self.assertNotIn("clientOnly", actions["archive"])
        self.assertEqual("/api/v2/groups.json?manual_only=1", actions["label"]["labelsEndpoint"])

        # a user group is selected by uuid rather than a status folder
        response = self.client.get(group_url)
        self.assertEqual(
            f"{reverse('api.internal.contacts')}.json?group={group.uuid}", response.context["new_list_endpoint"]
        )
        # a manual group has no subtitle
        self.assertEqual("", response.context["new_list_subtitle"])

        # a smart (dynamic) group surfaces its query as the list subtitle
        smart = self.create_group("Females", query="gender = F")
        response = self.client.get(reverse("contacts.contact_group", args=[smart.uuid]))
        self.assertEqual(smart.query, response.context["new_list_subtitle"])

        # the component posts contact uuids in `objects`; the view translates them to ids so the bulk action applies
        self.client.post(list_url, {"action": "archive", "objects": str(joe.uuid)})
        joe.refresh_from_db()
        self.assertEqual(Contact.STATUS_ARCHIVED, joe.status)

        # the group dropdown adds the selection to a static group (group posted by uuid; omitting `add` means add)
        newsletter = self.create_group("Newsletter", contacts=[])
        self.client.post(list_url, {"action": "label", "objects": str(frank.uuid), "label": str(newsletter.uuid)})
        self.assertIn(frank, newsletter.contacts.all())

        # ...and removes them when add=false (BulkActionMixin maps that to unlabel)
        self.client.post(
            list_url, {"action": "label", "objects": str(frank.uuid), "label": str(newsletter.uuid), "add": "false"}
        )
        self.assertNotIn(frank, newsletter.contacts.all())

        # a label posted as a numeric id (a legacy form post rather than the component) is passed through untranslated
        self.client.post(list_url, {"action": "label", "objects": str(frank.uuid), "label": str(newsletter.id)})
        self.assertIn(frank, newsletter.contacts.all())

        # on a group page, an "unlabel" with no group falls back to the current group ("Remove from group")
        self.client.post(group_url, {"action": "unlabel", "objects": str(frank.uuid)})
        self.assertNotIn(frank, group.contacts.all())

        # a malformed contact uuid in `objects` is ignored rather than raising (no 500 on hostile/garbage input)
        response = self.client.post(list_url, {"action": "archive", "objects": "not-a-uuid"})
        self.assertEqual(200, response.status_code)

        del self.client.cookies["temba-preview"]

        # back on the legacy (non-preview) list, the content menu still surfaces Create Smart Group when the search is
        # saveable as a group — build_context_menu reads the search straight off the request query string here
        self.assertContentMenu(
            list_url + "?search=age+%3E+30",
            self.admin,
            ["Create Smart Group", "New Contact", "New Group", "Export"],
        )

    @mock_mailroom
    def test_blocked(self, mr_mocks):
        joe = self.create_contact("Joe", urns=["twitter:joe"])
        frank = self.create_contact("Frank", urns=["twitter:frank"])
        billy = self.create_contact("Billy", urns=["twitter:billy"])
        self.create_contact("Mary", urns=["twitter:mary"])

        joe.block(self.admin)
        frank.block(self.admin)
        billy.block(self.admin)

        blocked_url = reverse("contacts.contact_blocked")

        self.assertRequestDisallowed(blocked_url, [None, self.agent])
        response = self.assertListFetch(blocked_url, [self.editor, self.admin], context_objects=[billy, frank, joe])
        self.assertEqual(["restore", "archive"], list(response.context["actions"]))
        self.assertContentMenu(blocked_url, self.admin, ["Export"])

        # try restore bulk action
        self.client.post(blocked_url, {"action": "restore", "objects": billy.id})

        response = self.client.get(blocked_url)
        self.assertEqual([frank, joe], list(response.context["object_list"]))

        billy.refresh_from_db()
        self.assertEqual(Contact.STATUS_ACTIVE, billy.status)

        # try archive bulk action
        self.client.post(blocked_url, {"action": "archive", "objects": frank.id})

        response = self.client.get(blocked_url)
        self.assertEqual([joe], list(response.context["object_list"]))

        frank.refresh_from_db()
        self.assertEqual(Contact.STATUS_ARCHIVED, frank.status)

    @mock_mailroom
    def test_stopped(self, mr_mocks):
        joe = self.create_contact("Joe", urns=["twitter:joe"])
        frank = self.create_contact("Frank", urns=["twitter:frank"])
        billy = self.create_contact("Billy", urns=["twitter:billy"])
        self.create_contact("Mary", urns=["twitter:mary"])

        joe.stop(self.admin)
        frank.stop(self.admin)
        billy.stop(self.admin)

        stopped_url = reverse("contacts.contact_stopped")

        self.assertRequestDisallowed(stopped_url, [None, self.agent])
        response = self.assertListFetch(stopped_url, [self.editor, self.admin], context_objects=[billy, frank, joe])
        self.assertEqual(["restore", "archive"], list(response.context["actions"]))
        self.assertContentMenu(stopped_url, self.admin, ["Export"])

        # try restore bulk action
        self.client.post(stopped_url, {"action": "restore", "objects": billy.id})

        response = self.client.get(stopped_url)
        self.assertEqual([frank, joe], list(response.context["object_list"]))

        billy.refresh_from_db()
        self.assertEqual(Contact.STATUS_ACTIVE, billy.status)

        # try archive bulk action
        self.client.post(stopped_url, {"action": "archive", "objects": frank.id})

        response = self.client.get(stopped_url)
        self.assertEqual([joe], list(response.context["object_list"]))

        frank.refresh_from_db()
        self.assertEqual(Contact.STATUS_ARCHIVED, frank.status)

    @patch("temba.contacts.models.Contact.BULK_RELEASE_IMMEDIATELY_LIMIT", 5)
    @mock_mailroom
    def test_archived(self, mr_mocks):
        joe = self.create_contact("Joe", urns=["twitter:joe"])
        frank = self.create_contact("Frank", urns=["twitter:frank"])
        billy = self.create_contact("Billy", urns=["twitter:billy"])
        self.create_contact("Mary", urns=["twitter:mary"])

        joe.archive(self.admin)
        frank.archive(self.admin)
        billy.archive(self.admin)

        archived_url = reverse("contacts.contact_archived")

        self.assertRequestDisallowed(archived_url, [None, self.agent])
        response = self.assertListFetch(archived_url, [self.editor, self.admin], context_objects=[billy, frank, joe])
        self.assertEqual(["restore", "delete"], list(response.context["actions"]))
        self.assertContentMenu(archived_url, self.admin, ["Export", "Delete All"])

        # try restore bulk action
        self.client.post(archived_url, {"action": "restore", "objects": billy.id})

        response = self.client.get(archived_url)
        self.assertEqual([frank, joe], list(response.context["object_list"]))

        billy.refresh_from_db()
        self.assertEqual(Contact.STATUS_ACTIVE, billy.status)

        # try delete bulk action
        self.client.post(archived_url, {"action": "delete", "objects": frank.id})

        response = self.client.get(archived_url)
        self.assertEqual([joe], list(response.context["object_list"]))

        frank.refresh_from_db()
        self.assertFalse(frank.is_active)

        # the archived view also supports deleting all
        self.client.post(archived_url, {"action": "delete", "all": "true"})

        response = self.client.get(archived_url)
        self.assertEqual([], list(response.context["object_list"]))

        # only archived contacts affected
        self.assertEqual(2, Contact.objects.filter(is_active=False, status=Contact.STATUS_ARCHIVED).count())
        self.assertEqual(2, Contact.objects.filter(is_active=False).count())

        # for larger numbers of contacts, a background task is used
        for c in range(6):
            contact = self.create_contact(f"Bob{c}", urns=[f"twitter:bob{c}"])
            contact.archive(self.admin)

        response = self.client.get(archived_url)
        self.assertEqual(6, len(response.context["object_list"]))

        self.client.post(archived_url, {"action": "delete", "all": "true"})

        response = self.client.get(archived_url)
        self.assertEqual(0, len(response.context["object_list"]))

    @mock_mailroom
    def test_group(self, mr_mocks):
        open_tickets = self.org.groups.get(name="Open Tickets")
        joe = self.create_contact("Joe", phone="123")
        frank = self.create_contact("Frank", phone="124")
        self.create_contact("Bob", phone="125")

        mr_mocks.contact_search("age > 40", contacts=[frank], total=1)

        group1 = self.create_group("Testers", contacts=[joe, frank])  # static group
        group2 = self.create_group("Oldies", query="age > 40")  # smart group
        group2.contacts.add(frank)
        group3 = self.create_group("Other Org", org=self.org2)

        group1_url = reverse("contacts.contact_group", args=[group1.uuid])
        group2_url = reverse("contacts.contact_group", args=[group2.uuid])
        group3_url = reverse("contacts.contact_group", args=[group3.uuid])
        open_tickets_url = reverse("contacts.contact_group", args=[open_tickets.uuid])

        self.assertRequestDisallowed(group1_url, [None, self.agent, self.admin2])
        response = self.assertReadFetch(group1_url, [self.editor, self.admin])

        self.assertEqual([frank, joe], list(response.context["object_list"]))
        self.assertEqual(["unlabel", "block", "send", "start-flow"], list(response.context["actions"]))
        self.assertEqual(
            [f.name for f in response.context["contact_fields"]], ["Home", "Age", "Last Seen On", "Created On"]
        )

        self.assertContentMenu(
            group1_url,
            self.admin,
            ["Edit", "Export", "Usages", "Delete"],
        )

        response = self.assertReadFetch(group2_url, [self.editor])

        self.assertEqual([frank], list(response.context["object_list"]))
        self.assertEqual(["block", "archive", "send", "start-flow"], list(response.context["actions"]))
        self.assertContains(response, "age &gt; 40")

        # try unlabel bulk action
        self.client.post(group1_url, {"action": "unlabel", "objects": frank.id, "label": group1.id})
        response = self.client.get(group1_url)
        self.assertEqual([joe], list(response.context["object_list"]))

        # can access system group like any other except no options to edit or delete
        response = self.assertReadFetch(open_tickets_url, [self.editor])
        self.assertEqual([], list(response.context["object_list"]))
        self.assertEqual(["block", "archive", "send", "start-flow"], list(response.context["actions"]))
        self.assertContains(response, "tickets &gt; 0")
        self.assertContentMenu(open_tickets_url, self.admin, ["Export", "Usages"])

        # if a user tries to access a non-existent group, that's a 404
        response = self.requestView(reverse("contacts.contact_group", args=["21343253"]), self.admin)
        self.assertEqual(404, response.status_code)

        # if a user tries to access a group in another org, send them to the login page
        response = self.requestView(group3_url, self.admin)
        self.assertLoginRedirect(response)

        # if the user has access to that org, we redirect to the switch page
        self.org2.add_user(self.admin, OrgRole.ADMINISTRATOR)
        response = self.requestView(group3_url, self.admin, choose_org=self.org)
        self.assertRedirect(response, "/org/switch/")

    @mock_mailroom
    def test_read(self, mr_mocks):
        joe = self.create_contact("Joe", phone="123")

        read_url = reverse("contacts.contact_read", args=[joe.uuid])

        self.assertRequestDisallowed(read_url, [None, self.agent])

        self.assertContentMenu(read_url, self.editor, ["Edit", "Start Flow", "Open Ticket"])
        self.assertContentMenu(read_url, self.admin, ["Edit", "Start Flow", "Open Ticket"])

        # if there's an open ticket already, don't show open ticket option
        self.create_ticket(joe)
        self.assertContentMenu(read_url, self.editor, ["Edit", "Start Flow"])

        # login as admin
        self.login(self.admin)

        response = self.client.get(read_url)
        self.assertContains(response, "Joe")
        self.assertEqual("/contact/active", response.headers[TEMBA_MENU_SELECTION])

        # block the contact
        joe.block(self.admin)
        self.assertTrue(Contact.objects.get(pk=joe.id, status="B"))

        self.assertContentMenu(read_url, self.admin, ["Edit"])

        response = self.client.get(read_url)
        self.assertContains(response, "Joe")
        self.assertEqual("/contact/blocked", response.headers[TEMBA_MENU_SELECTION])

        # can't access a deleted contact
        joe.release(self.admin)

        response = self.client.get(read_url)
        self.assertEqual(response.status_code, 404)

        # contact with only a urn
        nameless = self.create_contact("", urns=["twitter:bobby_anon"])
        response = self.client.get(reverse("contacts.contact_read", args=[nameless.uuid]))
        self.assertContains(response, "bobby_anon")

        # contact without name or urn
        nameless = Contact.objects.create(org=self.org)
        response = self.client.get(reverse("contacts.contact_read", args=[nameless.uuid]))
        self.assertContains(response, "Contact Details")

        # invalid uuid should return 404
        response = self.client.get(reverse("contacts.contact_read", args=["invalid-uuid"]))
        self.assertEqual(response.status_code, 404)

    @patch("django.utils.timezone.now")
    @mock_mailroom
    def test_chat_sending(self, mr_mocks, mock_now):
        mock_now.return_value = datetime(2025, 11, 17, 16, 15, tzinfo=tzone.utc)

        contact = self.create_contact("Joe Blow", urns=["tel:+250781111111"])
        ticket = Ticket.objects.create(
            uuid="019a9935-022e-7bb3-9d6f-03d773be623e",
            org=self.org,
            contact=contact,
            topic=self.org.default_topic,
            status="O",
        )

        chat_url = reverse("contacts.contact_chat", args=[contact.uuid])

        self.login(self.editor)

        # send a simple text message
        response = self.client.post(chat_url, {"text": "Hello"}, content_type="application/json")
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {
                "event": {
                    "uuid": matchers.UUIDString(version=7),
                    "type": "msg_created",
                    "created_on": matchers.ISODatetime(),
                    "msg": {
                        "text": "Hello",
                        "urn": "tel:+250781111111",
                        "channel": {"uuid": str(self.channel.uuid), "name": "Test Channel"},
                    },
                    "_user": {"uuid": str(self.editor.uuid), "name": "Ed McEdits", "avatar": None},
                }
            },
            response.json(),
        )
        self.assertEqual(
            call(
                self.org,
                self.editor,
                contact,
                "Hello",
                [],
                [],
                None,
            ),
            mr_mocks.calls["msg_send"][-1],
        )

        # send a message with attachments and in the context of a ticket
        media = Media.from_upload(
            self.org,
            self.admin,
            self.upload(f"{settings.MEDIA_ROOT}/test_media/steve marten.jpg", "image/jpeg"),
            process=False,
        )
        response = self.client.post(
            chat_url, {"attachments": [str(media.uuid)], "ticket": str(ticket.uuid)}, content_type="application/json"
        )
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {
                "event": {
                    "uuid": matchers.String(),
                    "type": "msg_created",
                    "created_on": matchers.ISODatetime(),
                    "msg": {
                        "text": "",
                        "attachments": [matchers.String()],
                        "urn": "tel:+250781111111",
                        "channel": {"uuid": str(self.channel.uuid), "name": "Test Channel"},
                    },
                    "_user": {"uuid": str(self.editor.uuid), "name": "Ed McEdits", "avatar": None},
                }
            },
            response.json(),
        )
        self.assertEqual(
            call(
                self.org,
                self.editor,
                contact,
                "",
                [str(media)],
                [],
                ticket,
            ),
            mr_mocks.calls["msg_send"][-1],
        )

        # can't send to contact in a different org
        self.login(self.admin2)

        response = self.client.post(chat_url, {"text": "Hello"}, content_type="application/json")
        self.assertEqual(404, response.status_code)

    @mock_mailroom
    def test_chat_reply_non_own_permission(self, mr_mocks):
        contact = self.create_contact("Joe Blow", urns=["tel:+250781111111"])
        ticket = self.create_ticket(contact)
        chat_url = reverse("contacts.contact_chat", args=[contact.uuid])

        # restrict agent's ability to reply to unassigned tickets
        OrgMembership.objects.filter(org=self.org, user=self.agent).update(can_reply_non_own=False)
        self.org._membership_cache = {}

        self.login(self.agent)

        # agent can't reply to an unassigned ticket
        response = self.client.post(
            chat_url, {"text": "Hello", "ticket": str(ticket.uuid)}, content_type="application/json"
        )
        self.assertEqual(403, response.status_code)

        # assign ticket to the agent
        ticket.assignee = self.agent
        ticket.save(update_fields=("assignee",))

        # agent CAN reply to a ticket assigned to them
        response = self.client.post(
            chat_url, {"text": "Hello", "ticket": str(ticket.uuid)}, content_type="application/json"
        )
        self.assertEqual(200, response.status_code)

        # assign ticket to someone else
        ticket.assignee = self.admin
        ticket.save(update_fields=("assignee",))

        # agent can't reply to ticket assigned to another user
        response = self.client.post(
            chat_url, {"text": "Hello", "ticket": str(ticket.uuid)}, content_type="application/json"
        )
        self.assertEqual(403, response.status_code)

        # restore permission
        OrgMembership.objects.filter(org=self.org, user=self.agent).update(can_reply_non_own=True)
        self.org._membership_cache = {}

        # agent can now reply to ticket assigned to someone else
        response = self.client.post(
            chat_url, {"text": "Hello", "ticket": str(ticket.uuid)}, content_type="application/json"
        )
        self.assertEqual(200, response.status_code)

    @patch("temba.mailroom.events.Event.get_by_contact")
    @patch("django.utils.timezone.now")
    def test_chat_fetching(self, mock_now, mock_get_by_contact):
        mock_now.return_value = datetime(2025, 11, 17, 16, 15, tzinfo=tzone.utc)
        mock_get_by_contact.return_value = []

        contact = self.create_contact(name="Joe Blow", urns=["tel:+250781111111"])

        chat_url = reverse("contacts.contact_chat", args=[contact.uuid])

        def mock_events(count: int, start_time: datetime, end_time: datetime):
            events = []
            delta = (end_time - start_time) / count
            for i in range(count):
                when = start_time + delta * i
                events.append({"uuid": str(uuid7(when=when)), "type": "test", "created_on": when.isoformat()})
            return events

        self.login(self.editor)

        # error if we don't specify before or after
        response = self.client.get(chat_url)
        self.assertEqual(400, response.status_code)

        # providing a before value fetches older history
        response = self.client.get(chat_url + "?before=019a9299-1fa0-7124-82dc-716e856f293e")  # 2025-11-17T16:15
        self.assertEqual(200, response.status_code)
        self.assertEqual({"events": [], "next": None}, response.json())

        # if there are less than a page of events, next is empty
        mock_get_by_contact.return_value = mock_events(
            2, datetime(2025, 11, 17, 16, 1, tzinfo=tzone.utc), datetime(2025, 11, 17, 16, 0, tzinfo=tzone.utc)
        )

        response = self.client.get(chat_url + "?before=019a9299-1fa0-7124-82dc-716e856f293e")  # 2025-11-17T16:15
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {
                "events": [
                    {"uuid": matchers.UUIDString(version=7), "type": "test", "created_on": "2025-11-17T16:01:00+00:00"},
                    {"uuid": matchers.UUIDString(version=7), "type": "test", "created_on": "2025-11-17T16:00:30+00:00"},
                ],
                "next": None,
            },
            response.json(),
        )

        # but if fetching returns more than a page, we get a next value
        mock_get_by_contact.return_value = mock_events(
            51, datetime(2025, 11, 17, 16, 1, tzinfo=tzone.utc), datetime(2025, 11, 17, 16, 0, tzinfo=tzone.utc)
        )

        response = self.client.get(chat_url + "?before=019a9299-1fa0-7124-82dc-716e856f293e")  # 2025-11-17T16:15
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {"events": matchers.List(length=50), "next": matchers.UUIDString(version=7)},
            response.json(),
        )
        self.assertEqual(response.json()["events"][-1]["uuid"], response.json()["next"])

        mock_get_by_contact.return_value = []

        # providing a after value fetches newer history
        response = self.client.get(chat_url + "?after=019a9299-1fa0-7124-82dc-716e856f293e")  # 2025-11-17T16:15
        self.assertEqual(200, response.status_code)
        self.assertEqual({"events": [], "next": None}, response.json())

        # if there are less than a page of events, next is empty
        mock_get_by_contact.return_value = mock_events(
            2, datetime(2025, 11, 17, 16, 0, tzinfo=tzone.utc), datetime(2025, 11, 17, 16, 1, tzinfo=tzone.utc)
        )

        response = self.client.get(chat_url + "?after=019a9299-1fa0-7124-82dc-716e856f293e")  # 2025-11-17T16:15
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {
                "events": [
                    {"uuid": matchers.UUIDString(version=7), "type": "test", "created_on": "2025-11-17T16:00:30+00:00"},
                    {"uuid": matchers.UUIDString(version=7), "type": "test", "created_on": "2025-11-17T16:00:00+00:00"},
                ],
                "next": None,
            },
            response.json(),
        )

        # but if fetching returns more than a page, we get a next value
        mock_get_by_contact.return_value = mock_events(
            51, datetime(2025, 11, 17, 16, 0, tzinfo=tzone.utc), datetime(2025, 11, 17, 16, 1, tzinfo=tzone.utc)
        )

        response = self.client.get(chat_url + "?after=019a9299-1fa0-7124-82dc-716e856f293e")  # 2025-11-17T16:15
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {"events": matchers.List(length=50), "next": matchers.UUIDString(version=7)},
            response.json(),
        )
        self.assertEqual(response.json()["events"][0]["uuid"], response.json()["next"])

    @mock_mailroom
    def test_chat_search(self, mr_mocks):
        contact = self.create_contact("Joe Blow", urns=["tel:+250781111111"])

        chat_search_url = reverse("contacts.contact_chat_search", args=[contact.uuid])

        self.assertRequestDisallowed(chat_search_url, [None])

        self.login(self.editor)

        # empty text returns empty results
        response = self.client.get(chat_search_url + "?text=")
        self.assertEqual(200, response.status_code)
        self.assertEqual({"results": []}, response.json())

        # no text param returns empty results
        response = self.client.get(chat_search_url)
        self.assertEqual(200, response.status_code)
        self.assertEqual({"results": []}, response.json())

        # with results from mailroom
        mr_mocks.msg_search(
            [
                (
                    contact,
                    {
                        "uuid": "019a9935-022e-7bb3-9d6f-03d773be623e",
                        "type": "msg_received",
                        "created_on": "2025-11-17T16:00:00+00:00",
                    },
                ),
                (
                    contact,
                    {
                        "uuid": "019a9935-022e-7bb3-9d6f-03d773be624e",
                        "type": "msg_created",
                        "created_on": "2025-11-17T16:01:00+00:00",
                    },
                ),
            ]
        )

        response = self.client.get(chat_search_url + "?text=hello")
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {
                "results": [
                    {
                        "uuid": "019a9935-022e-7bb3-9d6f-03d773be623e",
                        "type": "msg_received",
                        "created_on": "2025-11-17T16:00:00+00:00",
                    },
                    {
                        "uuid": "019a9935-022e-7bb3-9d6f-03d773be624e",
                        "type": "msg_created",
                        "created_on": "2025-11-17T16:01:00+00:00",
                    },
                ]
            },
            response.json(),
        )

    @mock_mailroom
    def test_update(self, mr_mocks):
        self.org.flow_languages = ["eng", "spa"]
        self.org.save(update_fields=("flow_languages",))

        self.create_field("gender", "Gender", value_type=ContactField.TYPE_TEXT)
        contact = self.create_contact(
            "Bob",
            urns=["tel:+593979111111", "tel:+593979222222", "telegram:5474754"],
            fields={"age": 41, "gender": "M"},
            language="eng",
        )
        testers = self.create_group("Testers", contacts=[contact])
        self.create_contact("Ann", urns=["tel:+593979444444"])

        update_url = reverse("contacts.contact_update", args=[contact.uuid])

        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])
        self.assertUpdateFetch(
            update_url,
            [self.editor, self.admin],
            form_fields={
                "name": "Bob",
                "status": "A",
                "language": "eng",
                "groups": [testers],
                "new_scheme": None,
                "new_path": None,
                "urn__tel__0": "+593979111111",
                "urn__tel__1": "+593979222222",
                "urn__telegram__2": "5474754",
            },
        )

        # try to take URN in use by another contact
        mr_mocks.contact_urns({"tel:+593979444444": 12345678})

        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "Bobby", "status": "B", "language": "spa", "groups": [testers.id], "urn__tel__0": "+593979444444"},
            form_errors={"urn__tel__0": "In use by another contact."},
            object_unchanged=contact,
        )

        # try to update to an invalid URN
        mr_mocks.contact_urns({"tel:++++": "invalid path component"})

        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "Bobby", "status": "B", "language": "spa", "groups": [testers.id], "urn__tel__0": "++++"},
            form_errors={"urn__tel__0": "Invalid format."},
            object_unchanged=contact,
        )

        # try to add a new invalid phone URN
        mr_mocks.contact_urns({"tel:123": "not a valid phone number"})

        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "name": "Bobby",
                "status": "B",
                "language": "spa",
                "groups": [testers.id],
                "urn__tel__0": "+593979111111",
                "new_scheme": "tel",
                "new_path": "123",
            },
            form_errors={"new_path": "Invalid format."},
            object_unchanged=contact,
        )

        # try to add a new phone URN that isn't E164
        mr_mocks.contact_urns({"tel:123": False})

        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "name": "Bobby",
                "status": "B",
                "language": "spa",
                "groups": [testers.id],
                "urn__tel__0": "+593979111111",
                "new_scheme": "tel",
                "new_path": "123",
            },
            form_errors={"new_path": "Invalid phone number. Ensure number includes country code."},
            object_unchanged=contact,
        )

        # update all fields (removes second tel URN, adds a new Facebook URN)
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "name": "Bobby",
                "status": "B",
                "language": "spa",
                "groups": [testers.id],
                "urn__tel__0": "+593979333333",
                "urn__telegram__2": "78686776",
                "new_scheme": "facebook",
                "new_path": "9898989",
            },
            success_status=200,
        )

        contact.refresh_from_db()
        self.assertEqual("Bobby", contact.name)
        self.assertEqual(Contact.STATUS_BLOCKED, contact.status)
        self.assertEqual("spa", contact.language)
        self.assertEqual({testers}, set(contact.get_groups()))
        self.assertEqual(
            ["tel:+593979333333", "telegram:78686776", "facebook:9898989"],
            [u.identity for u in contact.urns.order_by("-priority")],
        )

        # for non-active contacts, shouldn't see groups on form
        self.assertUpdateFetch(
            update_url,
            [self.editor, self.admin],
            form_fields={
                "name": "Bobby",
                "status": "B",
                "language": "spa",
                "new_scheme": None,
                "new_path": None,
                "urn__tel__0": "+593979333333",
                "urn__telegram__1": "78686776",
                "urn__facebook__2": "9898989",
            },
        )

        # try to update with invalid URNs
        mr_mocks.contact_urns({"tel:456": "invalid path component", "facebook:xxxxx": "invalid path component"})

        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "name": "Bobby",
                "status": "B",
                "language": "spa",
                "groups": [],
                "urn__tel__0": "456",
                "urn__facebook__2": "xxxxx",
            },
            form_errors={
                "urn__tel__0": "Invalid format.",
                "urn__facebook__2": "Invalid format.",
            },
            object_unchanged=contact,
        )

        # if contact has a language which is no longer a flow language, it should still be a valid option on the form
        contact.language = "kin"
        contact.save(update_fields=("language",))

        response = self.assertUpdateFetch(
            update_url,
            [self.admin],
            form_fields={
                "name": "Bobby",
                "status": "B",
                "language": "kin",
                "new_scheme": None,
                "new_path": None,
                "urn__tel__0": "+593979333333",
                "urn__telegram__1": "78686776",
                "urn__facebook__2": "9898989",
            },
        )
        self.assertContains(response, "Kinyarwanda")

        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "name": "Bobby",
                "status": "A",
                "language": "kin",
                "urn__tel__0": "+593979333333",
                "urn__telegram__1": "78686776",
                "urn__facebook__2": "9898989",
            },
            success_status=200,
        )

        contact.refresh_from_db()
        self.assertEqual("Bobby", contact.name)
        self.assertEqual(Contact.STATUS_ACTIVE, contact.status)
        self.assertEqual("kin", contact.language)

    def test_update_urns_field(self):
        contact = self.create_contact("Bob", urns=[])

        update_url = reverse("contacts.contact_update", args=[contact.uuid])

        # we have a field to add new urns
        response = self.requestView(update_url, self.admin)
        self.assertContains(response, "Add Connection")

        # no field to add new urns for anon org
        with self.anonymous(self.org):
            response = self.requestView(update_url, self.admin)
            self.assertNotContains(response, "Add Connection")

    @mock_mailroom
    def test_update_with_mailroom_error(self, mr_mocks):
        mr_mocks.exception(mailroom.RequestException("", "", MockResponse(400, '{"error": "Error updating contact"}')))

        contact = self.create_contact("Joe", phone="1234")

        self.login(self.admin)

        response = self.client.post(
            reverse("contacts.contact_update", args=[contact.uuid]),
            {"name": "Joe", "status": Contact.STATUS_ACTIVE, "language": "eng"},
        )

        self.assertFormError(
            response.context["form"], None, "An error occurred updating your contact. Please try again later."
        )

    @mock_mailroom
    def test_export(self, mr_mocks):
        export_url = reverse("contacts.contact_export")

        self.assertRequestDisallowed(export_url, [None, self.agent])
        response = self.assertUpdateFetch(export_url, [self.editor, self.admin], form_fields=("with_groups",))
        self.assertNotContains(response, "already an export in progress")

        # create a dummy export task so that we won't be able to export
        blocking_export = ContactExport.create(self.org, self.admin)

        response = self.client.get(export_url)
        self.assertContains(response, "already an export in progress")

        # check we can't submit in case a user opens the form and whilst another user is starting an export
        response = self.client.post(export_url, {})
        self.assertContains(response, "already an export in progress")
        self.assertEqual(1, Export.objects.count())

        # mark that one as finished so it's no longer a blocker
        blocking_export.status = Export.STATUS_COMPLETE
        blocking_export.save(update_fields=("status",))

        # try to export a group that is too big
        big_group = self.create_group("Big Group", contacts=[])
        mr_mocks.contact_export_preview(1_000_123)

        response = self.client.get(export_url + f"?g={big_group.uuid}")
        self.assertContains(response, "This group or search is too large to export.")

        response = self.client.post(
            export_url + f"?g={self.org.active_contacts_group.uuid}", {"with_groups": [big_group.id]}
        )
        self.assertEqual(200, response.status_code)

        export = Export.objects.exclude(id=blocking_export.id).get()
        self.assertEqual("contact", export.export_type)
        self.assertEqual(
            {"group_id": self.org.active_contacts_group.id, "search": None, "with_groups": [big_group.id]},
            export.config,
        )

    def test_timeline(self):
        contact1 = self.create_contact("Joe", phone="+1234567890")
        contact2 = self.create_contact("Frank", phone="+1204567802")
        farmers = self.create_group("Farmers", contacts=[contact1, contact2])

        timeline_url = reverse("contacts.contact_timeline", args=[contact1.uuid])

        self.assertRequestDisallowed(timeline_url, [None, self.agent, self.admin2])
        response = self.assertReadFetch(timeline_url, [self.editor, self.admin])
        self.assertEqual([], response.json()["campaigns"])
        self.assertEqual([], response.json()["future"])
        self.assertEqual([], response.json()["past"])
        self.assertEqual(0, response.json()["future_count"])
        self.assertIsNone(response.json()["next_before"])
        self.assertIsNone(response.json()["next_after"])

        # create a campaign with a past and a future event, computed from the contact's join date
        campaign = Campaign.create(self.org, self.admin, "Reminders", farmers)
        joined = self.create_field("joined", "Joined On", value_type=ContactField.TYPE_DATETIME)
        flow = self.create_flow("Reminder Flow")
        msg_event = CampaignEvent.create_message_event(
            self.org,
            self.admin,
            campaign,
            joined,
            3,
            unit="D",
            translations={"eng": {"text": "Hi"}},
            base_language="eng",
        )
        flow_event = CampaignEvent.create_flow_event(self.org, self.admin, campaign, joined, 20, unit="D", flow=flow)

        # contact joined 10 days ago, so the +3 day event is past and the +20 day event is upcoming
        self.set_contact_field(contact1, "joined", (timezone.now() - timedelta(days=10)).isoformat())
        joined_on = contact1.get_field_value(joined)

        # create a scheduled broadcast and an already-sent broadcast
        bcast = self.create_broadcast(
            self.admin,
            {"eng": {"text": "Hi again"}},
            contacts=[contact1, contact2],
            schedule=Schedule.create(self.org, timezone.now() + timedelta(days=3), Schedule.REPEAT_NEVER),
        )
        self.create_broadcast(self.admin, {"eng": {"text": "Bye"}}, contacts=[contact1, contact2])  # not scheduled
        sent_msg = contact1.msgs.get(broadcast__isnull=False)

        # create scheduled trigger which this contact is explicitly added to
        trigger1_flow = self.create_flow("Favorites 1")
        trigger1 = Trigger.create(
            self.org,
            self.admin,
            trigger_type=Trigger.TYPE_SCHEDULE,
            flow=trigger1_flow,
            schedule=Schedule.create(self.org, timezone.now() + timedelta(days=4), Schedule.REPEAT_NEVER),
        )
        trigger1.contacts.add(contact1, contact2)

        # create scheduled trigger which this contact is added to via a group
        trigger2_flow = self.create_flow("Favorites 2")
        trigger2 = Trigger.create(
            self.org,
            self.admin,
            trigger_type=Trigger.TYPE_SCHEDULE,
            flow=trigger2_flow,
            schedule=Schedule.create(self.org, timezone.now() + timedelta(days=6), Schedule.REPEAT_NEVER),
        )
        trigger2.groups.add(farmers)

        # create scheduled trigger which this contact is explicitly added to... but also excluded from
        trigger3 = Trigger.create(
            self.org,
            self.admin,
            trigger_type=Trigger.TYPE_SCHEDULE,
            flow=self.create_flow("Favorites 3"),
            schedule=Schedule.create(self.org, timezone.now() + timedelta(days=4), Schedule.REPEAT_NEVER),
        )
        trigger3.contacts.add(contact1, contact2)
        trigger3.exclude_groups.add(farmers)

        response = self.requestView(timeline_url, self.admin)
        self.assertEqual(
            [
                {
                    "type": "scheduled_broadcast",
                    "scheduled": bcast.schedule.next_fire.astimezone(tzone.utc).isoformat(),
                    "message": "Hi again",
                },
                {
                    "type": "scheduled_trigger",
                    "scheduled": trigger1.schedule.next_fire.astimezone(tzone.utc).isoformat(),
                    "flow": {
                        "uuid": str(trigger1_flow.uuid),
                        "name": "Favorites 1",
                        "url": reverse("flows.flow_editor", args=[trigger1_flow.uuid]),
                    },
                },
                {
                    "type": "scheduled_trigger",
                    "scheduled": trigger2.schedule.next_fire.astimezone(tzone.utc).isoformat(),
                    "flow": {
                        "uuid": str(trigger2_flow.uuid),
                        "name": "Favorites 2",
                        "url": reverse("flows.flow_editor", args=[trigger2_flow.uuid]),
                    },
                },
                {
                    "type": "campaign_event",
                    "scheduled": (joined_on + timedelta(days=20)).isoformat(),
                    "campaign": {
                        "uuid": str(campaign.uuid),
                        "name": "Reminders",
                        "url": reverse("campaigns.campaign_read", args=[campaign.uuid]),
                    },
                    "url": reverse("campaigns.campaignevent_read", args=[campaign.uuid, flow_event.uuid]),
                    "flow": {
                        "uuid": str(flow.uuid),
                        "name": "Reminder Flow",
                        "url": reverse("flows.flow_editor", args=[flow.uuid]),
                    },
                },
            ],
            response.json()["future"],
        )
        self.assertEqual(
            [
                {"type": "sent_broadcast", "scheduled": sent_msg.created_on.isoformat(), "message": "Bye"},
                {
                    "type": "campaign_event",
                    "scheduled": (joined_on + timedelta(days=3)).isoformat(),
                    "campaign": {
                        "uuid": str(campaign.uuid),
                        "name": "Reminders",
                        "url": reverse("campaigns.campaign_read", args=[campaign.uuid]),
                    },
                    "url": reverse("campaigns.campaignevent_read", args=[campaign.uuid, msg_event.uuid]),
                    "message": "Hi",
                },
            ],
            response.json()["past"],
        )
        self.assertEqual(
            [
                {
                    "uuid": str(campaign.uuid),
                    "name": "Reminders",
                    "url": reverse("campaigns.campaign_read", args=[campaign.uuid]),
                },
            ],
            response.json()["campaigns"],
        )
        self.assertEqual(4, response.json()["future_count"])
        self.assertIsNone(response.json()["next_before"])
        self.assertIsNone(response.json()["next_after"])

        # events for archived campaigns shouldn't appear
        campaign.archive(self.admin)

        response = self.requestView(timeline_url, self.admin)
        self.assertEqual(3, len(response.json()["future"]))  # campaign event dropped
        self.assertEqual(3, response.json()["future_count"])
        self.assertEqual(1, len(response.json()["past"]))  # campaign event dropped, sent broadcast remains

    def test_timeline_delivery_hour_snapping(self):
        """A campaign event with a delivery_hour snaps its projected time to that hour in the org timezone."""
        contact = self.create_contact("Joe", phone="+1234567890")
        group = self.create_group("Members", contacts=[contact])
        timeline_url = reverse("contacts.contact_timeline", args=[contact.uuid])

        joined = self.create_field("joined", "Joined On", value_type=ContactField.TYPE_DATETIME)
        # joined a few days ago at an arbitrary time-of-day so we can confirm the projected time isn't
        # just anchor + offset; the +20 day offset below still lands comfortably in the future
        joined_at = timezone.now().replace(hour=3, minute=37, second=12, microsecond=0) - timedelta(days=5)
        self.set_contact_field(contact, "joined", joined_at.isoformat())

        # +20 day event with delivery_hour=9 (UNIT_DAYS) -> projected time snaps to 09:00 org-local
        campaign = Campaign.create(self.org, self.admin, "Reminders", group)
        CampaignEvent.create_message_event(
            self.org,
            self.admin,
            campaign,
            joined,
            20,
            unit="D",
            delivery_hour=9,
            translations={"eng": {"text": "Morning reminder"}},
            base_language="eng",
        )

        response = self.requestView(timeline_url, self.admin)
        future = response.json()["future"]
        self.assertEqual(1, len(future))

        scheduled = iso8601.parse_date(future[0]["scheduled"]).astimezone(self.org.timezone)
        expected = (
            (joined_at + timedelta(days=20))
            .astimezone(self.org.timezone)
            .replace(hour=9, minute=0, second=0, microsecond=0)
        )
        self.assertEqual(expected, scheduled)
        self.assertEqual(9, scheduled.hour)
        self.assertEqual(0, scheduled.minute)

    def test_timeline_inactive_and_missing_anchor(self):
        """Inactive campaign events and events whose anchor field the contact lacks are omitted."""
        contact = self.create_contact("Joe", phone="+1234567890")
        group = self.create_group("Members", contacts=[contact])
        timeline_url = reverse("contacts.contact_timeline", args=[contact.uuid])

        joined = self.create_field("joined", "Joined On", value_type=ContactField.TYPE_DATETIME)
        # a second datetime field that the contact has NO value for
        renewed = self.create_field("renewed", "Renewed On", value_type=ContactField.TYPE_DATETIME)
        self.set_contact_field(contact, "joined", (timezone.now() - timedelta(days=5)).isoformat())

        campaign = Campaign.create(self.org, self.admin, "Reminders", group)

        # an active event anchored on a field the contact HAS -> appears
        visible = CampaignEvent.create_message_event(
            self.org,
            self.admin,
            campaign,
            joined,
            20,
            unit="D",
            translations={"eng": {"text": "Visible"}},
            base_language="eng",
        )

        # an active event anchored on a field the contact does NOT have -> omitted (line 710)
        CampaignEvent.create_message_event(
            self.org,
            self.admin,
            campaign,
            renewed,
            20,
            unit="D",
            translations={"eng": {"text": "No anchor"}},
            base_language="eng",
        )

        # an inactive event on a field the contact has -> omitted (line 703)
        inactive = CampaignEvent.create_message_event(
            self.org,
            self.admin,
            campaign,
            joined,
            25,
            unit="D",
            translations={"eng": {"text": "Inactive"}},
            base_language="eng",
        )
        inactive.is_active = False
        inactive.save(update_fields=("is_active",))

        response = self.requestView(timeline_url, self.admin)
        future = response.json()["future"]

        # only the single visible event survives
        self.assertEqual(1, len(future))
        self.assertEqual(1, response.json()["future_count"])
        self.assertEqual(reverse("campaigns.campaignevent_read", args=[campaign.uuid, visible.uuid]), future[0]["url"])
        self.assertEqual("Visible", future[0]["message"])

    def test_timeline_pagination(self):
        contact = self.create_contact("Joe", phone="+1234567890")
        timeline_url = reverse("contacts.contact_timeline", args=[contact.uuid])

        # send the contact more past broadcasts than fit on a single page
        for i in range(7):
            self.create_broadcast(self.admin, {"eng": {"text": f"Bcast {i}"}}, contacts=[contact])

        response = self.requestView(timeline_url, self.admin)
        self.assertEqual([], response.json()["future"])
        self.assertEqual(0, response.json()["future_count"])
        self.assertEqual(5, len(response.json()["past"]))
        next_before = response.json()["next_before"]
        self.assertIsNotNone(next_before)

        # paging back with the cursor returns the remaining older events
        response = self.requestView(timeline_url + f"?before={quote(next_before)}", self.admin)
        self.assertEqual([], response.json()["future"])
        self.assertEqual(2, len(response.json()["past"]))
        self.assertIsNone(response.json()["next_before"])

        # and now stack up enough upcoming scheduled broadcasts to test forward paging
        for i in range(12):
            self.create_broadcast(
                self.admin,
                {"eng": {"text": f"Upcoming {i}"}},
                contacts=[contact],
                schedule=Schedule.create(self.org, timezone.now() + timedelta(days=i + 1), Schedule.REPEAT_NEVER),
            )

        response = self.requestView(timeline_url, self.admin)
        self.assertEqual(10, len(response.json()["future"]))
        self.assertEqual(12, response.json()["future_count"])
        next_after = response.json()["next_after"]
        self.assertIsNotNone(next_after)

        response = self.requestView(timeline_url + f"?after={quote(next_after)}", self.admin)
        self.assertEqual(2, len(response.json()["future"]))
        self.assertEqual(12, response.json()["future_count"])
        self.assertIsNone(response.json()["next_after"])

    def test_timeline_pagination_mixed_past(self):
        """The past-page cursor pages correctly through a mix of campaign events and sent broadcasts."""
        contact = self.create_contact("Joe", phone="+1234567890")
        group = self.create_group("Members", contacts=[contact])
        timeline_url = reverse("contacts.contact_timeline", args=[contact.uuid])

        # contact joined 100 days ago - campaign offsets below all land in the past
        joined = self.create_field("joined", "Joined On", value_type=ContactField.TYPE_DATETIME)
        joined_at = timezone.now() - timedelta(days=100)
        self.set_contact_field(contact, "joined", joined_at.isoformat())

        # four past campaign message events at distinct offsets (-90, -80, -70, -60 days)
        campaign = Campaign.create(self.org, self.admin, "Reminders", group)
        for days in (10, 20, 30, 40):
            CampaignEvent.create_message_event(
                self.org,
                self.admin,
                campaign,
                joined,
                days,
                unit="D",
                translations={"eng": {"text": f"Campaign +{days}d"}},
                base_language="eng",
            )

        # four sent broadcasts interleaved in time with the campaign events. created_on is
        # immutable (DB trigger), so we set it at insert time on a fresh outgoing msg and then
        # attach it to the broadcast (a non-created_on field update, which the trigger allows)
        for i in range(4):
            bcast = self.create_broadcast(self.admin, {"eng": {"text": f"Bcast {i}"}}, contacts=[contact])
            bcast.msgs.all().delete()  # drop the auto-created now-dated msg
            msg = self.create_outgoing_msg(
                contact,
                f"Bcast {i}",
                created_on=joined_at + timedelta(days=15 + i * 10),  # -85, -75, -65, -55 days
            )
            msg.broadcast = bcast
            msg.save(update_fields=("broadcast",))

        # eight past events total, five per page -> first page has five, cursor set
        response = self.requestView(timeline_url, self.admin)
        first = response.json()["past"]
        self.assertEqual(5, len(first))
        next_before = response.json()["next_before"]
        self.assertIsNotNone(next_before)

        # second page returns the remaining three, no further cursor
        response = self.requestView(timeline_url + f"?before={quote(next_before)}", self.admin)
        second = response.json()["past"]
        self.assertEqual(3, len(second))
        self.assertIsNone(response.json()["next_before"])

        # across both pages we see all eight events with no duplicates and no drops
        scheduled = [e["scheduled"] for e in first] + [e["scheduled"] for e in second]
        self.assertEqual(8, len(scheduled))
        self.assertEqual(8, len(set(scheduled)))
        # and they remain in strict newest-first order across the boundary
        self.assertEqual(scheduled, sorted(scheduled, reverse=True))

    def test_timeline_pagination_tied_timestamps(self):
        """Past events sharing an exact timestamp are never split across a page boundary."""
        contact = self.create_contact("Joe", phone="+1234567890")
        group = self.create_group("Members", contacts=[contact])
        timeline_url = reverse("contacts.contact_timeline", args=[contact.uuid])

        joined = self.create_field("joined", "Joined On", value_type=ContactField.TYPE_DATETIME)
        joined_at = timezone.now() - timedelta(days=100)
        self.set_contact_field(contact, "joined", joined_at.isoformat())

        # campaign with four newer events at distinct offsets, plus three events at one identical
        # (older) offset. Newest-first, the page boundary (past_limit=5) falls inside the tied group:
        # positions 5/6/7 are the three tied siblings, so without the tie-break guard the next-page
        # `< cursor` filter would drop the un-shown siblings. This exercises the tie-break while loop.
        campaign = Campaign.create(self.org, self.admin, "Reminders", group)
        for days in (40, 50, 60, 70):  # distinct, all NEWER than the +30d tied group
            CampaignEvent.create_message_event(
                self.org,
                self.admin,
                campaign,
                joined,
                days,
                unit="D",
                translations={"eng": {"text": f"Distinct +{days}d"}},
                base_language="eng",
            )
        for i in range(3):
            CampaignEvent.create_message_event(
                self.org,
                self.admin,
                campaign,
                joined,
                30,  # all +30 days -> identical time, older than the distinct ones above
                unit="D",
                translations={"eng": {"text": f"Tied {i}"}},
                base_language="eng",
            )

        # walk every past page, collecting all events
        seen = []
        before = None
        for _ in range(10):  # generous cap to avoid an infinite loop on regression
            url = timeline_url + (f"?before={quote(before)}" if before else "")
            data = self.requestView(url, self.admin).json()
            seen.extend(data["past"])
            before = data["next_before"]
            if not before:
                break

        scheduled = [e["scheduled"] for e in seen]
        # all seven events present, none dropped, none duplicated
        self.assertEqual(7, len(scheduled))
        # the 3 tied events share one timestamp, the other 4 are distinct -> 5 distinct timestamps
        self.assertEqual(5, len(set(scheduled)))
        # the three tied events all survive
        self.assertEqual(3, sum(1 for e in seen if e["message"].startswith("Tied")))

    def test_timeline_pagination_tied_sent_broadcasts(self):
        """Sent broadcasts tied at the page boundary beyond the capped load are recovered via the supplemental query."""
        contact = self.create_contact("Joe", phone="+1234567890")
        timeline_url = reverse("contacts.contact_timeline", args=[contact.uuid])

        base = timezone.now() - timedelta(days=30)

        # eight sent broadcasts ALL sharing the exact same created_on. the past page loads only
        # past_limit + 1 (=6) of them, so two tied siblings are left unloaded. the page boundary lands
        # on this shared timestamp, and the supplemental tied-broadcast query must recover the two that
        # the capped load missed - otherwise the strict `< cursor` next page would silently drop them.
        for i in range(8):
            bcast = self.create_broadcast(self.admin, {"eng": {"text": f"Tied {i}"}}, contacts=[contact])
            bcast.msgs.all().delete()  # drop the auto-created now-dated msg
            msg = self.create_outgoing_msg(contact, f"Tied {i}", created_on=base)
            msg.broadcast = bcast
            msg.save(update_fields=("broadcast",))

        # walk every past page, collecting all events
        seen = []
        before = None
        for _ in range(20):  # generous cap to avoid an infinite loop on regression
            url = timeline_url + (f"?before={quote(before)}" if before else "")
            data = self.requestView(url, self.admin).json()
            seen.extend(data["past"])
            before = data["next_before"]
            if not before:
                break

        # all eight tied broadcasts survive paging, none dropped, none duplicated
        messages = [e["message"] for e in seen]
        self.assertEqual(8, len(messages))
        self.assertEqual(set(f"Tied {i}" for i in range(8)), set(messages))

    def test_timeline_excludes_paused_schedules(self):
        """Scheduled broadcasts and triggers whose schedule is paused are excluded from the timeline."""
        contact = self.create_contact("Joe", phone="+1234567890")
        timeline_url = reverse("contacts.contact_timeline", args=[contact.uuid])

        # a non-paused scheduled broadcast (future fire) - should appear in future
        self.create_broadcast(
            self.admin,
            {"eng": {"text": "Active bcast"}},
            contacts=[contact],
            schedule=Schedule.create(self.org, timezone.now() + timedelta(days=3), Schedule.REPEAT_NEVER),
        )

        # a paused scheduled broadcast (future fire) - should be excluded
        paused_bcast = self.create_broadcast(
            self.admin,
            {"eng": {"text": "Paused bcast"}},
            contacts=[contact],
            schedule=Schedule.create(self.org, timezone.now() + timedelta(days=4), Schedule.REPEAT_NEVER),
        )
        paused_bcast.schedule.is_paused = True
        paused_bcast.schedule.save()

        # a paused scheduled trigger - should be excluded
        paused_trigger = Trigger.create(
            self.org,
            self.admin,
            trigger_type=Trigger.TYPE_SCHEDULE,
            flow=self.create_flow("Paused Flow"),
            schedule=Schedule.create(self.org, timezone.now() + timedelta(days=5), Schedule.REPEAT_NEVER),
        )
        paused_trigger.contacts.add(contact)
        paused_trigger.schedule.is_paused = True
        paused_trigger.schedule.save()

        future = self.requestView(timeline_url, self.admin).json()["future"]
        messages = [e.get("message") for e in future if e["type"] == "scheduled_broadcast"]
        self.assertEqual(["Active bcast"], messages)  # non-paused broadcast present
        self.assertNotIn("Paused bcast", messages)  # paused broadcast excluded
        self.assertEqual([], [e for e in future if e["type"] == "scheduled_trigger"])  # paused trigger excluded

    def test_timeline_more_past_not_dropped_with_tied_sent_broadcasts(self):
        """Older past events aren't dropped when a full page of tied sent broadcasts straddles the boundary."""
        contact = self.create_contact("Joe", phone="+1234567890")
        group = self.create_group("Members", contacts=[contact])
        timeline_url = reverse("contacts.contact_timeline", args=[contact.uuid])

        tied_at = timezone.now() - timedelta(days=30)

        # eight sent broadcasts ALL sharing one created_on (T = now - 30d). With past_limit=5 the first
        # page loads only past_limit + 1 (=6) of them; the in-memory tie-break extends to all 6 loaded
        # (the cap), then the supplemental DB query appends the other 2 tied siblings -> past_page holds 8.
        for i in range(8):
            bcast = self.create_broadcast(self.admin, {"eng": {"text": f"Tied {i}"}}, contacts=[contact])
            bcast.msgs.all().delete()  # drop the auto-created now-dated msg
            msg = self.create_outgoing_msg(contact, f"Tied {i}", created_on=tied_at)
            msg.broadcast = bcast
            msg.save(update_fields=("broadcast",))

        # two OLDER past campaign message events at distinct times strictly older than T. The contact
        # joined 100 days ago, so the +10d / +40d offsets project to now - 90d and now - 60d.
        joined = self.create_field("joined", "Joined On", value_type=ContactField.TYPE_DATETIME)
        joined_at = timezone.now() - timedelta(days=100)
        self.set_contact_field(contact, "joined", joined_at.isoformat())
        campaign = Campaign.create(self.org, self.admin, "Reminders", group)
        for days in (10, 40):  # -> now - 90d and now - 60d, both older than the tied broadcasts at T
            CampaignEvent.create_message_event(
                self.org,
                self.admin,
                campaign,
                joined,
                days,
                unit="D",
                translations={"eng": {"text": f"Campaign +{days}d"}},
                base_language="eng",
            )

        # the old code computed has_more_past as len(past_window)=8 > len(past_page)=8 -> False, so the
        # first page's cursor was None and the 2 older campaign events were silently dropped. the fix
        # compares against the in-memory window end (6) instead, so paging continues to the older events.
        seen = []
        before = None
        for _ in range(20):  # generous cap to avoid an infinite loop on regression
            url = timeline_url + (f"?before={quote(before)}" if before else "")
            data = self.requestView(url, self.admin).json()
            seen.extend(data["past"])
            before = data["next_before"]
            if not before:
                break

        messages = [e["message"] for e in seen]
        # all 10 events surface across paging: 8 tied broadcasts + 2 older campaign events, no drops/dupes
        self.assertEqual(10, len(messages))
        self.assertEqual(set(messages), set([f"Tied {i}" for i in range(8)] + ["Campaign +10d", "Campaign +40d"]))
        # the 2 older campaign events specifically must survive (the false-negative the fix addresses)
        self.assertIn("Campaign +10d", messages)
        self.assertIn("Campaign +40d", messages)

    def test_timeline_pagination_tied_future(self):
        """Upcoming events tied at the future page boundary are never split across the page boundary."""
        contact = self.create_contact("Joe", phone="+1234567890")
        timeline_url = reverse("contacts.contact_timeline", args=[contact.uuid])

        # nine distinct upcoming scheduled broadcasts (days 1..9) plus a tied group of three sharing
        # one later start_time. soonest-first, the future_limit=10 boundary falls inside the tied group
        # (positions 10/11/12), so the tie-break while loop must extend the page to cover the whole group.
        for i in range(9):
            self.create_broadcast(
                self.admin,
                {"eng": {"text": f"Distinct {i}"}},
                contacts=[contact],
                schedule=Schedule.create(self.org, timezone.now() + timedelta(days=i + 1), Schedule.REPEAT_NEVER),
            )
        tied_start = timezone.now() + timedelta(days=20)
        for i in range(3):
            self.create_broadcast(
                self.admin,
                {"eng": {"text": f"Tied {i}"}},
                contacts=[contact],
                schedule=Schedule.create(self.org, tied_start, Schedule.REPEAT_NEVER),
            )

        # walk every future page, collecting all events
        seen = []
        after = None
        for _ in range(20):  # generous cap to avoid an infinite loop on regression
            url = timeline_url + (f"?after={quote(after)}" if after else "")
            data = self.requestView(url, self.admin).json()
            seen.extend(data["future"])
            after = data["next_after"]
            if not after:
                break

        messages = [e["message"] for e in seen]
        # all twelve upcoming events present, none dropped, none duplicated
        self.assertEqual(12, len(messages))
        self.assertEqual(12, len(set(messages)))
        # the three tied events all survive
        self.assertEqual(3, sum(1 for m in messages if m.startswith("Tied")))

    def test_timeline_malformed_cursor(self):
        """A garbage before/after cursor is treated as absent and returns a normal 200, not a 500."""
        contact = self.create_contact("Joe", phone="+1234567890")
        timeline_url = reverse("contacts.contact_timeline", args=[contact.uuid])

        # baseline response with no cursor (drop `now`, which is recomputed fresh per request)
        expected = self.requestView(timeline_url, self.admin).json()
        del expected["now"]

        for param in ("before", "after"):
            response = self.requestView(timeline_url + f"?{param}=garbage", self.admin)
            self.assertEqual(200, response.status_code)
            # an unparseable cursor falls back to the default (no cursor), matching the baseline
            actual = response.json()
            del actual["now"]
            self.assertEqual(expected, actual)

    def test_timeline_repeating_projection(self):
        """A repeating scheduled broadcast expands into timeline entries within the one-year horizon."""
        contact = self.create_contact("Joe", phone="+1234567890")
        timeline_url = reverse("contacts.contact_timeline", args=[contact.uuid])

        bcast = self.create_broadcast(
            self.admin,
            {"eng": {"text": "Weekly check-in"}},
            contacts=[contact],
            schedule=Schedule.create(
                self.org,
                timezone.now() + timedelta(days=2),
                Schedule.REPEAT_WEEKLY,
                repeat_days_of_week="M",
            ),
        )

        response = self.requestView(timeline_url, self.admin)

        # the weekly broadcast is projected forward through the one-year window -
        # 52 or 53 occurrences depending on calendar alignment, ten visible per page
        self.assertIn(response.json()["future_count"], (52, 53))
        self.assertEqual(10, len(response.json()["future"]))
        self.assertIsNotNone(response.json()["next_after"])
        for entry in response.json()["future"]:
            self.assertEqual("scheduled_broadcast", entry["type"])
            self.assertEqual("Weekly check-in", entry["message"])

        # those occurrences are sorted oldest-first; the first matches the schedule's next_fire.
        # because the schedule starts in the future, update_schedule sets next_fire to the raw
        # start_time (not snapped to a Monday) and calculate_next_fire only snaps subsequent fires
        # onto Mondays - so the first interval isn't necessarily 7 days, but every interval after
        # the second occurrence is
        fires = [iso8601.parse_date(e["scheduled"]) for e in response.json()["future"]]
        self.assertEqual(bcast.schedule.next_fire.astimezone(tzone.utc), fires[0])
        for earlier, later in zip(fires[1:], fires[2:]):
            self.assertEqual(timedelta(days=7), later - earlier)

    def test_timeline_horizon_drops_distant_future(self):
        """A one-off scheduled event more than a year out is dropped from the timeline."""
        contact = self.create_contact("Joe", phone="+1234567890")
        timeline_url = reverse("contacts.contact_timeline", args=[contact.uuid])

        # one within the window, one well outside it
        self.create_broadcast(
            self.admin,
            {"eng": {"text": "Soon"}},
            contacts=[contact],
            schedule=Schedule.create(self.org, timezone.now() + timedelta(days=30), Schedule.REPEAT_NEVER),
        )
        self.create_broadcast(
            self.admin,
            {"eng": {"text": "Way out"}},
            contacts=[contact],
            schedule=Schedule.create(self.org, timezone.now() + timedelta(days=400), Schedule.REPEAT_NEVER),
        )

        response = self.requestView(timeline_url, self.admin)
        self.assertEqual(1, response.json()["future_count"])
        self.assertEqual(["Soon"], [e["message"] for e in response.json()["future"]])

    @mock_mailroom
    def test_open_ticket(self, mr_mocks):
        contact = self.create_contact("Joe", phone="+593979000111")
        general = self.org.default_topic
        open_url = reverse("contacts.contact_open_ticket", args=[contact.uuid])

        self.assertRequestDisallowed(open_url, [None, self.agent, self.admin2])
        self.assertUpdateFetch(open_url, [self.editor, self.admin], form_fields=("topic", "assignee", "note"))

        # can submit with no assignee
        response = self.assertUpdateSubmit(open_url, self.admin, {"topic": general.id, "body": "Help", "assignee": ""})

        # should have new ticket
        ticket = contact.tickets.get()
        self.assertEqual(general, ticket.topic)
        self.assertIsNone(ticket.assignee)

        # and we're redirected to that ticket
        self.assertRedirect(response, f"/ticket/all/open/{ticket.uuid}/")

    @mock_mailroom
    def test_interrupt(self, mr_mocks):
        contact = self.create_contact("Joe", phone="+593979000111")
        other_org_contact = self.create_contact("Hans", phone="+593979123456", org=self.org2)

        read_url = reverse("contacts.contact_read", args=[contact.uuid])
        interrupt_url = reverse("contacts.contact_interrupt", args=[contact.uuid])

        self.login(self.admin)

        # should see start flow option
        response = self.client.get(read_url)
        self.assertContentMenu(read_url, self.admin, ["Edit", "Start Flow", "Open Ticket"])

        MockSessionWriter(contact, self.create_flow("Test")).wait().save()
        MockSessionWriter(other_org_contact, self.create_flow("Test", org=self.org2)).wait().save()

        # start option should be gone
        self.assertContentMenu(read_url, self.admin, ["Edit", "Open Ticket"])

        # can't interrupt if not logged in
        self.client.logout()
        response = self.client.post(interrupt_url)
        self.assertLoginRedirect(response)

        self.login(self.agent)

        # can interrupt if agent
        response = self.client.post(interrupt_url)
        self.assertEqual(302, response.status_code)

        contact.refresh_from_db()
        self.assertIsNone(contact.current_flow)

        # can't interrupt contact in other org
        other_contact_interrupt = reverse("contacts.contact_interrupt", args=[other_org_contact.uuid])
        response = self.client.post(other_contact_interrupt)
        self.assertLoginRedirect(response)

        # contact should be unchanged
        other_org_contact.refresh_from_db()
        self.assertIsNotNone(other_org_contact.current_flow)

    @mock_mailroom
    def test_delete(self, mr_mocks):
        contact = self.create_contact("Joe", phone="+593979000111")
        other_org_contact = self.create_contact("Hans", phone="+593979123456", org=self.org2)

        delete_url = reverse("contacts.contact_delete", args=[contact.uuid])

        # can't delete if not logged in
        response = self.client.post(delete_url, {"uuid": contact.uuid})
        self.assertLoginRedirect(response)

        self.login(self.agent)

        # can't delete if just agent
        response = self.client.post(delete_url, {"uuid": contact.uuid})
        self.assertLoginRedirect(response)

        self.login(self.admin)

        response = self.client.post(delete_url, {"uuid": contact.uuid})
        self.assertEqual(302, response.status_code)

        contact.refresh_from_db()
        self.assertFalse(contact.is_active)

        self.assertEqual([call(self.org, [contact])], mr_mocks.calls["contact_deindex"])

        # can't delete contact in other org
        delete_url = reverse("contacts.contact_delete", args=[other_org_contact.uuid])
        response = self.client.post(delete_url, {"uuid": other_org_contact.uuid})
        self.assertEqual(404, response.status_code)

        # contact should be unchanged
        other_org_contact.refresh_from_db()
        self.assertTrue(other_org_contact.is_active)

    @mock_mailroom
    def test_start(self, mr_mocks):
        sample_flows = list(self.org.flows.order_by("name"))
        background_flow = self.create_flow("Background")
        archived_flow = self.create_flow("Archived")
        archived_flow.archive(self.admin)

        contact = self.create_contact("Joe", phone="+593979000111")
        start_url = f"{reverse('flows.flow_start', args=[])}?flow={sample_flows[0].id}&c={contact.uuid}"

        self.assertRequestDisallowed(start_url, [None, self.agent])
        response = self.assertUpdateFetch(start_url, [self.editor, self.admin], form_fields=["flow", "contact_search"])

        self.assertEqual([background_flow] + sample_flows, list(response.context["form"].fields["flow"].queryset))

        # try to submit without specifying a flow
        self.assertUpdateSubmit(
            start_url,
            self.admin,
            data={},
            form_errors={"flow": "This field is required.", "contact_search": "This field is required."},
            object_unchanged=contact,
        )

        # submit with flow...
        contact_search = dict(query=f"uuid='{contact.uuid}'", advanced=True)
        self.assertUpdateSubmit(
            start_url, self.admin, {"flow": background_flow.id, "contact_search": json.dumps(contact_search)}
        )

        self.assertEqual(
            mr_mocks.calls["flow_start"],
            [
                call(
                    self.org,
                    self.admin,
                    typ="M",
                    flow=background_flow,
                    groups=[],
                    contacts=[],
                    urns=[],
                    query=f"uuid='{contact.uuid}'",
                    exclude=Exclusions(),
                    params={},
                )
            ],
        )
