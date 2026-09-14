from datetime import timedelta
from unittest.mock import call, patch

from django.urls import reverse
from django.utils import timezone

from temba import mailroom
from temba.ai.models import LLM
from temba.ai.types.anthropic.type import AnthropicType
from temba.ai.types.openai.type import OpenAIType
from temba.api.tests.mixins import APITestMixin
from temba.campaigns.models import Campaign, CampaignEvent
from temba.contacts.models import Contact, ContactExport, ContactField, ContactGroup, ContactURN
from temba.flows.models import Flow, FlowLabel
from temba.globals.models import Global
from temba.knowledge.models import Article, Knowledge
from temba.msgs.models import Broadcast
from temba.notifications.types import ExportFinishedNotificationType
from temba.orgs.models import Org, OrgRole
from temba.schedules.models import Schedule
from temba.templates.models import Template, TemplateTranslation
from temba.tests import TembaTest, matchers, mock_mailroom
from temba.tickets.models import Shortcut, TicketExport, Topic
from temba.triggers.models import Trigger
from temba.utils.uuid import uuid4

NUM_BASE_QUERIES = 3  # number of queries required for any request (internal API is session only)


class EndpointsTest(APITestMixin, TembaTest):
    def test_locations(self):
        endpoint_url = reverse("api.internal.locations") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        # no country, no results
        self.assertGet(endpoint_url + "?level=state", [self.agent], results=[])

        self.setUpLocations()

        self.assertGet(
            endpoint_url + "?level=state",
            [self.agent],
            results=[
                {"osm_id": "171591", "name": "Eastern Province", "path": "Rwanda > Eastern Province"},
                {"osm_id": "1708283", "name": "Kigali City", "path": "Rwanda > Kigali City"},
            ],
            num_queries=NUM_BASE_QUERIES + 2,
        )
        self.assertGet(
            endpoint_url + "?level=district",
            [self.editor],
            results=[
                {"osm_id": "R1711131", "name": "Gatsibo", "path": "Rwanda > Eastern Province > Gatsibo"},
                {"osm_id": "1711163", "name": "Kayônza", "path": "Rwanda > Eastern Province > Kayônza"},
                {"osm_id": "3963734", "name": "Nyarugenge", "path": "Rwanda > Kigali City > Nyarugenge"},
                {"osm_id": "1711142", "name": "Rwamagana", "path": "Rwanda > Eastern Province > Rwamagana"},
            ],
        )

        # can query on path
        self.assertGet(
            endpoint_url + "?level=district&query=ga",
            [self.editor],
            results=[
                {"osm_id": "R1711131", "name": "Gatsibo", "path": "Rwanda > Eastern Province > Gatsibo"},
                {"osm_id": "3963734", "name": "Nyarugenge", "path": "Rwanda > Kigali City > Nyarugenge"},
                {"osm_id": "1711142", "name": "Rwamagana", "path": "Rwanda > Eastern Province > Rwamagana"},
            ],
        )

        # missing or invalid level, no results
        self.assertGet(endpoint_url + "?level=hood", [self.agent], results=[])
        self.assertGet(endpoint_url, [self.agent], results=[])

    def test_messages(self):
        endpoint_url = reverse("api.internal.messages") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        contact1 = self.create_contact("Ann", phone="+1234567001")
        contact2 = self.create_contact("Bob", phone="+1234567002")
        label = self.create_label("Spam")

        # inbox messages (incoming, handled, visible, no flow)
        msg1 = self.create_incoming_msg(contact1, "Hello there")
        msg2 = self.create_incoming_msg(contact2, "Look at this", attachments=["image/jpeg:https://example.com/a.jpg"])
        msg2.labels.add(label)

        # a message in another folder shouldn't appear in the inbox
        archived = self.create_incoming_msg(contact1, "Archived", archived=True)
        archived.labels.add(label)

        msg1_logs_url = reverse("channels.channel_logs_read", args=[self.channel.uuid, "msg", msg1.uuid])
        msg2_logs_url = reverse("channels.channel_logs_read", args=[self.channel.uuid, "msg", msg2.uuid])

        # admin has `channels.channel_logs` so as_json resolves logs_url to a real path
        response = self.assertGet(
            endpoint_url,
            [self.admin],
            results=[
                {
                    "uuid": str(msg2.uuid),
                    "type": "text",
                    "contact": {"uuid": str(contact2.uuid), "name": "Bob"},
                    "text": "Look at this",
                    "attachments": [{"content_type": "image/jpeg", "url": "https://example.com/a.jpg"}],
                    "labels": [{"uuid": str(label.uuid), "name": "Spam"}],
                    "flow": None,
                    "created_on": matchers.ISODatetime(),
                    "logs_url": msg2_logs_url,
                },
                {
                    "uuid": str(msg1.uuid),
                    "type": "text",
                    "contact": {"uuid": str(contact1.uuid), "name": "Ann"},
                    "text": "Hello there",
                    "attachments": [],
                    "labels": [],
                    "flow": None,
                    "created_on": matchers.ISODatetime(),
                    "logs_url": msg1_logs_url,
                },
            ],
        )

        # responses say how they're paginated so the list UI knows a single page of a cursor list isn't page one of a
        # page-numbered one - the two are otherwise indistinguishable when everything fits on one page
        self.assertEqual("cursor", response.json()["paged_by"])

        # editor lacks `channels.channel_logs` so logs_url is gated to None
        self.assertGet(
            endpoint_url,
            [self.editor],
            results=[
                {
                    "uuid": str(msg2.uuid),
                    "type": "text",
                    "contact": {"uuid": str(contact2.uuid), "name": "Bob"},
                    "text": "Look at this",
                    "attachments": [{"content_type": "image/jpeg", "url": "https://example.com/a.jpg"}],
                    "labels": [{"uuid": str(label.uuid), "name": "Spam"}],
                    "flow": None,
                    "created_on": matchers.ISODatetime(),
                    "logs_url": None,
                },
                {
                    "uuid": str(msg1.uuid),
                    "type": "text",
                    "contact": {"uuid": str(contact1.uuid), "name": "Ann"},
                    "text": "Hello there",
                    "attachments": [],
                    "labels": [],
                    "flow": None,
                    "created_on": matchers.ISODatetime(),
                    "logs_url": None,
                },
            ],
        )

        # backdated past the channel-log retention window: logs_url is gated to None even for admin.
        # `created_on` is passed at insert time because a DB trigger forbids changing it after the fact.
        old_msg = self.create_incoming_msg(contact1, "Older", created_on=timezone.now() - timedelta(days=30))
        response = self.assertGet(endpoint_url + f"?search={old_msg.text}", [self.admin], results=[old_msg])
        self.assertIsNone(response.json()["results"][0]["logs_url"])

        # inactive channel: logs_url is gated to None
        live_msg = self.create_incoming_msg(contact1, "Liveone")
        self.channel.is_active = False
        self.channel.save(update_fields=("is_active",))
        try:
            response = self.assertGet(endpoint_url + f"?search={live_msg.text}", [self.admin], results=[live_msg])
            self.assertIsNone(response.json()["results"][0]["logs_url"])
        finally:
            self.channel.is_active = True
            self.channel.save(update_fields=("is_active",))

        # anonymous org with an unnamed contact: as_json returns the masked ref (not the urn) for the contact name
        anon_contact = self.create_contact("", phone="+1234567099")
        anon_msg = self.create_incoming_msg(anon_contact, "Anonymous")
        with self.anonymous(self.org):
            response = self.assertGet(endpoint_url + f"?search={anon_msg.text}", [self.admin], results=[anon_msg])
            masked_name = response.json()["results"][0]["contact"]["name"]
            self.assertNotIn("1234567099", masked_name)
            self.assertEqual(anon_contact.ref, masked_name)

        # can select a different folder
        self.assertGet(endpoint_url + "?folder=archived", [self.admin], results=[archived])

        # an unknown folder returns nothing
        self.assertGet(endpoint_url + "?folder=nope", [self.admin], results=[])

        # ?folder=sent is ordered by creation like the other folders, not by sent_on
        sent_old = self.create_outgoing_msg(contact1, "Old reply", sent_on=timezone.now() - timedelta(minutes=5))
        sent_new = self.create_outgoing_msg(contact1, "Newer reply", sent_on=timezone.now() - timedelta(hours=2))
        self.assertGet(endpoint_url + "?folder=sent", [self.admin], results=[sent_new, sent_old])

        # ?label=<uuid> filters to that label's messages, whatever folder they're in
        self.assertGet(endpoint_url + f"?label={label.uuid}", [self.admin], results=[archived, msg2])

        # a label belonging to another org isn't visible
        other_label = self.create_label("Other", org=self.org2)
        self.assertGet(endpoint_url + f"?label={other_label.uuid}", [self.admin], results=[])

        # an unknown or malformed label uuid returns nothing
        self.assertGet(endpoint_url + f"?label={contact1.uuid}", [self.admin], results=[])
        self.assertGet(endpoint_url + "?label=foo", [self.admin], results=[])

        # can search by message text or contact name
        response = self.assertGet(endpoint_url + "?search=hello", [self.admin], results=[msg1])
        # searched responses also carry a total `count` of matches so the list UI can show "N results"
        self.assertEqual(1, response.json()["count"])
        response = self.assertGet(endpoint_url + "?search=bob", [self.admin], results=[msg2])
        self.assertEqual(1, response.json()["count"])

        # search is rejected with 413 if it exceeds the legacy 1000-char cap (matches BaseListView.search_max_length)
        self.login(self.admin)
        response = self.client.get(endpoint_url + "?search=" + "x" * 1001)
        self.assertEqual(413, response.status_code)

        # search is restricted to the last 90 days; unfiltered listing below still includes the backdated message
        ancient = self.create_incoming_msg(contact1, "ancient", created_on=timezone.now() - timedelta(days=120))
        self.assertGet(endpoint_url + f"?search={ancient.text}", [self.admin], results=[])

        # unfiltered listings carry the folder's cheap pre-calculated count (not a COUNT(*) on the messages table)
        # so the list UI can show "N of Total"; ordering is `-created_on, -id`: old_msg is backdated 30 days,
        # ancient 120 days, so they sort last
        response = self.assertGet(
            endpoint_url, [self.admin], results=[anon_msg, live_msg, msg2, msg1, old_msg, ancient]
        )
        self.assertEqual(6, response.json()["count"])

        # honor `?page_size=` so the list UI can request a page sized to its viewport
        msg3 = self.create_incoming_msg(contact1, "Three")
        msg4 = self.create_incoming_msg(contact1, "Four")
        response = self.assertGet(endpoint_url + "?page_size=2", [self.admin], results=[msg4, msg3])
        self.assertEqual(2, len(response.json()["results"]))
        # there should be a `next` cursor since we capped at 2 of 4
        self.assertIsNotNone(response.json()["next"])

    @mock_mailroom
    def test_contacts(self, mr_mocks):
        endpoint_url = reverse("api.internal.contacts") + ".json"

        # anonymous users can't read; agents hold the contacts.contact_list api perm (as for /api/v2/contacts)
        self.assertGetNotPermitted(endpoint_url, [None])
        self.assertPostNotPermitted(endpoint_url, [None])
        self.assertDeleteNotAllowed(endpoint_url)

        joe = self.create_contact("Joe", phone="+1234567001", fields={"gender": "male"})
        frank = self.create_contact("Frank", phone="+1234567002", fields={"gender": "female"})
        bob = self.create_contact("Bob", phone="+1234567003")
        bob.block(self.admin)

        # default folder is `active`, newest first (DB path, no mailroom needed)
        self.assertGet(endpoint_url, [self.editor, self.admin], results=[frank, joe])
        self.assertGet(endpoint_url + "?folder=active", [self.admin], results=[frank, joe])

        # the unsearched DB path takes its total from the precomputed ContactGroupCount (via get_member_count) rather
        # than a full COUNT(*) over the membership — this is what keeps the new list as fast as the legacy view on
        # large groups. Patch get_member_count to a sentinel and confirm the response `count` reflects it.
        with patch.object(ContactGroup, "get_member_count", return_value=12345) as mock_count:
            self.assertGet(endpoint_url, [self.admin], raw=lambda data: data["count"] == 12345)
            mock_count.assert_called()

        # other status folders
        self.assertGet(endpoint_url + "?folder=blocked", [self.admin], results=[bob])
        self.assertGet(endpoint_url + "?folder=stopped", [self.admin], results=[])

        # an unknown folder yields no contacts
        self.assertGet(endpoint_url + "?folder=nope", [self.admin], results=[])

        # a specific group can be selected by uuid; a malformed group yields no contacts
        group = self.create_group("Crew", contacts=[joe])
        self.assertGet(endpoint_url + f"?group={group.uuid}", [self.admin], results=[joe])
        self.assertGet(endpoint_url + "?group=foo", [self.admin], results=[])

        # each row carries its group memberships so the component can pre-check the group dropdown
        def check_groups(data):
            return data["results"][0]["groups"] == [{"uuid": str(group.uuid), "name": "Crew"}]

        self.assertGet(endpoint_url + f"?group={group.uuid}", [self.admin], raw=check_groups)

        # each row carries the columns the component renders: name, primary urn (as scheme + display), featured field
        # values, last seen; the ref is an anon-only key
        def check_shape(data):
            first = data["results"][0]
            return (
                first["uuid"] == str(frank.uuid)
                and first["name"] == "Frank"
                and first["fields"]["gender"] == "female"
                and "last_seen_on" in first
                and first["urn"] == {"scheme": "tel", "display": "1234567002"}
                and "ref" not in first
            )

        self.assertGet(endpoint_url, [self.admin], raw=check_shape)

        # anon orgs get the contact ref as its own key, and a masked urn display
        with self.anonymous(self.org):
            response = self.assertGet(endpoint_url, [self.admin], results=[frank, joe])
            first = response.json()["results"][0]
            self.assertEqual(frank.ref, first["ref"])
            self.assertEqual({"scheme": "tel", "display": "********"}, first["urn"])

        # searching goes through mailroom (ES), which returns the ordered window plus a total
        mr_mocks.contact_search("gender = male", contacts=[joe], total=1)
        self.assertGet(endpoint_url + "?search=gender+%3D+male", [self.admin], results=[joe])

        # the response echoes mailroom's parsed/normalized query (e.g. "age > 50" → "fields.age > 50") so the
        # component can rewrite its search box to match what the results reflect
        mr_mocks.contact_search("age > 50", cleaned="fields.age > 50", contacts=[joe], total=1)
        self.assertGet(
            endpoint_url + "?search=age+%3E+50",
            [self.admin],
            raw=lambda data: data["query"] == "fields.age > 50",
        )

        # the unsearched DB path carries no parsed query
        self.assertGet(endpoint_url, [self.admin], raw=lambda data: "query" not in data)

        # the component prefixes its custom-field sort keys with `field:`; mailroom gets the bare key
        mr_mocks.contact_search("", contacts=[joe, frank])
        self.assertGet(endpoint_url + "?sort=-field:gender", [self.admin], results=[joe, frank])
        self.assertEqual(
            call(self.org, self.org.active_contacts_group, "", sort="-gender", offset=0, limit=50),
            mr_mocks.calls["contact_search"][-1],
        )

        # an invalid query keeps a list-shaped (empty) response rather than erroring
        mr_mocks.exception(mailroom.QueryValidationException("bad", "syntax"))
        self.login(self.admin)
        response = self.client.get(endpoint_url + "?search=(((")
        self.assertEqual(200, response.status_code)
        self.assertEqual([], response.json()["results"])
        self.assertEqual(0, response.json()["count"])

        # an over-long search query is rejected
        response = self.client.get(endpoint_url + "?search=" + ("x" * 10001))
        self.assertEqual(413, response.status_code)

        # paging past the 200th page short-circuits to an empty, list-shaped response (ES deep-paging guard)
        response = self.client.get(endpoint_url + "?page=201")
        self.assertEqual(200, response.status_code)
        self.assertEqual([], response.json()["results"])
        self.assertEqual(0, response.json()["count"])

        # a non-integer page is handled cleanly: the page-guard falls back to page 1, then DRF 404s the unknown page
        # (rather than the guard itself raising a ValueError)
        self.login(self.admin)
        self.assertEqual(404, self.client.get(endpoint_url + "?page=abc").status_code)

        # a non-integer page_size falls back to the default page size (matching DRF's pagination)
        mr_mocks.contact_search("", contacts=[joe, frank])
        self.assertGet(endpoint_url + "?sort=-field:gender&page_size=abc", [self.admin], results=[joe, frank])
        self.assertEqual(50, mr_mocks.calls["contact_search"][-1].kwargs["limit"])

        # ...as does a non-positive page_size
        mr_mocks.contact_search("", contacts=[joe, frank])
        self.assertGet(endpoint_url + "?sort=-field:gender&page_size=0", [self.admin], results=[joe, frank])
        self.assertEqual(50, mr_mocks.calls["contact_search"][-1].kwargs["limit"])

    def test_contacts_update(self):
        endpoint_url = reverse("api.internal.contacts") + ".json"

        joe = self.create_contact("Joe", urns=["tel:+250788111111", "facebook:123456"])
        other_org_contact = self.create_contact("Fred", phone="+250788666666", org=self.org2)

        # a uuid param is required - contacts can never be created here, unlike on /api/v2/contacts
        self.assertPost(endpoint_url, self.editor, {"name": "X"}, errors={None: "URL must contain uuid parameter."})

        # can't update contacts in other orgs
        self.assertPost(endpoint_url + f"?uuid={other_org_contact.uuid}", self.editor, {"name": "X"}, status=404)

        # update name and language
        response = self.assertPost(
            endpoint_url + f"?uuid={joe.uuid}", self.editor, {"name": "Joseph", "language": "fra"}
        )
        joe.refresh_from_db()
        self.assertEqual("Joseph", joe.name)
        self.assertEqual("fra", joe.language)

        # the response is the editor's read shape: urns come back expanded and in priority order
        self.assertEqual(str(joe.uuid), response.json()["uuid"])
        self.assertEqual("active", response.json()["status"])
        self.assertEqual(
            ["tel:+250788111111", "facebook:123456"],
            [f"{urn['scheme']}:{urn['path']}" for urn in response.json()["urns"]],
        )
        self.assertIsNotNone(response.json()["urns"][0]["channel"])

        # reordering urns is reflected in the response
        response = self.assertPost(
            endpoint_url + f"?uuid={joe.uuid}", self.editor, {"urns": ["facebook:123456", "tel:+250788111111"]}
        )
        self.assertEqual(
            ["facebook:123456", "tel:+250788111111"],
            [f"{urn['scheme']}:{urn['path']}" for urn in response.json()["urns"]],
        )

        group = self.create_group("Testers", contacts=[])

        # status can be updated but groups submitted alongside a deactivation are dropped because mailroom
        # removes non-active contacts from all groups
        self.assertPost(endpoint_url + f"?uuid={joe.uuid}", self.editor, {"status": "blocked", "groups": [group.uuid]})
        joe.refresh_from_db()
        self.assertEqual(Contact.STATUS_BLOCKED, joe.status)
        self.assertEqual(set(), set(joe.get_groups(manual_only=True)))

        # groups can't be added to a non-active contact that isn't being restored
        self.assertPost(
            endpoint_url + f"?uuid={joe.uuid}",
            self.editor,
            {"groups": [group.uuid]},
            errors={"groups": "Non-active contacts can't be added to groups"},
        )

        # but groups can be submitted alongside a restore to active since the restore is applied first
        self.assertPost(endpoint_url + f"?uuid={joe.uuid}", self.editor, {"status": "active", "groups": [group.uuid]})
        joe.refresh_from_db()
        self.assertEqual(Contact.STATUS_ACTIVE, joe.status)
        self.assertEqual({group}, set(joe.get_groups(manual_only=True)))

        self.assertPost(endpoint_url + f"?uuid={joe.uuid}", self.editor, {"status": "stopped"})
        joe.refresh_from_db()
        self.assertEqual(Contact.STATUS_STOPPED, joe.status)

        self.assertPost(endpoint_url + f"?uuid={joe.uuid}", self.editor, {"status": "archived"})
        joe.refresh_from_db()
        self.assertEqual(Contact.STATUS_ARCHIVED, joe.status)

        self.assertPost(endpoint_url + f"?uuid={joe.uuid}", self.editor, {"status": "active"})
        joe.refresh_from_db()
        self.assertEqual(Contact.STATUS_ACTIVE, joe.status)

        # an invalid status is rejected
        self.assertPost(
            endpoint_url + f"?uuid={joe.uuid}",
            self.editor,
            {"status": "sleeping"},
            errors={"status": '"sleeping" is not a valid choice.'},
        )

        # fields can be updated, subject to the same agent access rules as the public API
        self.create_field("nickname", "Nickname", agent_access=ContactField.ACCESS_VIEW)
        self.assertPost(endpoint_url + f"?uuid={joe.uuid}", self.editor, {"fields": {"nickname": "Jo"}})
        joe.refresh_from_db()
        self.assertEqual("Jo", joe.get_field_value(self.org.fields.get(key="nickname")))
        self.assertPost(
            endpoint_url + f"?uuid={joe.uuid}",
            self.agent,
            {"fields": {"nickname": "Joey"}},
            errors={"fields": "Editing of 'nickname' values disallowed for current user."},
        )

        # deleted contacts can't be modified
        deleted = self.create_contact("Del", phone="+250788000000")
        deleted.release(self.admin)
        self.assertPost(
            endpoint_url + f"?uuid={deleted.uuid}",
            self.editor,
            {"name": "X"},
            errors={"non_field_errors": "Deleted contacts can't be modified."},
        )

    def test_campaigns(self):
        endpoint_url = reverse("api.internal.campaigns") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        registered = self.create_field("registered", "Registered", value_type=ContactField.TYPE_DATETIME)
        flow = self.create_flow("Reminder Flow")

        ann = self.create_contact("Ann", phone="+1234567111")
        bob = self.create_contact("Bob", phone="+1234567222")
        mothers = self.create_group("Mothers", contacts=[ann, bob])
        farmers = self.create_group("Farmers", contacts=[])

        campaign1 = Campaign.create(self.org, self.admin, "Welcomes", mothers)
        for offset in (1, 2):
            CampaignEvent.create_flow_event(
                self.org, self.admin, campaign1, registered, offset=offset, unit="W", flow=flow, delivery_hour="13"
            )
        campaign2 = Campaign.create(self.org, self.admin, "Reminders", farmers)
        CampaignEvent.create_flow_event(
            self.org, self.admin, campaign2, registered, offset=1, unit="D", flow=flow, delivery_hour="9"
        )
        campaign3 = Campaign.create(self.org, self.admin, "Follow Ups", mothers)
        campaign3.archive(self.admin)

        # and a campaign in another org that should never appear
        group2 = self.create_group("Others", contacts=[], org=self.org2)
        Campaign.create(self.org2, self.org2.get_admins().first(), "Other Org", group2)

        # the count getters compute directly when not bulk-prefetched by the endpoint
        self.assertEqual(2, campaign1.get_event_count())
        self.assertEqual(2, campaign1.get_contact_count())

        # default folder is `active`, most recently modified first
        self.assertGet(endpoint_url, [self.editor, self.admin], results=[campaign2, campaign1])
        self.assertGet(endpoint_url + "?folder=active", [self.admin], results=[campaign2, campaign1])

        # archived campaigns live in their own folder
        self.assertGet(endpoint_url + "?folder=archived", [self.admin], results=[campaign3])

        # search filters by campaign name or group name
        self.assertGet(endpoint_url + "?search=wel", [self.admin], results=[campaign1])
        self.assertGet(endpoint_url + "?search=farm", [self.admin], results=[campaign2])

        # each row carries the columns the component renders
        def check_shape(data):
            first = [r for r in data["results"] if r["uuid"] == str(campaign1.uuid)][0]
            self.assertEqual("Welcomes", first["name"])
            self.assertEqual({"uuid": str(mothers.uuid), "name": "Mothers"}, first["group"])
            self.assertEqual(2, first["events"])
            self.assertEqual(2, first["contacts"])
            self.assertEqual(campaign1.modified_on.isoformat(), first["modified_on"])

            second = [r for r in data["results"] if r["uuid"] == str(campaign2.uuid)][0]
            self.assertEqual(1, second["events"])
            self.assertEqual(0, second["contacts"])
            return True

        self.assertGet(endpoint_url, [self.admin], raw=check_shape)

        # sortable by name, event count, group-member count and modified on
        self.assertGet(endpoint_url + "?sort=name", [self.admin], results=[campaign2, campaign1])
        self.assertGet(endpoint_url + "?sort=-name", [self.admin], results=[campaign1, campaign2])
        self.assertGet(endpoint_url + "?sort=events", [self.admin], results=[campaign2, campaign1])
        self.assertGet(endpoint_url + "?sort=-events", [self.admin], results=[campaign1, campaign2])
        self.assertGet(endpoint_url + "?sort=contacts", [self.admin], results=[campaign2, campaign1])
        self.assertGet(endpoint_url + "?sort=-contacts", [self.admin], results=[campaign1, campaign2])
        self.assertGet(endpoint_url + "?sort=modified_on", [self.admin], results=[campaign1, campaign2])
        self.assertGet(endpoint_url + "?sort=-modified_on", [self.admin], results=[campaign2, campaign1])

        # an unknown sort falls back to the default ordering
        self.assertGet(endpoint_url + "?sort=nope", [self.admin], results=[campaign2, campaign1])

        # an over-long search query is rejected
        self.login(self.admin)
        response = self.client.get(endpoint_url + "?search=" + ("x" * 1001))
        self.assertEqual(413, response.status_code)

    def test_flows(self):
        endpoint_url = reverse("api.internal.flows") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        flow1 = self.create_flow("Apple")
        flow2 = self.create_flow("Banana", flow_type=Flow.TYPE_VOICE)
        flow3 = self.create_flow("Cherry")
        flow3.archive(self.admin, interrupt_sessions=False)

        label = FlowLabel.create(self.org, self.admin, "Important")
        label.toggle_label([flow1], add=True)

        # give flow1 some runs (3 completed, 1 waiting, 1 active, 1 expired) and flow2 some waiting runs
        for scope, count in (("status:C", 3), ("status:W", 1), ("status:A", 1), ("status:X", 1)):
            flow1.counts.create(scope=scope, count=count)
        flow2.counts.create(scope="status:W", count=5)

        # and some recent engagement for the sparkline
        today = timezone.now().date()
        flow1.counts.create(scope=f"msgsin:date:{today - timedelta(days=1)}", count=3)
        flow1.counts.create(scope=f"msgsin:date:{today}", count=5)

        # without the endpoint's bulk prefetch, the series reads the counts directly
        self.assertEqual([3, 5], flow1.get_activity_series()[-2:])

        # default folder is `active`, most recently saved first
        response = self.assertGet(endpoint_url, [self.editor, self.admin], results=[flow2, flow1])
        self.assertEqual("page", response.json()["paged_by"])  # unlike messages, flows are page-numbered

        self.assertGet(endpoint_url + "?folder=active", [self.admin], results=[flow2, flow1])

        # archived flows live in their own folder, newest first
        self.assertGet(endpoint_url + "?folder=archived", [self.admin], results=[flow3])

        # a label can be selected by uuid; an unknown or malformed label yields no flows
        self.assertGet(endpoint_url + f"?label={label.uuid}", [self.admin], results=[flow1])
        self.assertGet(endpoint_url + f"?label={uuid4()}", [self.admin], results=[])
        self.assertGet(endpoint_url + "?label=foo", [self.admin], results=[])

        # search filters by name
        self.assertGet(endpoint_url + "?search=ban", [self.admin], results=[flow2])

        # each row carries the columns the component renders
        def check_shape(data):
            first = [r for r in data["results"] if r["uuid"] == str(flow1.uuid)][0]
            self.assertEqual("Apple", first["name"])
            self.assertEqual("message", first["type"])
            self.assertEqual([{"uuid": str(label.uuid), "name": "Important"}], first["labels"])
            self.assertEqual(6, first["runs"])
            self.assertEqual(2, first["ongoing"])
            self.assertEqual(0.5, first["completion"])
            self.assertEqual(Flow.ACTIVITY_SERIES_DAYS, len(first["activity"]))
            self.assertEqual([3, 5], first["activity"][-2:])

            second = [r for r in data["results"] if r["uuid"] == str(flow2.uuid)][0]
            self.assertEqual("voice", second["type"])
            # no engagement in the window means no sparkline
            self.assertEqual([], second["activity"])
            return True

        self.assertGet(endpoint_url, [self.admin], raw=check_shape)

        # sortable by name and by run counts (flow1 leads on total runs, flow2 on ongoing)
        self.assertGet(endpoint_url + "?sort=name", [self.admin], results=[flow1, flow2])
        self.assertGet(endpoint_url + "?sort=-name", [self.admin], results=[flow2, flow1])
        self.assertGet(endpoint_url + "?sort=-runs", [self.admin], results=[flow1, flow2])
        self.assertGet(endpoint_url + "?sort=runs", [self.admin], results=[flow2, flow1])
        self.assertGet(endpoint_url + "?sort=-ongoing", [self.admin], results=[flow2, flow1])

        # an unknown sort falls back to the folder's default ordering
        self.assertGet(endpoint_url + "?sort=nope", [self.admin], results=[flow2, flow1])

        # an over-long search query is rejected
        self.login(self.admin)
        response = self.client.get(endpoint_url + "?search=" + ("x" * 1001))
        self.assertEqual(413, response.status_code)

    def test_flow_labels(self):
        endpoint_url = reverse("api.internal.flow_labels") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        label1 = FlowLabel.create(self.org, self.admin, "Important")
        label2 = FlowLabel.create(self.org, self.admin, "Spam")
        FlowLabel.create(self.org2, self.admin2, "Other Org")

        self.assertGet(
            endpoint_url,
            [self.editor, self.admin],
            results=[
                {"uuid": str(label1.uuid), "name": "Important"},
                {"uuid": str(label2.uuid), "name": "Spam"},
            ],
        )

    def test_notifications(self):
        endpoint_url = reverse("api.internal.notifications") + ".json"

        self.assertPostNotAllowed(endpoint_url)

        # simulate an export finishing
        export1 = ContactExport.create(self.org, self.admin)
        ExportFinishedNotificationType.create(export1)

        # simulate an export by another user finishing
        export2 = TicketExport.create(self.org, self.editor, start_date=timezone.now(), end_date=timezone.now())
        ExportFinishedNotificationType.create(export2)

        # and org being suspended
        self.org.suspend()

        export1_notification = export1.notifications.get()
        export2_notification = export2.notifications.get()
        suspended_notification = self.admin.notifications.get(notification_type="incident:started")

        self.assertGet(
            endpoint_url,
            [self.admin],
            results=[
                {
                    "type": "incident:started",
                    "created_on": matchers.ISODatetime(),
                    "url": f"/notification/read/{suspended_notification.id}/",
                    "is_seen": False,
                    "incident": {
                        "type": "org:suspended",
                        "started_on": matchers.ISODatetime(),
                        "ended_on": None,
                    },
                },
                {
                    "type": "export:finished",
                    "created_on": matchers.ISODatetime(),
                    "url": f"/notification/read/{export1_notification.id}/",
                    "is_seen": False,
                    "export": {"type": "contact", "num_records": None},
                },
            ],
        )

        # notifications are user specific
        self.assertGet(
            endpoint_url,
            [self.editor],
            results=[
                {
                    "type": "export:finished",
                    "created_on": matchers.ISODatetime(),
                    "url": f"/notification/read/{export2_notification.id}/",
                    "is_seen": False,
                    "export": {"type": "ticket", "num_records": None},
                },
            ],
        )

        # a DELETE marks all notifications as seen
        self.assertDelete(endpoint_url, self.admin)

        self.assertEqual(0, self.admin.notifications.filter(is_seen=False).count())
        self.assertEqual(2, self.admin.notifications.filter(is_seen=True).count())
        self.assertEqual(1, self.editor.notifications.filter(is_seen=False).count())

    def test_assets(self):
        endpoint_url = reverse("api.internal.assets") + ".json"

        self.assertPostNotPermitted(endpoint_url, [None, self.agent])
        self.assertGetNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        flow = self.create_flow("Welcome")
        group = self.create_group("Customers")
        contact = self.create_contact("Alice", phone="+1234567001")
        field = self.create_field("favorite_color", "Favorite Color")
        global_ = Global.get_or_create(self.org, self.admin, "company_name", "Company Name", "Acme")
        label = FlowLabel.create(self.org, self.admin, "Important")
        llm = LLM.create(self.org, self.admin, OpenAIType(), "gpt-4o", "GPT-4", {})
        template = Template.get_or_create(self.org, "welcome_message")
        topic = Topic.create(self.org, self.admin, "Support")
        other_flow = self.create_flow("Other Org", org=self.org2)

        payload = {
            "channel": [str(self.channel.uuid)],
            "flow": [str(flow.uuid), str(other_flow.uuid)],
            "group": [str(group.uuid)],
            "label": [str(label.uuid)],
            "llm": [str(llm.uuid)],
            "template": [str(template.uuid)],
            "topic": [str(topic.uuid)],
            "contact": [str(contact.uuid)],
            "user": [str(self.admin.uuid)],
            "field": [field.key],
            "global": [global_.key],
        }
        expected = [
            {"type": "channel", "uuid": str(self.channel.uuid), "name": self.channel.name},
            {"type": "flow", "uuid": str(flow.uuid), "name": "Welcome"},
            {"type": "group", "uuid": str(group.uuid), "name": "Customers"},
            {"type": "label", "uuid": str(label.uuid), "name": "Important"},
            {"type": "llm", "uuid": str(llm.uuid), "name": "GPT-4"},
            {"type": "template", "uuid": str(template.uuid), "name": "welcome_message"},
            {"type": "topic", "uuid": str(topic.uuid), "name": "Support"},
            {"type": "contact", "uuid": str(contact.uuid), "name": "Alice"},
            {"type": "user", "uuid": str(self.admin.uuid), "name": self.admin.name},
            {"type": "field", "key": "favorite_color", "name": "Favorite Color"},
            {"type": "global", "key": "company_name", "name": "Company Name"},
        ]
        for user in [self.editor, self.admin]:
            with self.mockReadOnly():
                response = self._postJSON(endpoint_url, user, payload)
            self.assertEqual(200, response.status_code)
            self.assertEqual(expected, response.json()["results"])

        # staff servicing the org can also resolve names - this endpoint's POSTs are reads, so the
        # GET-only rule for servicing staff doesn't apply
        self.login(self.customer_support, choose_org=self.org)
        with self.mockReadOnly(assert_models={Flow}):
            response = self.client.post(
                endpoint_url,
                {"flow": [str(flow.uuid)]},
                content_type="application/json",
                HTTP_X_FORWARDED_HTTPS="https",
            )
        self.assertEqual(200, response.status_code)
        self.assertEqual([{"type": "flow", "uuid": str(flow.uuid), "name": "Welcome"}], response.json()["results"])
        self.client.logout()

        # a payload of a single type only queries for that type, and duplicate references are only resolved once
        with self.mockReadOnly(assert_models={Flow}):
            response = self._postJSON(endpoint_url, self.editor, {"flow": [str(flow.uuid), str(flow.uuid)]})

        self.assertEqual(200, response.status_code)
        self.assertEqual([{"type": "flow", "uuid": str(flow.uuid), "name": "Welcome"}], response.json()["results"])

        # db maintained system groups aren't resolvable as flows never reference them
        active = self.org.groups.get(group_type=ContactGroup.TYPE_DB_ACTIVE)

        with self.mockReadOnly(assert_models={ContactGroup}):
            response = self._postJSON(endpoint_url, self.editor, {"group": [str(active.uuid)]})

        self.assertEqual(200, response.status_code)
        self.assertEqual([], response.json()["results"])

        # users without a name fall back to their email like they do everywhere else
        nameless = self.create_user("nameless@textit.com")
        self.org.add_user(nameless, OrgRole.EDITOR)

        with self.mockReadOnly():
            response = self._postJSON(endpoint_url, self.editor, {"user": [str(nameless.uuid)]})

        self.assertEqual(200, response.status_code)
        self.assertEqual(
            [{"type": "user", "uuid": str(nameless.uuid), "name": "nameless@textit.com"}], response.json()["results"]
        )

        # a contact without a name resolves to their formatted URN
        nameless_contact = self.create_contact(phone="+12065551212")

        with self.mockReadOnly(assert_models={Contact, ContactURN}):
            response = self._postJSON(endpoint_url, self.editor, {"contact": [str(nameless_contact.uuid)]})

        self.assertEqual(200, response.status_code)
        self.assertEqual(
            [{"type": "contact", "uuid": str(nameless_contact.uuid), "name": "(206) 555-1212"}],
            response.json()["results"],
        )

        # in an anon workspace a named contact still resolves to their name but a nameless one to their obfuscated ref
        self.org.is_anon = True
        self.org.save(update_fields=("is_anon",))

        with self.mockReadOnly():
            response = self._postJSON(
                endpoint_url, self.editor, {"contact": [str(contact.uuid), str(nameless_contact.uuid)]}
            )

        self.assertEqual(200, response.status_code)
        self.assertEqual(
            [
                {"type": "contact", "uuid": str(contact.uuid), "name": "Alice"},
                {"type": "contact", "uuid": str(nameless_contact.uuid), "name": nameless_contact.ref},
            ],
            response.json()["results"],
        )

        self.org.is_anon = False
        self.org.save(update_fields=("is_anon",))

        # exactly the maximum number of references is allowed
        with self.mockReadOnly(assert_models={ContactField}):
            response = self._postJSON(endpoint_url, self.editor, {"field": [f"field_{i}" for i in range(100)]})

        self.assertEqual(200, response.status_code)
        self.assertEqual([], response.json()["results"])

        response = self._postJSON(endpoint_url, self.editor, {"flow": ["not-a-uuid"]})
        self.assertEqual(400, response.status_code)
        self.assertIn("badly formed hexadecimal UUID string", response.json()["detail"])

        response = self._postJSON(endpoint_url, self.editor, {"field": [f"field_{i}" for i in range(101)]})
        self.assertEqual(400, response.status_code)
        self.assertEqual("A maximum of 100 assets can be resolved at once.", response.json()["detail"])

        response = self._postJSON(endpoint_url, self.editor, {"unknown": ["value"]})
        self.assertEqual(400, response.status_code)
        self.assertEqual("Unsupported asset type: unknown.", response.json()["detail"])

        response = self._postJSON(endpoint_url, self.editor, [str(flow.uuid)])
        self.assertEqual(400, response.status_code)
        self.assertEqual(
            "Payload must be an object mapping asset types to lists of identifiers.", response.json()["detail"]
        )

        for bad_values in (str(flow.uuid), [1]):
            response = self._postJSON(endpoint_url, self.editor, {"flow": bad_values})
            self.assertEqual(400, response.status_code)
            self.assertEqual("Asset type 'flow' must be a list of identifiers.", response.json()["detail"])

    def test_orgs(self):
        endpoint_url = reverse("api.internal.orgs") + ".json"
        self.assertGet(
            endpoint_url,
            [self.agent, self.editor, self.admin],
            results=[{"id": self.org.id, "name": "Nyaruka"}],
            num_queries=NUM_BASE_QUERIES + 1,
        )

        # group admins see the orgs of their groups
        group_admin = self.create_user("gad@textit.com")
        self.create_admin_group("Global Admins", orgs=[self.org, self.org2], users=[group_admin])
        self.login(group_admin, choose_org=self.org)

        response = self.client.get(endpoint_url, content_type="application/json", HTTP_X_FORWARDED_HTTPS="https")
        self.assertEqual({self.org.id, self.org2.id}, {r["id"] for r in response.json()["results"]})

    def test_articles(self):
        endpoint_url = reverse("api.internal.articles") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        helpdesk = self.org.knowledge.get(knowledge_type=Knowledge.TYPE_HELPDESK)
        flows = Article.create(helpdesk, self.admin, "Flows")
        nodes = Article.create(helpdesk, self.admin, "Nodes", parent=flows)
        contacts = Article.create(helpdesk, self.admin, "Contacts")
        released = Article.create(helpdesk, self.admin, "Old", parent=flows)
        released.release(self.admin)
        flows.publish(self.admin)

        Article.create(self.org2.knowledge.get(knowledge_type=Knowledge.TYPE_HELPDESK), self.admin2, "Other")

        # the helpdesk is part of the agents feature, so without it there's nothing to serve
        self.assertGet(endpoint_url, [self.admin], results=[])

        self.org.features = [Org.FEATURE_AGENTS]
        self.org.save(update_fields=("features",))

        # depth first, with the parent each article is shown under, and released ones omitted
        self.assertGet(
            endpoint_url,
            [self.editor, self.admin],
            results=[
                {
                    "uuid": str(flows.uuid),
                    "title": "Flows",
                    "status": "published",
                    "parent": None,
                    "depth": 0,
                    "modified_on": matchers.ISODatetime(),
                },
                {
                    "uuid": str(nodes.uuid),
                    "title": "Nodes",
                    "status": "draft",
                    "parent": str(flows.uuid),
                    "depth": 1,
                    "modified_on": matchers.ISODatetime(),
                },
                {
                    "uuid": str(contacts.uuid),
                    "title": "Contacts",
                    "status": "draft",
                    "parent": None,
                    "depth": 0,
                    "modified_on": matchers.ISODatetime(),
                },
            ],
            num_queries=NUM_BASE_QUERIES + 2,
        )

        # an org whose helpdesk has somehow gone is served an empty tree rather than an error
        self.org.knowledge.filter(knowledge_type=Knowledge.TYPE_HELPDESK).update(is_active=False)

        self.assertGet(endpoint_url, [self.admin], results=[])

    def test_shortcuts(self):
        endpoint_url = reverse("api.internal.shortcuts") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        shortcut1 = Shortcut.create(self.org, self.admin, "Planes", "Planes are...")
        shortcut2 = Shortcut.create(self.org, self.admin, "Trains", "Trains are...")
        deleted = Shortcut.create(self.org, self.admin, "Deleted", "Deleted shortcut")
        deleted.release(self.admin)
        Shortcut.create(self.org2, self.admin, "Cars", "Other org")

        self.assertGet(
            endpoint_url,
            [self.admin],
            results=[
                {
                    "uuid": str(shortcut2.uuid),
                    "name": "Trains",
                    "text": "Trains are...",
                    "modified_on": matchers.ISODatetime(),
                },
                {
                    "uuid": str(shortcut1.uuid),
                    "name": "Planes",
                    "text": "Planes are...",
                    "modified_on": matchers.ISODatetime(),
                },
            ],
            num_queries=NUM_BASE_QUERIES + 1,
        )

        self.assertGet(
            f"{endpoint_url}?search=trains",
            [self.admin],
            results=[
                {
                    "uuid": str(shortcut2.uuid),
                    "name": "Trains",
                    "text": "Trains are...",
                    "modified_on": matchers.ISODatetime(),
                }
            ],
            num_queries=NUM_BASE_QUERIES + 2,
        )
        self.assertEqual(413, self.client.get(f"{endpoint_url}?search={'x' * 1_001}").status_code)

    def test_templates(self):
        endpoint_url = reverse("api.internal.templates") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        tpl1 = self.create_template(
            "hello",
            [
                TemplateTranslation(
                    channel=self.channel,
                    locale="eng-US",
                    status=TemplateTranslation.STATUS_APPROVED,
                    external_id="1234",
                    external_locale="en_US",
                    namespace="foo_namespace",
                    components=[
                        {
                            "name": "body",
                            "type": "body/text",
                            "content": "Hi {{1}}",
                            "variables": {"1": 0},
                        }
                    ],
                    variables=[{"type": "text"}],
                ),
                TemplateTranslation(
                    channel=self.channel,
                    locale="fra-FR",
                    status=TemplateTranslation.STATUS_PENDING,
                    external_id="5678",
                    external_locale="fr_FR",
                    namespace="foo_namespace",
                    components=[
                        {
                            "name": "body",
                            "type": "body/text",
                            "content": "Bonjour {{1}}",
                            "variables": {"1": 0},
                        }
                    ],
                    variables=[{"type": "text"}],
                ),
            ],
        )
        tpl2 = self.create_template(
            "goodbye",
            [
                TemplateTranslation(
                    channel=self.channel,
                    locale="eng-US",
                    status=TemplateTranslation.STATUS_PENDING,
                    external_id="6789",
                    external_locale="en_US",
                    namespace="foo_namespace",
                    components=[
                        {
                            "name": "body",
                            "type": "body/text",
                            "content": "Goodbye {{1}}",
                            "variables": {"1": 0},
                        }
                    ],
                    variables=[{"type": "text"}],
                )
            ],
        )

        # template on other org to test filtering
        org2channel = self.create_channel("A", "Org2Channel", "123456", country="RW", org=self.org2)
        self.create_template(
            "goodbye",
            [
                TemplateTranslation(
                    channel=org2channel,
                    locale="eng-US",
                    status=TemplateTranslation.STATUS_PENDING,
                    external_id="6789",
                    external_locale="en_US",
                    namespace="foo_namespace",
                    components=[
                        {
                            "name": "body",
                            "type": "body/text",
                            "content": "Goodbye {{1}}",
                            "variables": {"1": 0},
                        }
                    ],
                    variables=[{"type": "text"}],
                )
            ],
            org=self.org2,
        )

        # no filtering
        self.assertGet(
            endpoint_url,
            [self.editor, self.admin],
            results=[
                {
                    "uuid": str(tpl2.uuid),
                    "name": "goodbye",
                    "base_translation": {
                        "channel": {"name": self.channel.name, "uuid": self.channel.uuid},
                        "locale": "eng-US",
                        "namespace": "foo_namespace",
                        "status": "pending",
                        "components": [
                            {
                                "name": "body",
                                "type": "body/text",
                                "content": "Goodbye {{1}}",
                                "variables": {"1": 0},
                            }
                        ],
                        "variables": [{"type": "text"}],
                        "supported": True,
                        "compatible": True,
                    },
                    "created_on": matchers.ISODatetime(),
                    "modified_on": matchers.ISODatetime(),
                },
                {
                    "uuid": str(tpl1.uuid),
                    "name": "hello",
                    "base_translation": {
                        "channel": {"name": self.channel.name, "uuid": self.channel.uuid},
                        "locale": "eng-US",
                        "namespace": "foo_namespace",
                        "status": "approved",
                        "components": [
                            {
                                "name": "body",
                                "type": "body/text",
                                "content": "Hi {{1}}",
                                "variables": {"1": 0},
                            }
                        ],
                        "variables": [{"type": "text"}],
                        "supported": True,
                        "compatible": True,
                    },
                    "created_on": matchers.ISODatetime(),
                    "modified_on": matchers.ISODatetime(),
                },
            ],
            num_queries=NUM_BASE_QUERIES + 3,
        )

    def test_broadcasts(self):
        endpoint_url = reverse("api.internal.broadcasts") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        group = self.create_group("Farmers", contacts=[])
        contact = self.create_contact("Jim", phone="+250788987651")

        bcast1 = self.create_broadcast(
            self.admin,
            {
                "eng": {
                    "text": "Hello everyone",
                    "attachments": ["image/jpeg:http://example.com/cat.jpg"],
                    "quick_replies": ["Yes", "No"],
                }
            },
            groups=[group],
            contacts=[contact],
            exclude=mailroom.Exclusions(in_a_flow=True, not_seen_since_days=90),
        )
        bcast2 = self.create_broadcast(
            self.admin, {"eng": {"text": "Sending still"}}, contacts=[contact], status=Broadcast.STATUS_STARTED
        )

        # scheduled broadcasts live in their own folder, soonest fire first
        bcast3 = self.create_broadcast(
            self.admin,
            {"eng": {"text": "Weekly reminder"}},
            groups=[group],
            schedule=Schedule.create(self.org, timezone.now() + timedelta(days=2), Schedule.REPEAT_DAILY),
        )
        bcast4 = self.create_broadcast(
            self.admin,
            {"eng": {"text": "Sooner reminder"}},
            contacts=[contact],
            schedule=Schedule.create(self.org, timezone.now() + timedelta(days=1), Schedule.REPEAT_WEEKLY),
        )

        # a scheduled broadcast whose (paused) schedule still carries a stale next fire
        paused = Schedule.create(self.org, timezone.now() + timedelta(days=3), Schedule.REPEAT_DAILY)
        paused.is_paused = True
        paused.save(update_fields=("is_paused",))
        bcast5 = self.create_broadcast(
            self.admin, {"eng": {"text": "Paused reminder"}}, contacts=[contact], schedule=paused
        )

        # and a broadcast in another org that should never appear
        other_contact = self.create_contact("Bob", phone="+250788111111", org=self.org2)
        self.create_broadcast(
            self.admin2,
            {"eng": {"text": "Other org"}},
            contacts=[other_contact],
            org=self.org2,
            status=Broadcast.STATUS_PENDING,  # org2 has no channel to create messages with
        )

        # default folder is `sent` (broadcasts without a schedule), newest first
        self.assertGet(endpoint_url, [self.editor, self.admin], results=[bcast2, bcast1])
        self.assertGet(
            endpoint_url + "?folder=sent",
            [self.admin],
            results=[bcast2, bcast1],
            num_queries=NUM_BASE_QUERIES + 5,  # count + broadcasts + 2 M2M prefetches + msg counts
        )
        self.assertGet(endpoint_url + "?sort=created_on", [self.admin], results=[bcast1, bcast2])

        # the scheduled folder orders by next fire
        self.assertGet(endpoint_url + "?folder=scheduled", [self.admin], results=[bcast4, bcast3, bcast5])
        self.assertGet(
            endpoint_url + "?folder=scheduled&sort=-next_fire", [self.admin], results=[bcast5, bcast3, bcast4]
        )

        # created_on is also a valid sort for the scheduled folder
        self.assertGet(
            endpoint_url + "?folder=scheduled&sort=-created_on", [self.admin], results=[bcast5, bcast4, bcast3]
        )

        # search matches the message text inside the translations...
        self.assertGet(endpoint_url + "?search=hello", [self.admin], results=[bcast1])
        self.assertGet(endpoint_url + "?folder=scheduled&search=weekly", [self.admin], results=[bcast3])

        # ...but not the JSON structure around it (keys, language codes)
        self.assertGet(endpoint_url + "?search=quick_replies", [self.admin], results=[])
        self.assertGet(endpoint_url + "?search=eng", [self.admin], results=[])

        # each row carries the columns the component renders
        def check_sent_shape(data):
            row = [r for r in data["results"] if r["uuid"] == str(bcast1.uuid)][0]
            self.assertEqual("completed", row["status"])
            self.assertEqual("Hello everyone", row["text"])
            self.assertEqual(["image/jpeg:http://example.com/cat.jpg"], row["attachments"])
            self.assertEqual(["Yes", "No"], row["quick_replies"])
            self.assertEqual([{"uuid": str(group.uuid), "name": "Farmers"}], row["groups"])
            self.assertEqual([{"uuid": str(contact.uuid), "name": "Jim"}], row["contacts"])
            self.assertEqual(["Not in a flow", "Active in the last 90 days"], row["exclusions"])
            self.assertIsNone(row["schedule"])
            self.assertEqual(1, row["msg_count"])
            self.assertEqual({"total": 1, "started": 1}, row["progress"])
            self.assertEqual("admin@textit.com", row["created_by"])
            return True

        self.assertGet(endpoint_url + "?folder=sent", [self.admin], raw=check_sent_shape)

        # a scheduled row carries the schedule instead of a message count, and a paused schedule's stale
        # next_fire reads as not scheduled
        def check_scheduled_shape(data):
            row = [r for r in data["results"] if r["uuid"] == str(bcast3.uuid)][0]
            self.assertEqual("D", row["schedule"]["repeat_period"])
            self.assertTrue(row["schedule"]["display"].startswith("each day at"))
            self.assertIsNotNone(row["schedule"]["next_fire"])
            self.assertIsNone(row["msg_count"])
            self.assertIsNone(row["progress"])
            paused_row = [r for r in data["results"] if r["uuid"] == str(bcast5.uuid)][0]
            self.assertIsNone(paused_row["schedule"]["next_fire"])
            return True

        self.assertGet(endpoint_url + "?folder=scheduled", [self.admin], raw=check_scheduled_shape)

    def test_triggers(self):
        endpoint_url = reverse("api.internal.triggers") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        flow1 = self.create_flow("Survey")
        flow2 = self.create_flow("Support")
        group1 = self.create_group("Farmers", contacts=[])
        group2 = self.create_group("Staff", contacts=[])
        contact1 = self.create_contact("Jim", phone="+250788987651")

        trigger1 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow1,
            keywords=["join", "start"],
            match_type=Trigger.MATCH_FIRST_WORD,
            groups=[group1],
            exclude_groups=[group2],
        )
        trigger2 = Trigger.create(self.org, self.admin, Trigger.TYPE_CATCH_ALL, flow2)
        trigger3 = Trigger.create(self.org, self.admin, Trigger.TYPE_MISSED_CALL, flow1, channel=self.channel)
        trigger4 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow2,
            keywords=["stop"],
            match_type=Trigger.MATCH_ONLY_WORD,
            is_archived=True,
        )
        schedule = Schedule.create(
            self.org,
            start_time=timezone.now() + timedelta(days=2),
            repeat_period=Schedule.REPEAT_DAILY,
        )
        trigger5 = Trigger.create(
            self.org, self.admin, Trigger.TYPE_SCHEDULE, flow1, schedule=schedule, contacts=(contact1,)
        )

        # and a trigger in another org that should never appear
        other_org_flow = self.create_flow("Other", org=self.org2)
        Trigger.create(
            self.org2,
            self.admin2,
            Trigger.TYPE_KEYWORD,
            other_org_flow,
            keywords=["other"],
            match_type=Trigger.MATCH_ONLY_WORD,
        )

        trigger6 = Trigger.create(
            self.org, self.admin, Trigger.TYPE_KEYWORD, flow1, keywords=["apply"], match_type=Trigger.MATCH_ONLY_WORD
        )

        # an archived scheduled trigger whose (paused) schedule still carries a stale next fire
        schedule2 = Schedule.create(
            self.org, start_time=timezone.now() + timedelta(days=3), repeat_period=Schedule.REPEAT_DAILY
        )
        schedule2.is_paused = True
        schedule2.save(update_fields=("is_paused",))
        trigger7 = Trigger.create(
            self.org, self.admin, Trigger.TYPE_SCHEDULE, flow2, schedule=schedule2, is_archived=True
        )

        # default folder is `active` (an unknown folder gets the same), newest first
        self.assertGet(
            endpoint_url, [self.editor, self.admin], results=[trigger6, trigger5, trigger3, trigger2, trigger1]
        )
        self.assertGet(
            endpoint_url + "?folder=active",
            [self.admin],
            results=[trigger6, trigger5, trigger3, trigger2, trigger1],
            num_queries=NUM_BASE_QUERIES + 5,  # count + triggers + 3 M2M prefetches
        )
        self.assertGet(
            endpoint_url + "?folder=nope", [self.admin], results=[trigger6, trigger5, trigger3, trigger2, trigger1]
        )

        # archived triggers live in their own folder, and an archived trigger's paused schedule reads as
        # not scheduled (no next fire) despite its stale next_fire value
        self.assertGet(endpoint_url + "?folder=archived", [self.admin], results=[trigger7, trigger4])

        def check_archived_schedule(data):
            scheduled = [r for r in data["results"] if r["uuid"] == str(trigger7.uuid)][0]
            self.assertEqual(Schedule.REPEAT_DAILY, scheduled["schedule"]["repeat_period"])
            self.assertIsNone(scheduled["schedule"]["next_fire"])
            return True

        self.assertGet(endpoint_url + "?folder=archived", [self.admin], raw=check_archived_schedule)

        # a type folder uses the legacy folder view's ordering — keyword triggers ahead of catch-all, and
        # keyword triggers ordered by their first keyword
        self.assertGet(endpoint_url + "?folder=messages", [self.admin], results=[trigger6, trigger1, trigger2])
        self.assertGet(endpoint_url + "?folder=schedule", [self.admin], results=[trigger5])

        # search matches keywords, flow names and channel names
        self.assertGet(endpoint_url + "?search=joi", [self.admin], results=[trigger1])
        self.assertGet(endpoint_url + "?search=support", [self.admin], results=[trigger2])
        self.assertGet(endpoint_url + "?search=test channel", [self.admin], results=[trigger3])

        # each row carries the columns the component renders
        def check_shape(data):
            first = [r for r in data["results"] if r["uuid"] == str(trigger1.uuid)][0]
            self.assertEqual("keyword", first["type"])
            self.assertEqual({"uuid": str(flow1.uuid), "name": "Survey"}, first["flow"])
            self.assertIsNone(first["channel"])
            self.assertEqual([{"uuid": str(group1.uuid), "name": "Farmers"}], first["groups"])
            self.assertEqual([{"uuid": str(group2.uuid), "name": "Staff"}], first["exclude_groups"])
            self.assertEqual([], first["contacts"])
            self.assertEqual(["join", "start"], first["keywords"])
            self.assertEqual("F", first["match_type"])
            self.assertIsNone(first["schedule"])
            self.assertEqual(matchers.ISODatetime(), first["created_on"])

            missed_call = [r for r in data["results"] if r["uuid"] == str(trigger3.uuid)][0]
            self.assertEqual(
                {"uuid": str(self.channel.uuid), "name": "Test Channel", "icon": "channel_a"},
                missed_call["channel"],
            )

            scheduled = [r for r in data["results"] if r["uuid"] == str(trigger5.uuid)][0]
            self.assertEqual("schedule", scheduled["type"])
            self.assertEqual(Schedule.REPEAT_DAILY, scheduled["schedule"]["repeat_period"])
            self.assertEqual(matchers.ISODatetime(), scheduled["schedule"]["next_fire"])
            self.assertEqual([{"uuid": str(contact1.uuid), "name": "Jim"}], scheduled["contacts"])
            return True

        self.assertGet(endpoint_url, [self.admin], raw=check_shape)

        # sortable by created_on in both directions; an unknown sort falls back to the default ordering
        self.assertGet(
            endpoint_url + "?sort=created_on", [self.admin], results=[trigger1, trigger2, trigger3, trigger5, trigger6]
        )
        self.assertGet(
            endpoint_url + "?sort=-created_on", [self.admin], results=[trigger6, trigger5, trigger3, trigger2, trigger1]
        )
        self.assertGet(
            endpoint_url + "?sort=nope", [self.admin], results=[trigger6, trigger5, trigger3, trigger2, trigger1]
        )

        # an over-long search query is rejected
        self.login(self.admin)
        response = self.client.get(endpoint_url + "?search=" + ("x" * 1001))
        self.assertEqual(413, response.status_code)

    def test_llms(self):
        endpoint_url = reverse("api.internal.llms") + ".json"

        openai = LLM.create(self.org, self.admin, OpenAIType(), "gpt-4o", "GPT-4", {}, roles=LLM.ROLE_EDITING)
        anthropic = LLM.create(self.org, self.admin, AnthropicType(), "claude-haiku-4-5-20251001", "Claude", {})
        deleted = LLM.create(self.org, self.admin, AnthropicType(), "claude-haiku-4-5-20251001", "Deleted", {})
        deleted.release(self.admin)
        system = LLM.create(self.org, self.admin, OpenAIType(), "gpt-4o", "System", {})
        system.is_system = True
        system.save(update_fields=("is_system",))

        self.assertGetNotPermitted(endpoint_url, [None])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        self.assertGet(
            endpoint_url,
            [self.admin],
            results=[
                {
                    "uuid": str(anthropic.uuid),
                    "name": "Claude",
                    "type": "anthropic",
                    "roles": ["editing", "engine"],
                },
                {
                    "uuid": str(openai.uuid),
                    "name": "GPT-4",
                    "type": "openai",
                    "roles": ["editing"],
                },
                {
                    "uuid": str(system.uuid),
                    "name": "System",
                    "type": "openai",
                    "roles": ["editing", "engine"],
                },
            ],
        )
