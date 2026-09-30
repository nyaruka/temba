from datetime import date, datetime, timedelta, timezone as tzone
from decimal import Decimal
from unittest.mock import call, patch

from django_valkey import get_valkey_connection

from django.db import connection
from django.test.utils import CaptureQueriesContext, override_settings
from django.urls import reverse

from temba import mailroom
from temba.api.models import Resthook
from temba.campaigns.models import Campaign, CampaignEvent
from temba.contacts.models import URN, Contact
from temba.flows.models import (
    Flow,
    FlowLabel,
    FlowRevision,
    FlowRun,
    FlowStart,
    FlowUserConflictException,
    FlowVersionConflictException,
    ResultsExport,
)
from temba.mailroom.client.types import Exclusions
from temba.orgs.integrations.dtone.type import DTOneType
from temba.orgs.models import Export
from temba.templates.models import TemplateTranslation
from temba.tests import CRUDLTestMixin, MockResponse, TembaTest, matchers, mock_mailroom
from temba.tests.base import get_contact_search, override_brand
from temba.tests.requests import MockJsonResponse
from temba.tickets.models import Ticket
from temba.triggers.models import Trigger
from temba.utils import json
from temba.utils.uuid import uuid4
from temba.utils.views.mixins import TEMBA_MENU_SELECTION


class FlowCRUDLTest(TembaTest, CRUDLTestMixin):
    def test_menu(self):
        menu_url = reverse("flows.flow_menu")

        FlowLabel.create(self.org, self.admin, "Important")

        self.assertRequestDisallowed(menu_url, [None, self.agent])
        self.assertPageMenu(
            menu_url,
            self.admin,
            [
                "Active",
                "Archived",
                "Globals",
                ("History", ["Starts", "Webhooks"]),
                ("Labels", ["Important (0)"]),
            ],
        )

    @override_settings(ORG_LIMIT_DEFAULTS={"flows": 2})
    def test_org_limit(self):
        list_url = reverse("flows.flow_list")
        create_url = reverse("flows.flow_create")

        flow1 = self.create_flow("Flow 1")
        editor_url = reverse("flows.flow_editor", args=[flow1.uuid])
        self.login(self.admin)

        # below the limit everything is offered as usual
        self.assertContentMenu(list_url, self.admin, ["New Flow", "New Label", "Import", "Export"])
        self.assertContentMenu(
            editor_url,
            self.admin,
            ["Start", "Interrupt", "Results", "-", "Edit", "Copy", "Delete", "-", "Export Definition"],
        )
        response = self.client.get(create_url)
        self.assertFalse(response.context["limit_reached"])

        self.create_flow("Flow 2")

        # at the limit the create option disappears and the modal explains why
        self.assertContentMenu(list_url, self.admin, ["New Label", "Import", "Export"])
        response = self.client.get(create_url)
        self.assertTrue(response.context["limit_reached"])
        self.assertContains(response, "You have reached the per-workspace limit")

        # as does copy, and posting to it anyway is refused
        self.assertContentMenu(
            editor_url,
            self.admin,
            ["Start", "Interrupt", "Results", "-", "Edit", "Delete", "-", "Export Definition"],
        )

        response = self.client.post(reverse("flows.flow_copy", args=[flow1.id]))
        self.assertRedirect(response, editor_url)
        self.assertEqual(2, self.org.flows.filter(is_active=True).count())

        # archived flows still count against the limit but released ones don't
        flow1.release(self.admin)

        self.assertContentMenu(list_url, self.admin, ["New Flow", "New Label", "Import", "Export"])

        # the limit check is only evaluated once per request even though both the menu and the context need it
        with CaptureQueriesContext(connection) as captured:
            self.client.get(list_url)

        limit_queries = [q for q in captured.captured_queries if q["sql"].startswith('SELECT COUNT(*) AS "__count"')]
        self.assertEqual(1, len(limit_queries))

    def test_create(self):
        create_url = reverse("flows.flow_create")
        self.create_flow("Registration")

        self.assertRequestDisallowed(create_url, [None, self.agent])
        response = self.assertCreateFetch(
            create_url,
            [self.editor, self.admin],
            form_fields=["name", "keyword_triggers", "flow_type", "base_language"],
        )

        # check flow type options
        self.assertEqual(
            [
                (Flow.TYPE_MESSAGE, "Messaging"),
                (Flow.TYPE_VOICE, "Phone Call"),
                (Flow.TYPE_BACKGROUND, "Background"),
            ],
            response.context["form"].fields["flow_type"].choices,
        )

        # try to submit without name or language
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow_type": "M"},
            form_errors={"name": "This field is required.", "base_language": "This field is required."},
        )

        # try to submit with a name that contains disallowed characters
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": '"Registration"', "flow_type": "M", "base_language": "eng"},
            form_errors={"name": 'Cannot contain the character: "'},
        )

        # try to submit with a name that is too long
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "X" * 65, "flow_type": "M", "base_language": "eng"},
            form_errors={"name": "Ensure this value has at most 64 characters (it has 65)."},
        )

        # try to submit with a name that is already used
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Registration", "flow_type": "M", "base_language": "eng"},
            form_errors={"name": "Must be unique."},
        )

        response = self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Flow 1", "flow_type": "M", "base_language": "eng"},
            new_obj_query=Flow.objects.filter(org=self.org, flow_type="M", name="Flow 1"),
        )

        flow1 = Flow.objects.get(name="Flow 1")
        self.assertEqual(1, flow1.revisions.all().count())

        self.assertRedirect(response, reverse("flows.flow_editor", args=[flow1.uuid]))

    def test_create_with_keywords(self):
        create_url = reverse("flows.flow_create")

        # try creating a flow with invalid keywords
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "name": "Flow #1",
                "base_language": "eng",
                "keyword_triggers": ["toooooooooooooolong", "test"],
                "flow_type": Flow.TYPE_MESSAGE,
            },
            form_errors={
                "keyword_triggers": "Must be single words, less than 16 characters, containing only letters and numbers."
            },
        )

        # submit with valid keywords
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "name": "Flow 1",
                "base_language": "eng",
                "keyword_triggers": ["testing", "test"],
                "flow_type": Flow.TYPE_MESSAGE,
            },
            new_obj_query=Flow.objects.filter(org=self.org, name="Flow 1", flow_type="M"),
        )

        # check the created keyword trigger
        flow1 = Flow.objects.get(name="Flow 1")
        self.assertEqual(1, flow1.triggers.count())
        self.assertEqual(1, flow1.triggers.filter(trigger_type="K", keywords=["testing", "test"]).count())

        # try to create another flow with one of the same keywords
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "name": "Flow 2",
                "base_language": "eng",
                "keyword_triggers": ["test"],
                "flow_type": Flow.TYPE_MESSAGE,
            },
            form_errors={"keyword_triggers": '"test" is already used for another flow.'},
        )

        # add a group to the existing trigger
        group = self.create_group("Testers", contacts=[])
        flow1.triggers.get().groups.add(group)

        # and now it's no longer a conflict
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "name": "Flow 2",
                "base_language": "eng",
                "keyword_triggers": ["test"],
                "flow_type": Flow.TYPE_MESSAGE,
            },
            new_obj_query=Flow.objects.filter(org=self.org, name="Flow 2", flow_type="M"),
        )

        # check the created keyword triggers
        flow2 = Flow.objects.get(name="Flow 2")
        self.assertEqual([["test"]], list(flow2.triggers.order_by("id").values_list("keywords", flat=True)))

    def test_views(self):
        list_url = reverse("flows.flow_list")
        create_url = reverse("flows.flow_create")

        self.create_contact("Eric", phone="+250788382382")
        flow = self.create_flow("Test")

        # create a flow for another org
        other_flow = Flow.create(self.org2, self.admin2, "Flow2")

        # no login, no list
        response = self.client.get(list_url)
        self.assertLoginRedirect(response)

        user = self.admin
        user.first_name = "Test"
        user.last_name = "Contact"
        user.save()
        self.login(user)

        self.assertContentMenu(list_url, self.editor, ["New Flow", "New Label", "Import", "Export"])
        self.assertContentMenu(list_url, self.admin, ["New Flow", "New Label", "Import", "Export"])

        # shouldn't be able to view another org's flow
        response = self.client.get(reverse("flows.flow_editor", args=[other_flow.uuid]))
        self.assertEqual(404, response.status_code)

        # get our create page
        response = self.client.get(create_url)
        self.assertTrue(response.context["has_flows"])

        # create a new regular flow
        response = self.client.post(
            create_url, {"name": "Flow 1", "flow_type": Flow.TYPE_MESSAGE, "base_language": "eng"}
        )
        self.assertEqual(302, response.status_code)

        # check we've been redirected to the editor and we have a revision
        flow1 = Flow.objects.get(org=self.org, name="Flow 1")
        self.assertEqual(f"/flow/editor/{flow1.uuid}/", response.url)
        self.assertEqual(1, flow1.revisions.all().count())
        self.assertEqual(Flow.TYPE_MESSAGE, flow1.flow_type)
        self.assertEqual(4320, flow1.expires_after_minutes)

        # add a trigger on this flow
        trigger = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow1,
            keywords=["unique"],
            match_type=Trigger.MATCH_FIRST_WORD,
        )

        # create a new voice flow
        response = self.client.post(
            create_url, {"name": "Voice Flow", "flow_type": Flow.TYPE_VOICE, "base_language": "eng"}
        )
        voice_flow = Flow.objects.get(org=self.org, name="Voice Flow")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(voice_flow.flow_type, "V")

        # default expiration for voice is shorter
        self.assertEqual(voice_flow.expires_after_minutes, 5)

        # test flows with triggers
        # create a new flow with one unformatted keyword
        response = self.client.post(
            create_url,
            {
                "name": "Flow With Unformated Keyword Triggers",
                "keyword_triggers": ["this is", "it"],
                "base_language": "eng",
            },
        )
        self.assertFormError(
            response.context["form"],
            "keyword_triggers",
            "Must be single words, less than 16 characters, containing only letters and numbers.",
        )

        # create a new flow with one existing keyword
        response = self.client.post(
            create_url, {"name": "Flow With Existing Keyword Triggers", "keyword_triggers": ["this", "is", "unique"]}
        )
        self.assertFormError(response.context["form"], "keyword_triggers", '"unique" is already used for another flow.')

        # create another trigger so there are two in the way
        trigger = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow1,
            keywords=["this"],
            match_type=Trigger.MATCH_FIRST_WORD,
        )

        response = self.client.post(
            create_url, {"name": "Flow With Existing Keyword Triggers", "keyword_triggers": ["this", "is", "unique"]}
        )
        self.assertFormError(
            response.context["form"], "keyword_triggers", '"this", "unique" are already used for another flow.'
        )
        trigger.delete()

        # create a new flow with keywords
        response = self.client.post(
            create_url,
            {
                "name": "Flow With Good Keyword Triggers",
                "base_language": "eng",
                "keyword_triggers": ["this", "is", "it"],
                "flow_type": Flow.TYPE_MESSAGE,
                "expires_after_minutes": 30,
            },
        )
        flow3 = Flow.objects.get(name="Flow With Good Keyword Triggers")

        # check we're being redirected to the editor view
        self.assertRedirect(response, reverse("flows.flow_editor", args=[flow3.uuid]))

        # can see results for a flow
        response = self.client.get(reverse("flows.flow_results", args=[flow.uuid]))
        self.assertEqual(200, response.status_code)

        # test update view
        response = self.client.post(reverse("flows.flow_update", args=[flow.uuid]))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.context["form"].fields), 5)
        self.assertIn("name", response.context["form"].fields)
        self.assertIn("keyword_triggers", response.context["form"].fields)
        self.assertIn("ignore_triggers", response.context["form"].fields)

        # test ivr flow creation
        self.channel.role = "SRCA"
        self.channel.save()

        response = self.client.post(
            create_url,
            {
                "name": "Message flow",
                "base_language": "eng",
                "expires_after_minutes": 5,
                "flow_type": Flow.TYPE_MESSAGE,
            },
        )
        msg_flow = Flow.objects.get(name="Message flow")

        self.assertEqual(302, response.status_code)
        self.assertEqual(msg_flow.flow_type, Flow.TYPE_MESSAGE)

        response = self.client.post(
            create_url,
            {"name": "Call flow", "base_language": "eng", "expires_after_minutes": 5, "flow_type": Flow.TYPE_VOICE},
        )
        call_flow = Flow.objects.get(name="Call flow")

        self.assertEqual(302, response.status_code)
        self.assertEqual(call_flow.flow_type, Flow.TYPE_VOICE)

        # test creating a flow with base language
        self.org.set_flow_languages(self.admin, ["eng"])

        response = self.client.post(
            create_url,
            {
                "name": "Language Flow",
                "expires_after_minutes": 5,
                "base_language": "eng",
                "flow_type": Flow.TYPE_MESSAGE,
            },
        )

        language_flow = Flow.objects.get(name="Language Flow")

        self.assertEqual(302, response.status_code)
        self.assertEqual(language_flow.base_language, "eng")

    def test_update_messaging_flow(self):
        flow = self.create_flow("Test")
        update_url = reverse("flows.flow_update", args=[flow.uuid])

        def assert_triggers(expected: list):
            actual = list(flow.triggers.filter(trigger_type="K", is_active=True).values("keywords", "is_archived"))
            self.assertCountEqual(actual, expected)

        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])
        self.assertUpdateFetch(
            update_url,
            [self.editor, self.admin],
            form_fields={
                "name": "Test",
                "keyword_triggers": [],
                "expires_after_minutes": 4320,
                "ignore_triggers": False,
            },
        )

        # try to update with empty name
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "", "expires_after_minutes": 10, "ignore_triggers": True},
            form_errors={"name": "This field is required."},
            object_unchanged=flow,
        )

        # update all fields
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "name": "New Name",
                "keyword_triggers": ["test", "help"],
                "expires_after_minutes": 10,
                "ignore_triggers": True,
            },
        )

        flow.refresh_from_db()
        self.assertEqual("New Name", flow.name)
        self.assertEqual(10, flow.expires_after_minutes)
        self.assertTrue(flow.ignore_triggers)

        assert_triggers([{"keywords": ["test", "help"], "is_archived": False}])

        # remove one keyword and add another
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "name": "New Name",
                "keyword_triggers": ["help", "support"],
                "expires_after_minutes": 10,
                "ignore_triggers": True,
            },
        )

        assert_triggers(
            [
                {"keywords": ["test", "help"], "is_archived": True},
                {"keywords": ["help", "support"], "is_archived": False},
            ]
        )

        # put "test" keyword back and remove "support"
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "name": "New Name",
                "keyword_triggers": ["test", "help"],
                "expires_after_minutes": 10,
                "ignore_triggers": True,
            },
        )

        assert_triggers(
            [
                {"keywords": ["test", "help"], "is_archived": False},
                {"keywords": ["help", "support"], "is_archived": True},
            ]
        )

        # add channel filter to active trigger
        support = flow.triggers.get(is_archived=False)
        support.channel = self.channel
        support.save(update_fields=("channel",))

        # re-adding "support" will now restore that trigger
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "name": "New Name",
                "keyword_triggers": ["test", "help", "support"],
                "expires_after_minutes": 10,
                "ignore_triggers": True,
            },
        )

        assert_triggers(
            [
                {"keywords": ["test", "help"], "is_archived": False},
                {"keywords": ["help", "support"], "is_archived": False},
            ]
        )

    def test_update_voice_flow(self):
        flow = self.create_flow("IVR Test", flow_type=Flow.TYPE_VOICE)
        update_url = reverse("flows.flow_update", args=[flow.uuid])

        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])
        self.assertUpdateFetch(
            update_url,
            [self.editor, self.admin],
            form_fields=["name", "keyword_triggers", "expires_after_minutes", "ignore_triggers", "ivr_retry"],
        )

        # try to update with an expires value which is only for messaging flows and an invalid retry value
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "New Name", "expires_after_minutes": 720, "ignore_triggers": True, "ivr_retry": 1234},
            form_errors={
                "expires_after_minutes": "Select a valid choice. 720 is not one of the available choices.",
                "ivr_retry": "Select a valid choice. 1234 is not one of the available choices.",
            },
            object_unchanged=flow,
        )

        # update name and contact creation option to be per login
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "name": "New Name",
                "keyword_triggers": ["test", "help"],
                "expires_after_minutes": 10,
                "ignore_triggers": True,
                "ivr_retry": 30,
            },
        )

        flow.refresh_from_db()
        self.assertEqual("New Name", flow.name)
        self.assertEqual(10, flow.expires_after_minutes)
        self.assertTrue(flow.ignore_triggers)
        self.assertEqual(30, flow.ivr_retry)
        self.assertEqual(1, flow.triggers.count())
        self.assertEqual(1, flow.triggers.filter(keywords=["test", "help"]).count())

        # check we still have that value after saving a new revision
        flow.save_revision(self.admin, flow.get_definition())
        self.assertEqual(30, flow.ivr_retry)

    def test_update_surveyor_flow(self):
        flow = self.create_flow("Survey", flow_type=Flow.TYPE_SURVEY)
        update_url = reverse("flows.flow_update", args=[flow.uuid])

        # we should only see name and contact creation option on form
        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])
        self.assertUpdateFetch(update_url, [self.editor, self.admin], form_fields=["name"])

        # update name and contact creation option to be per login
        self.assertUpdateSubmit(update_url, self.admin, {"name": "New Name"})

        flow.refresh_from_db()
        self.assertEqual("New Name", flow.name)

    def test_update_background_flow(self):
        flow = self.create_flow("Background", flow_type=Flow.TYPE_BACKGROUND)
        update_url = reverse("flows.flow_update", args=[flow.uuid])

        # we should only see name on form
        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])
        self.assertUpdateFetch(update_url, [self.editor, self.admin], form_fields=["name"])

        # update name and contact creation option to be per login
        self.assertUpdateSubmit(update_url, self.admin, {"name": "New Name"})

        flow.refresh_from_db()
        self.assertEqual("New Name", flow.name)

    def test_list_views(self):
        flow1 = self.create_flow("Flow 1")
        flow2 = self.create_flow("Flow 2")

        # archive second flow
        flow2.is_archived = True
        flow2.save(update_fields=("is_archived",))

        # create flow used by a campaign
        group = self.create_group("Reporters", contacts=[])
        flow3 = self.create_flow("Flow 3")
        campaign = Campaign.create(self.org, self.admin, "Reminders", group)
        registered = self.create_field("registered", "Registered", value_type="D")
        CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, registered, offset=1, unit="W", flow=flow3, delivery_hour="13"
        )

        list_url = reverse("flows.flow_list")

        self.assertRequestDisallowed(list_url, [None, self.agent])
        self.assertListFetch(list_url, [self.editor, self.admin])

        # try to archive flow used by campaign
        response = self.client.post(list_url, {"action": "archive", "objects": str(flow3.uuid)})
        self.assertToast(
            response,
            "info",
            "The following flows with active campaigns or ongoing runs cannot be "
            "archived: Flow 3. Runs can be interrupted from the editor.",
        )

        flow3.refresh_from_db()
        self.assertFalse(flow3.is_archived)

        # create a flow with ongoing runs
        flow4 = self.create_flow("Flow 4")
        flow4.counts.create(scope=f"status:{FlowRun.STATUS_WAITING}", count=10)

        # try to archive flow with ongoing runs
        response = self.client.post(list_url, {"action": "archive", "objects": str(flow4.uuid)})
        self.assertToast(
            response,
            "info",
            "The following flows with active campaigns or ongoing runs cannot be "
            "archived: Flow 4. Runs can be interrupted from the editor.",
        )

        flow4.refresh_from_db()
        self.assertFalse(flow4.is_archived)

        # archive first flow
        response = self.client.post(list_url, {"action": "archive", "objects": str(flow1.uuid)})
        self.assertEqual(200, response.status_code)

        flow1.refresh_from_db()
        self.assertTrue(flow1.is_archived)

        response = self.client.get(reverse("flows.flow_list"))
        self.assertBulkActions(response, ["label", "export-results", "archive"])

        # unarchive it
        response = self.client.post(reverse("flows.flow_archived"), {"action": "restore", "objects": str(flow1.uuid)})
        self.assertEqual(200, response.status_code)

        flow1.refresh_from_db()
        self.assertFalse(flow1.is_archived)

        response = self.client.get(reverse("flows.flow_archived"))
        self.assertBulkActions(response, ["restore"])

        # can label flows
        label1 = FlowLabel.create(self.org, self.admin, "Important")

        response = self.client.post(
            reverse("flows.flow_list"), {"action": "label", "objects": str(flow1.uuid), "label": str(label1.uuid)}
        )

        self.assertEqual(200, response.status_code)
        self.assertEqual({label1}, set(flow1.labels.all()))
        self.assertEqual({flow1}, set(label1.flows.all()))

        # and unlabel
        response = self.client.post(
            reverse("flows.flow_list"),
            {"action": "label", "objects": str(flow1.uuid), "label": str(label1.uuid), "add": False},
        )

        self.assertEqual(200, response.status_code)

        flow1.refresh_from_db()
        self.assertEqual(set(), set(flow1.labels.all()))

    def test_filter(self):
        flow1 = self.create_flow("Flow 1")
        flow2 = self.create_flow("Flow 2")

        label1 = FlowLabel.create(self.org, self.admin, "Important")
        label2 = FlowLabel.create(self.org, self.admin, "Very Important")

        label1.toggle_label([flow1, flow2], add=True)
        label2.toggle_label([flow2], add=True)

        self.login(self.admin)

        response = self.client.get(reverse("flows.flow_filter", args=[label1.uuid]))
        self.assertBulkActions(response, ["label", "export-results"])

        response = self.client.get(reverse("flows.flow_filter", args=[label2.uuid]))
        self.assertEqual(f"/flow/labels/{label2.uuid}", response.headers.get(TEMBA_MENU_SELECTION))

    def test_list_component(self):
        flow1 = self.create_flow("Flow 1")
        flow2 = self.create_flow("Flow 2")
        label = FlowLabel.create(self.org, self.admin, "Important")
        label.toggle_label([flow2], add=True)

        list_url = reverse("flows.flow_list")

        self.login(self.admin)

        # the temba-flow-list component is pointed at the internal flows api
        response = self.client.get(list_url)
        self.assertContains(response, "temba-flow-list")
        self.assertEqual(f"{reverse('api.internal.flows')}.json?folder=active", response.context["list_url"])

        # export-results is clientOnly (it opens the export modal); the label dropdown carries a labelsEndpoint of
        # the workspace's flow labels; the rest post to the action endpoint
        actions = {a["key"]: a for a in response.context["list_bulk_actions"]}
        self.assertEqual(["label", "export-results", "archive"], list(actions.keys()))
        self.assertTrue(actions["export-results"]["clientOnly"])
        self.assertNotIn("clientOnly", actions["archive"])
        self.assertEqual("/api/internal/flow_labels.json", actions["label"]["labelsEndpoint"])
        # the label dropdown carries the create affordance for viewers who can create labels
        self.assertTrue(actions["label"]["allowCreate"])

        # the archived view selects the archived folder
        response = self.client.get(reverse("flows.flow_archived"))
        self.assertEqual(f"{reverse('api.internal.flows')}.json?folder=archived", response.context["list_url"])
        self.assertNotEqual("", response.context["list_subtitle"])

        # a label filter view is selected by uuid rather than a folder
        response = self.client.get(reverse("flows.flow_filter", args=[label.uuid]))
        self.assertEqual(f"{reverse('api.internal.flows')}.json?label={label.uuid}", response.context["list_url"])

        # the component posts flow uuids in `objects`
        self.client.post(list_url, {"action": "archive", "objects": str(flow1.uuid)})
        flow1.refresh_from_db()
        self.assertTrue(flow1.is_archived)

        # the label dropdown adds the selection to a label (label posted by uuid; omitting `add` means add)
        self.client.post(list_url, {"action": "label", "objects": str(flow2.uuid), "label": str(label.uuid)})
        self.assertEqual({label}, set(flow2.labels.all()))

        # ...and removes it when add=false
        self.client.post(
            list_url, {"action": "label", "objects": str(flow2.uuid), "label": str(label.uuid), "add": "false"}
        )
        self.assertEqual(set(), set(flow2.labels.all()))

        # a label posted as a numeric id is rejected
        self.client.post(list_url, {"action": "label", "objects": str(flow2.uuid), "label": str(label.id)})
        self.assertEqual(set(), set(flow2.labels.all()))

        # a malformed flow uuid in `objects` fails form validation rather than raising (no 500 on garbage input)
        response = self.client.post(list_url, {"action": "archive", "objects": "not-a-uuid"})
        self.assertEqual(200, response.status_code)
        self.assertToast(response, "error", "Your selection is no longer valid. Please refresh and try again.")
        flow2.refresh_from_db()
        self.assertFalse(flow2.is_archived)

        # a malformed label uuid is likewise a form error rather than a raise
        response = self.client.post(list_url, {"action": "label", "objects": str(flow2.uuid), "label": "not-a-uuid"})
        self.assertEqual(200, response.status_code)
        self.assertToast(response, "error", "Your selection is no longer valid. Please refresh and try again.")
        self.assertEqual(set(), set(flow2.labels.all()))

        # the export modal accepts uuids as well as ids
        export_url = reverse("flows.flow_export_results")
        response = self.client.get(f"{export_url}?ids={flow2.uuid}")
        self.assertEqual([flow2], list(response.context["form"].initial["flows"]))
        response = self.client.get(f"{export_url}?ids={flow2.id}")
        self.assertEqual([flow2], list(response.context["form"].initial["flows"]))

        # ...and ignores values that are neither
        response = self.client.get(f"{export_url}?ids=foo")
        self.assertEqual([], list(response.context["form"].initial["flows"]))

    def test_get_definition(self):
        flow = self.get_flow("color")

        # if definition is outdated, metadata values are updated from db object
        flow.name = "Amazing Flow"
        flow.save(update_fields=("name",))

        self.assertEqual("Amazing Flow", flow.get_definition()["name"])

        # make a flow that looks like a legacy flow
        flow = self.create_flow("Color Legacy")
        original_def = self.load_json("flows/legacy/color_v11.json")["flows"][0]

        flow.version_number = "11.12"
        flow.save(update_fields=("version_number",))

        revision = flow.revisions.get()
        revision.definition = original_def
        revision.spec_version = "11.12"
        revision.save(update_fields=("definition", "spec_version"))

        self.assertIn("metadata", flow.get_definition())

        # if definition is outdated, metadata values are updated from db object
        flow.name = "Amazing Flow 2"
        flow.save(update_fields=("name",))

        self.assertEqual("Amazing Flow 2", flow.get_definition()["metadata"]["name"])

        # metadata section can be missing too
        del original_def["metadata"]
        revision.definition = original_def
        revision.save(update_fields=("definition",))

        self.assertEqual("Amazing Flow 2", flow.get_definition()["metadata"]["name"])

    def test_revisions(self):
        flow = self.create_flow("Color")

        revisions_url = reverse("flows.flow_revisions", args=[flow.uuid])

        # rewind the flow's revision to a legacy spec
        original_def = self.load_json("flows/legacy/color_v11.json")["flows"][0]
        revision = flow.revisions.get()
        revision.definition = original_def
        revision.spec_version = "11.12"
        revision.changes = {}
        revision.save(update_fields=("definition", "spec_version", "changes"))

        # add a second, current-spec revision directly - creating one through migration is goflow's job
        FlowRevision.objects.create(
            flow=flow,
            definition=self.load_json("flows/color.json")["flows"][0],
            spec_version=Flow.CURRENT_SPEC_VERSION,
            revision=2,
            changes={"tags": ["routing", "spec"]},
            created_by=self.admin,
        )

        revisions = list(flow.revisions.all().order_by("-created_on"))

        # now we should have two revisions
        self.assertEqual(2, len(revisions))
        self.assertEqual(2, revisions[0].revision)
        self.assertEqual(Flow.CURRENT_SPEC_VERSION, revisions[0].spec_version)
        self.assertEqual(1, revisions[1].revision)
        self.assertEqual("11.12", revisions[1].spec_version)

        self.assertRequestDisallowed(revisions_url, [None, self.agent, self.admin2])
        response = self.assertReadFetch(revisions_url, [self.editor, self.admin])
        self.assertEqual(
            [
                {
                    "user": {"email": "admin@textit.com", "name": "Andy"},
                    "created_on": matchers.ISODatetime(),
                    "id": revisions[0].id,
                    "version": Flow.CURRENT_SPEC_VERSION,
                    "revision": 2,
                    "changes": {"tags": ["routing", "spec"]},
                },
                {
                    "user": {"email": "admin@textit.com", "name": "Andy"},
                    "created_on": matchers.ISODatetime(),
                    "id": revisions[1].id,
                    "version": "11.12",
                    "revision": 1,
                    "changes": {},
                },
            ],
            response.json()["results"],
        )

        # fetch a specific revision
        response = self.assertReadFetch(f"{revisions_url}{revisions[0].id}/", [self.editor, self.admin])

        # make sure we can read the definition
        resp_json = response.json()
        self.assertEqual("und", resp_json["definition"]["language"])
        self.assertEqual(
            {"counts", "issues", "locals", "results", "parent_refs", "dependencies"}, set(resp_json["info"].keys())
        )

        # we can also fetch the latest revision without knowing the id
        response = self.client.get(f"{revisions_url}latest/")
        self.assertEqual(resp_json, response.json())

        # fetch the legacy revision
        response = self.client.get(f"{revisions_url}{revisions[1].id}/")

        # should automatically migrate to latest spec
        self.assertEqual(Flow.CURRENT_SPEC_VERSION, response.json()["definition"]["spec_version"])

        # but we can also limit how far it is migrated
        response = self.client.get(f"{revisions_url}{revisions[1].id}/?version=13.0.0")

        # should only have been migrated to that version
        self.assertEqual("13.0.0", response.json()["definition"]["spec_version"])

        # check 404 for invalid revision number
        response = self.requestView(f"{revisions_url}12345678/", self.admin)
        self.assertEqual(404, response.status_code)

    @mock_mailroom
    def test_revision_uses_freshly_inspected_dependencies(self, mr_mocks):
        flow = self.create_flow("Parent")
        child1 = self.create_flow("Child One")
        child2 = self.create_flow("Child Two")

        dependencies = [
            {"type": "flow", "uuid": str(child1.uuid), "name": child1.name, "missing": False},
            {"type": "flow", "uuid": str(child2.uuid), "name": child2.name, "missing": False},
        ]
        mr_mocks.flow_inspect(dependencies=dependencies)

        self.login(self.editor)
        response = self.client.get(f"{reverse('flows.flow_revisions', args=[flow.uuid])}latest/")

        self.assertEqual(200, response.status_code)
        self.assertEqual(dependencies, response.json()["info"]["dependencies"])
        self.assertEqual(response.json()["metadata"], response.json()["info"])

    def test_save_revisions(self):
        flow = self.create_flow("Go Flow")
        revisions_url = reverse("flows.flow_revisions", args=[flow.uuid])

        self.login(self.admin)
        response = self.client.get(revisions_url)
        self.assertEqual(1, len(response.json()))

        definition = flow.revisions.all().first().definition

        # agents can't access
        self.login(self.agent)
        response = self.client.post(revisions_url, definition, content_type="application/json")
        self.assertPermissionDenied(response)

        # posting the unchanged definition is a no-op — no new revision created
        self.login(self.admin)
        response = self.client.post(revisions_url, definition, content_type="application/json")
        same_revision = response.json()
        self.assertEqual(1, same_revision["revision"][Flow.DEFINITION_REVISION])
        self.assertEqual(1, flow.revisions.count())

        # but a real change creates a new revision (rename the flow so the next save
        # picks up a metadata diff via the live flow.name)
        flow.name = "Renamed Flow"
        flow.save(update_fields=("name",))
        response = self.client.post(revisions_url, definition, content_type="application/json")
        new_revision = response.json()
        self.assertEqual(2, new_revision["revision"][Flow.DEFINITION_REVISION])

        # we can't save our old revision number
        response = self.client.post(revisions_url, definition, content_type="application/json")
        self.assertResponseError(
            response, "description", "Your changes will not be saved until you refresh your browser"
        )

        # or save an old version
        definition = flow.revisions.all().first().definition
        definition[Flow.DEFINITION_SPEC_VERSION] = "11.12"
        response = self.client.post(revisions_url, definition, content_type="application/json")
        self.assertResponseError(response, "description", "Your flow has been upgraded to the latest version")

    @mock_mailroom
    def test_preview_start(self, mr_mocks):
        flow = self.create_flow("Test Flow")
        self.create_field("age", "Age")
        self.create_contact("Ann", phone="+16302222222", fields={"age": 40})
        self.create_contact("Bob", phone="+16303333333", fields={"age": 33})

        mr_mocks.flow_start_preview(query='age > 30 AND status = "active" AND history != "Test Flow"', total=100)

        preview_url = reverse("flows.flow_preview_start", args=[flow.id])

        self.login(self.editor)

        response = self.client.post(
            preview_url,
            {
                "query": "age > 30",
                "exclusions": {"non_active": True, "started_previously": True},
            },
            content_type="application/json",
        )
        self.assertEqual(
            {
                "query": 'age > 30 AND status = "active" AND history != "Test Flow"',
                "total": 100,
                "send_time": 10.0,
                "warnings": [],
                "blockers": [],
            },
            response.json(),
        )

        mr_mocks.flow_start_preview(query='age > 30 AND status = "active" AND history != "Test Flow"', total=100)
        self.login(self.customer_support, choose_org=self.org)

        response = self.client.post(
            preview_url,
            {
                "query": "age > 30",
                "exclusions": {"non_active": True, "started_previously": True},
            },
            content_type="application/json",
        )
        self.assertEqual(
            {
                "query": 'age > 30 AND status = "active" AND history != "Test Flow"',
                "total": 100,
                "send_time": 10.0,
                "warnings": [],
                "blockers": [],
            },
            response.json(),
        )

        mr_mocks.flow_start_preview(
            query='age > 30 AND status = "active" AND history != "Test Flow" AND flow = ""', total=100
        )
        preview_url = reverse("flows.flow_preview_start", args=[flow.id])

        self.login(self.editor)

        response = self.client.post(
            preview_url,
            {
                "query": "age > 30",
                "exclusions": {"non_active": True, "started_previously": True, "in_a_flow": True},
            },
            content_type="application/json",
        )
        self.assertEqual(
            {
                "query": 'age > 30 AND status = "active" AND history != "Test Flow" AND flow = ""',
                "total": 100,
                "send_time": 10.0,
                "warnings": [],
                "blockers": [],
            },
            response.json(),
        )

        # try with a bad query
        mr_mocks.exception(mailroom.QueryValidationException("mismatched input at (((", "syntax"))

        response = self.client.post(
            preview_url,
            {
                "query": "(((",
                "exclusions": {"non_active": True, "started_previously": True},
            },
            content_type="application/json",
        )
        self.assertEqual(400, response.status_code)
        self.assertEqual({"query": "", "total": 0, "error": "Invalid query syntax."}, response.json())

        # suspended orgs should block
        self.org.suspend()
        mr_mocks.flow_start_preview(query="age > 30", total=2)
        response = self.client.post(preview_url, {"query": "age > 30"}, content_type="application/json")
        self.assertEqual(
            [
                "Sorry, your workspace is currently suspended. To re-enable starting flows and sending messages, please contact support."
            ],
            response.json()["blockers"],
        )

        # flagged orgs should block
        self.org.unsuspend()
        self.org.flag()
        mr_mocks.flow_start_preview(query="age > 30", total=2)
        response = self.client.post(preview_url, {"query": "age > 30"}, content_type="application/json")
        self.assertEqual(
            [
                "Sorry, your workspace is currently flagged. To re-enable starting flows and sending messages, please contact support."
            ],
            response.json()["blockers"],
        )

        self.org.unflag()

        # create a pending flow start to test warning
        FlowStart.create(flow, self.admin, query="age > 30")

        mr_mocks.flow_start_preview(query='age > 30 AND status = "active" AND history != "Test Flow"', total=100)

        response = self.client.post(
            preview_url,
            {
                "query": "age > 30",
                "exclusions": {"non_active": True, "started_previously": True},
            },
            content_type="application/json",
        )

        self.assertEqual(
            [
                "A flow is already starting. To avoid confusion, make sure you are not targeting the same contacts before continuing."
            ],
            response.json()["warnings"],
        )

        ivr_flow = self.create_flow("IVR Test", flow_type=Flow.TYPE_VOICE)

        preview_url = reverse("flows.flow_preview_start", args=[ivr_flow.id])

        # shouldn't be able to since we don't have a call channel
        self.org.flow_starts.all().delete()
        mr_mocks.flow_start_preview(query='age > 30 AND status = "active" AND history != "IVR Test"', total=100)

        response = self.client.post(
            preview_url,
            {
                "query": "age > 30",
                "exclusions": {"non_active": True, "started_previously": True},
            },
            content_type="application/json",
        )

        self.assertEqual(
            response.json()["blockers"][0],
            'To start this flow you need to <a href="/channels/channel/claim/">add a voice channel</a> to your workspace which will allow you to make and receive calls.',
        )

        # if we have too many messages in our outbox we should block
        self.org.counts.create(scope="msgs:folder:O", count=1_000_001)
        preview_url = reverse("flows.flow_preview_start", args=[flow.id])
        mr_mocks.flow_start_preview(query="age > 30", total=1000)

        response = self.client.post(
            preview_url,
            {
                "query": "age > 30",
            },
            content_type="application/json",
        )
        self.assertEqual(
            [
                "You have too many messages queued in your outbox. Please wait for these messages to send and then try again."
            ],
            response.json()["blockers"],
        )
        self.org.counts.prefix("msgs:folder:").delete()

        # check warning for lots of contacts
        preview_url = reverse("flows.flow_preview_start", args=[flow.id])

        # with patch("temba.orgs.models.Org.get_estimated_send_time") as mock_get_estimated_send_time:
        with override_settings(SEND_HOURS_WARNING=24, SEND_HOURS_BLOCK=48):
            # we send at 10 tps, so make the total take 24 hours
            expected_tps = 10
            mr_mocks.flow_start_preview(
                query='age > 30 AND status = "active" AND history != "Test Flow"', total=24 * 60 * 60 * expected_tps
            )

            # mock_get_estimated_send_time.return_value = timedelta(days=2)
            response = self.client.post(
                preview_url,
                {
                    "query": "age > 30",
                    "exclusions": {"non_active": True, "started_previously": True},
                },
                content_type="application/json",
            )

            self.assertEqual(
                response.json()["warnings"][0],
                "Your channels will likely take over a day to reach all of the selected contacts. Consider selecting fewer contacts before continuing.",
            )

            # now really long so it should block
            mr_mocks.flow_start_preview(
                query='age > 30 AND status = "active" AND history != "Test Flow"', total=3 * 24 * 60 * 60 * expected_tps
            )
            # mock_get_estimated_send_time.return_value = timedelta(days=7)
            response = self.client.post(
                preview_url,
                {
                    "query": "age > 30",
                    "exclusions": {"non_active": True, "started_previously": True},
                },
                content_type="application/json",
            )

            self.assertEqual(
                response.json()["blockers"][0],
                "Your channels cannot send fast enough to reach all of the selected contacts in a reasonable time. Select fewer contacts to continue.",
            )

        # if we release our send channel we also can't start a regular messaging flow
        self.channel.release(self.admin)
        mr_mocks.flow_start_preview(query='age > 30 AND status = "active" AND history != "Test Flow"', total=100)

        response = self.client.post(
            preview_url,
            {
                "query": "age > 30",
                "exclusions": {"non_active": True, "started_previously": True},
            },
            content_type="application/json",
        )

        self.assertEqual(
            response.json()["blockers"][0],
            'To start this flow you need to <a href="/channels/channel/claim/">add a channel</a> to your workspace which will allow you to send messages to your contacts.',
        )

        flow = self.create_flow("Background Flow", flow_type=Flow.TYPE_BACKGROUND)
        mr_mocks.flow_start_preview(query='age > 30 AND status = "active" AND history != "Background Flow"', total=100)
        preview_url = reverse("flows.flow_preview_start", args=[flow.id])

        self.login(self.editor)

        response = self.client.post(
            preview_url,
            {
                "query": "age > 30",
                "exclusions": {"non_active": True, "started_previously": True, "in_a_flow": True},
            },
            content_type="application/json",
        )
        self.assertEqual(
            {
                "query": 'age > 30 AND status = "active" AND history != "Background Flow"',
                "total": 100,
                "send_time": 0.0,
                "warnings": [],
                "blockers": [],
            },
            response.json(),
        )

    def test_editor_feature_filters(self):
        flow = self.create_flow("Test")

        self.login(self.admin)

        def assert_features(features: set):
            response = self.client.get(reverse("flows.flow_editor", args=[flow.uuid]))
            self.assertEqual(features, set(json.loads(response.context["feature_filters"])))

        # auto_translate is always available
        assert_features({"auto_translate"})

        # add a resthook
        Resthook.objects.create(org=flow.org, created_by=self.admin, modified_by=self.admin)
        assert_features({"auto_translate", "resthook"})

        # add a DT One integration
        DTOneType().connect(flow.org, self.admin, "login", "token")
        assert_features({"auto_translate", "airtime", "resthook"})

        # change our channel to use a whatsapp scheme
        self.channel.schemes = [URN.WHATSAPP_SCHEME]
        self.channel.save()
        assert_features({"auto_translate", "whatsapp", "airtime", "resthook"})

        # change our channel to use a facebook scheme
        self.channel.schemes = [URN.FACEBOOK_SCHEME]
        self.channel.save()
        assert_features({"auto_translate", "airtime", "resthook"})

        self.setUpLocations()

        assert_features({"auto_translate", "airtime", "resthook", "locations"})

    @mock_mailroom
    def test_template_warnings(self, mr_mocks):
        self.login(self.admin)
        flow = self.get_flow("whatsapp_template")

        # bring up broadcast dialog
        self.login(self.admin)

        mr_mocks.flow_start_preview(query="age > 30", total=2)
        response = self.client.post(
            reverse("flows.flow_preview_start", args=[flow.id]),
            {
                "query": "age > 30",
            },
            content_type="application/json",
        )

        # no warning, we don't have a whatsapp channel
        self.assertEqual(response.json()["warnings"], [])

        # change our channel to use a whatsapp scheme
        self.channel.schemes = [URN.WHATSAPP_SCHEME]
        self.channel.channel_type = "TWA"
        self.channel.save()

        mr_mocks.flow_start_preview(query="age > 30", total=2)
        response = self.client.post(
            reverse("flows.flow_preview_start", args=[flow.id]),
            {
                "query": "age > 30",
            },
            content_type="application/json",
        )

        # no warning, we don't have a whatsapp channel that requires a message template
        self.assertEqual(response.json()["warnings"], [])

        self.channel.channel_type = "WAC"
        self.channel.save()

        # clear dependencies, this will cause our flow to look like it isn't using templates
        flow.info["dependencies"] = []
        flow.save(update_fields=("info",))

        mr_mocks.flow_start_preview(query="age > 30", total=2)
        response = self.client.post(
            reverse("flows.flow_preview_start", args=[flow.id]),
            {
                "query": "age > 30",
            },
            content_type="application/json",
        )

        self.assertEqual(
            response.json()["warnings"],
            [
                "This flow does not use message templates. You may still start this flow but WhatsApp contacts who have not sent an incoming message in the last 24 hours may not receive it."
            ],
        )

        # make it look like we are using a template, but it doesn't exist
        flow.info["dependencies"] = [
            {"type": "template", "uuid": "f712e05c-bbed-40f1-b3d9-671bb9b60775", "name": "affirmation"}
        ]
        flow.save(update_fields=("info",))

        # template doesn't exit, will be warned
        mr_mocks.flow_start_preview(query="age > 30", total=2)
        response = self.client.post(
            reverse("flows.flow_preview_start", args=[flow.id]),
            {
                "query": "age > 30",
            },
            content_type="application/json",
        )

        self.assertEqual(
            response.json()["warnings"],
            ["The message template affirmation does not exist on your account and cannot be sent."],
        )

        # create the template, but no translations
        template = self.create_template("affirmation", [], uuid="f712e05c-bbed-40f1-b3d9-671bb9b60775")

        # will be warned again
        mr_mocks.flow_start_preview(query="age > 30", total=2)
        response = self.client.post(
            reverse("flows.flow_preview_start", args=[flow.id]),
            {
                "query": "age > 30",
            },
            content_type="application/json",
        )

        self.assertEqual(
            response.json()["warnings"], ["Your message template affirmation is not approved and cannot be sent."]
        )

        # create a translation, but not approved
        TemplateTranslation.objects.create(
            template=template,
            channel=self.channel,
            locale="eng-US",
            status=TemplateTranslation.STATUS_REJECTED,
            external_id="id1",
            external_locale="en_US",
            namespace="foo_namespace",
            components=[{"name": "body", "type": "body/text", "content": "Hello", "variables": {}, "params": []}],
            variables=[],
        )

        # will be warned again
        mr_mocks.flow_start_preview(query="age > 30", total=2)
        response = self.client.post(
            reverse("flows.flow_preview_start", args=[flow.id]),
            {
                "query": "age > 30",
            },
            content_type="application/json",
        )

        self.assertEqual(
            response.json()["warnings"], ["Your message template affirmation is not approved and cannot be sent."]
        )

        # finally, set our translation to approved
        TemplateTranslation.objects.update(status=TemplateTranslation.STATUS_APPROVED)

        # no warnings
        mr_mocks.flow_start_preview(query="age > 30", total=2)
        response = self.client.post(
            reverse("flows.flow_preview_start", args=[flow.id]),
            {
                "query": "age > 30",
            },
            content_type="application/json",
        )

        self.assertEqual(response.json()["warnings"], [])

    @mock_mailroom
    def test_template_cost_warnings(self, mr_mocks):
        self.login(self.admin)
        flow = self.create_flow("Template Flow")
        flow.info["dependencies"] = [
            {"type": "template", "uuid": "f712e05c-bbed-40f1-b3d9-671bb9b60775", "name": "affirmation"}
        ]
        flow.save(update_fields=("info",))

        # flow uses templates but brand doesn't have cost_warnings feature
        mr_mocks.flow_start_preview(query="age > 30", total=2)
        response = self.client.post(
            reverse("flows.flow_preview_start", args=[flow.id]),
            {"query": "age > 30"},
            content_type="application/json",
        )
        self.assertEqual(response.json()["warnings"], [])

        # enable cost_warnings brand feature
        with override_brand(features=["cost_warnings"]):
            # flow uses templates, should get cost warning
            mr_mocks.flow_start_preview(query="age > 30", total=2)
            response = self.client.post(
                reverse("flows.flow_preview_start", args=[flow.id]),
                {"query": "age > 30"},
                content_type="application/json",
            )
            self.assertIn(
                "This flow uses message templates which may incur additional fees from your channel provider.",
                response.json()["warnings"],
            )

            # flow without templates should not get cost warning
            flow2 = self.create_flow("No Templates")
            mr_mocks.flow_start_preview(query="age > 30", total=2)
            response = self.client.post(
                reverse("flows.flow_preview_start", args=[flow2.id]),
                {"query": "age > 30"},
                content_type="application/json",
            )
            self.assertNotIn(
                "This flow uses message templates which may incur additional fees from your channel provider.",
                response.json()["warnings"],
            )

    @mock_mailroom
    def test_start(self, mr_mocks):
        contact = self.create_contact("Bob", phone="+593979099111")
        flow = self.create_flow("Test")
        start_url = f"{reverse('flows.flow_start', args=[])}?flow={flow.id}"

        self.assertRequestDisallowed(start_url, [None, self.agent])
        self.assertUpdateFetch(start_url, [self.editor, self.admin], form_fields=["flow", "contact_search"])

        # create flow start with a query
        mr_mocks.contact_parse_query("frank", cleaned='name ~ "frank"')
        self.assertUpdateSubmit(
            start_url,
            self.admin,
            {"flow": flow.id, "contact_search": get_contact_search(query="frank")},
        )

        self.assertEqual(
            mr_mocks.calls["flow_start"],
            [
                call(
                    self.org,
                    self.admin,
                    typ="M",
                    flow=flow,
                    groups=[],
                    contacts=[],
                    urns=[],
                    query='name ~ "frank"',
                    exclude=Exclusions(),
                    params={},
                )
            ],
        )

        # create flow start with a bogus query
        mr_mocks.exception(mailroom.QueryValidationException("query contains an error", "syntax"))
        self.assertUpdateSubmit(
            start_url,
            self.admin,
            {"flow": flow.id, "contact_search": get_contact_search(query='name = "frank')},
            form_errors={"contact_search": "Invalid query syntax."},
            object_unchanged=flow,
        )

        # try missing contacts
        self.assertUpdateSubmit(
            start_url,
            self.admin,
            {"flow": flow.id, "contact_search": get_contact_search(contacts=[])},
            form_errors={"contact_search": "Contacts or groups are required."},
            object_unchanged=flow,
        )

        # try to create with an empty query
        self.assertUpdateSubmit(
            start_url,
            self.admin,
            {"flow": flow.id, "contact_search": get_contact_search(query="")},
            form_errors={"contact_search": "A contact query is required."},
            object_unchanged=flow,
        )

        query = f"uuid='{contact.uuid}'"
        mr_mocks.contact_parse_query(query, cleaned=query)

        # create flow start with exclude_in_other and exclude_reruns both left unchecked
        self.assertUpdateSubmit(
            start_url,
            self.admin,
            {"flow": flow.id, "contact_search": get_contact_search(query=query)},
        )

        self.assertEqual(
            mr_mocks.calls["flow_start"][-1],
            call(
                self.org,
                self.admin,
                typ="M",
                flow=flow,
                groups=[],
                contacts=[],
                urns=[],
                query=query,
                exclude=Exclusions(),
                params={},
            ),
        )

    @mock_mailroom
    def test_start_seeded_contact(self, mr_mocks):
        contact = self.create_contact("Bob", phone="+593979099111")
        other = self.create_contact("Jim", phone="+593979099222")
        flow = self.create_flow("Test")
        current = self.create_flow("Current")

        start_url = f"{reverse('flows.flow_start', args=[])}?c={contact.uuid}"

        # seeded with a single contact, the recipients are fixed
        response = self.assertUpdateFetch(start_url, [self.editor, self.admin], form_fields=["flow", "contact_search"])
        attrs = response.context["form"].fields["contact_search"].widget.attrs
        self.assertTrue(attrs.get("fixed"))
        self.assertNotIn("current_flow", attrs)

        # if the contact is in a flow, that's passed to the widget so it can ask for confirmation
        contact.current_flow = current
        contact.save(update_fields=("current_flow",))

        response = self.assertUpdateFetch(start_url, [self.admin], form_fields=["flow", "contact_search"])
        attrs = response.context["form"].fields["contact_search"].widget.attrs
        self.assertTrue(attrs.get("fixed"))
        self.assertEqual("Current", attrs.get("current_flow"))

        # submitted recipients are ignored - the start is locked to the seeded contact
        self.assertUpdateSubmit(
            start_url,
            self.admin,
            {"flow": flow.id, "contact_search": get_contact_search(contacts=[other])},
        )

        self.assertEqual(
            mr_mocks.calls["flow_start"][-1],
            call(
                self.org,
                self.admin,
                typ="M",
                flow=flow,
                groups=[],
                contacts=[contact],
                urns=[],
                query=None,
                exclude=Exclusions(),
                params={},
            ),
        )

        # a submitted in_a_flow exclusion is ignored - the user has already confirmed interrupting
        # the contact's current flow
        contact_search = dict(
            recipients=[{"id": str(contact.uuid), "name": contact.name, "type": "contact"}],
            advanced=False,
            exclusions={"in_a_flow": True, "non_active": True},
        )
        self.assertUpdateSubmit(
            start_url,
            self.admin,
            {"flow": flow.id, "contact_search": json.dumps(contact_search)},
        )

        self.assertEqual(
            mr_mocks.calls["flow_start"][-1],
            call(
                self.org,
                self.admin,
                typ="M",
                flow=flow,
                groups=[],
                contacts=[contact],
                urns=[],
                query=None,
                exclude=Exclusions(non_active=True),
                params={},
            ),
        )

        # seeding with multiple contacts doesn't lock the recipients
        multi_url = f"{reverse('flows.flow_start', args=[])}?c={contact.uuid},{other.uuid}"
        response = self.assertUpdateFetch(multi_url, [self.admin], form_fields=["flow", "contact_search"])
        self.assertNotIn("fixed", response.context["form"].fields["contact_search"].widget.attrs)

        # seeding with another org's contact doesn't lock the recipients
        other_org_contact = self.create_contact("Hans", phone="+593979099333", org=self.org2)
        other_org_url = f"{reverse('flows.flow_start', args=[])}?c={other_org_contact.uuid}"
        response = self.assertUpdateFetch(other_org_url, [self.admin], form_fields=["flow", "contact_search"])
        self.assertNotIn("fixed", response.context["form"].fields["contact_search"].widget.attrs)

    @mock_mailroom
    def test_start_contacts_with_tickets(self, mr_mocks):
        contact = self.create_contact("Bob", phone="+593979099111")
        messaging = self.create_flow("Messaging")
        voice = self.create_flow("Voice", flow_type=Flow.TYPE_VOICE)
        background = self.create_flow("Background", flow_type=Flow.TYPE_BACKGROUND)
        start_url = reverse("flows.flow_start")

        # messaging and voice flow starts note that contacts with open tickets are excluded, background ones don't
        for flow, excludes in ((messaging, True), (voice, True), (background, False)):
            response = self.assertUpdateFetch(
                f"{start_url}?flow={flow.id}", [self.admin], form_fields=["flow", "contact_search"]
            )
            attrs = response.context["form"].fields["contact_search"].widget.attrs
            self.assertEqual(excludes, attrs.get("excludes_tickets", False))
            self.assertNotIn("blocked_by_ticket", response.context)

        # a single contact without an open ticket can be started as normal
        response = self.assertUpdateFetch(
            f"{start_url}?c={contact.uuid}", [self.admin], form_fields=["flow", "contact_search"]
        )
        self.assertNotIn("blocked_by_ticket", response.context)
        self.assertContains(response, 'type="submit"')

        ticket = self.create_ticket(contact)
        contact.refresh_from_db()

        # but a single contact with an open ticket can't be, and the start form isn't shown
        for url in (f"{start_url}?c={contact.uuid}", f"{start_url}?flow={messaging.id}&c={contact.uuid}"):
            response = self.requestView(url, self.admin)
            self.assertEqual(Contact.START_BLOCKED_BY_TICKET, response.context["blocked_by_ticket"])
            self.assertContains(response, "This contact has an open ticket.")
            self.assertNotContains(response, "<temba-contact-search")
            self.assertNotContains(response, 'type="submit"')

        # unless that's in a background flow
        response = self.assertUpdateFetch(
            f"{start_url}?flow={background.id}&c={contact.uuid}", [self.admin], form_fields=["flow", "contact_search"]
        )
        self.assertNotIn("blocked_by_ticket", response.context)
        self.assertContains(response, 'type="submit"')

        # and submitting a start for them is rejected too
        for flow in (messaging, voice):
            self.assertUpdateSubmit(
                f"{start_url}?c={contact.uuid}",
                self.admin,
                {"flow": flow.id, "contact_search": get_contact_search(contacts=[contact])},
                form_errors={"__all__": Contact.START_BLOCKED_BY_TICKET},
                object_unchanged=flow,
            )

        self.assertEqual([], mr_mocks.calls["flow_start"])

        self.assertUpdateSubmit(
            f"{start_url}?c={contact.uuid}",
            self.admin,
            {"flow": background.id, "contact_search": get_contact_search(contacts=[contact])},
        )
        self.assertEqual([contact], mr_mocks.calls["flow_start"][-1].kwargs["contacts"])

        # once their ticket is closed, they can be started again
        ticket.status = Ticket.STATUS_CLOSED
        ticket.save(update_fields=("status",))

        response = self.requestView(f"{start_url}?c={contact.uuid}", self.admin)
        self.assertNotIn("blocked_by_ticket", response.context)

        self.assertUpdateSubmit(
            f"{start_url}?c={contact.uuid}",
            self.admin,
            {"flow": messaging.id, "contact_search": get_contact_search(contacts=[contact])},
        )
        self.assertEqual(messaging, mr_mocks.calls["flow_start"][-1].kwargs["flow"])

    @mock_mailroom
    def test_start_background_flow(self, mr_mocks):
        flow = self.create_flow("Background", flow_type=Flow.TYPE_BACKGROUND)

        # create flow start with a query
        mr_mocks.contact_parse_query("frank", cleaned='name ~ "frank"')

        start_url = f"{reverse('flows.flow_start', args=[])}?flow={flow.id}"
        self.assertUpdateSubmit(
            start_url, self.admin, {"flow": flow.id, "contact_search": get_contact_search(query="frank")}
        )

        self.assertEqual(
            mr_mocks.calls["flow_start"][-1],
            call(
                self.org,
                self.admin,
                typ="M",
                flow=flow,
                groups=[],
                contacts=[],
                urns=[],
                query='name ~ "frank"',
                exclude=Exclusions(),
                params={},
            ),
        )

    def test_copy_view(self):
        flow = self.get_flow("color")

        self.login(self.admin)

        response = self.client.post(reverse("flows.flow_copy", args=[flow.id]))

        flow_copy = Flow.objects.get(org=self.org, name="Copy of %s" % flow.name)

        self.assertRedirect(response, reverse("flows.flow_editor", args=[flow_copy.uuid]))

    def test_recent_contacts(self):
        flow = self.create_flow("Test")
        contact1 = self.create_contact("Bob", phone="0979111111")
        contact2 = self.create_contact("", phone="0979222222")
        node1_exit1_uuid = "805f5073-ce96-4b6a-ab9f-e77dd412f83b"
        node2_uuid = "fcc47dc4-306b-4b2f-ad72-7e53f045c3c4"

        seg1_url = reverse("flows.flow_recent_contacts", args=[flow.uuid, node1_exit1_uuid, node2_uuid])

        # nothing set in valkey just means empty list
        self.assertRequestDisallowed(seg1_url, [None, self.agent, self.admin2])
        response = self.assertReadFetch(seg1_url, [self.editor, self.admin])
        self.assertEqual([], response.json())

        def add_recent_contact(exit_uuid: str, dest_uuid: str, contact, text: str, ts: float):
            r = get_valkey_connection()
            member = f"{uuid4()}|{contact.id}|{text}"  # text is prefixed with a random value to keep it unique
            r.zadd(f"recent_contacts:{exit_uuid}:{dest_uuid}", mapping={member: ts})

        add_recent_contact(node1_exit1_uuid, node2_uuid, contact1, "Hi there", 1639338554.969123)
        add_recent_contact(node1_exit1_uuid, node2_uuid, contact2, "|x|", 1639338555.234567)
        add_recent_contact(node1_exit1_uuid, node2_uuid, contact1, "Sounds good", 1639338561.345678)

        response = self.assertReadFetch(seg1_url, [self.editor, self.admin])
        self.assertEqual(
            [
                {
                    "contact": {"uuid": str(contact1.uuid), "name": "Bob"},
                    "operand": "Sounds good",
                    "time": "2021-12-12T19:49:21.345678+00:00",
                },
                {
                    "contact": {"uuid": str(contact2.uuid), "name": "0979 222 222"},
                    "operand": "|x|",
                    "time": "2021-12-12T19:49:15.234567+00:00",
                },
                {
                    "contact": {"uuid": str(contact1.uuid), "name": "Bob"},
                    "operand": "Hi there",
                    "time": "2021-12-12T19:49:14.969123+00:00",
                },
            ],
            response.json(),
        )

    def test_result_chart(self):
        flow1 = self.create_flow("Test 1")

        # chart URL with a result key
        chart_url = reverse("flows.flow_result_chart", args=[flow1.uuid, "color"])

        self.assertRequestDisallowed(chart_url, [None, self.agent])

        # check with no data
        response = self.assertReadFetch(chart_url, [self.editor, self.admin])
        self.assertEqual({"data": {"labels": [], "datasets": []}}, response.json())

        # simulate some category data
        flow1.info["results"] = [{"key": "color", "name": "Color"}, {"key": "beer", "name": "Beer"}]
        flow1.save(update_fields=("info",))

        flow1.result_counts.create(result="color", category="Red", count=3)
        flow1.result_counts.create(result="color", category="Blue", count=2)
        flow1.result_counts.create(result="color", category="Other", count=1)
        flow1.result_counts.create(result="beer", category="Primus", count=7)

        response = self.assertReadFetch(chart_url, [self.editor, self.admin])
        self.assertEqual(
            {"data": {"labels": ["Red", "Blue", "Other"], "datasets": [{"label": "Color", "data": [3, 2, 1]}]}},
            response.json(),
        )

        # test "Other" category sorting - "Other" should come last even with higher count
        flow1.result_counts.filter(result="color").delete()
        flow1.result_counts.create(result="color", category="Red", count=1)
        flow1.result_counts.create(result="color", category="Other", count=5)
        flow1.result_counts.create(result="color", category="Blue", count=3)

        response = self.assertReadFetch(chart_url, [self.editor, self.admin])
        self.assertEqual(
            {"data": {"labels": ["Blue", "Red", "Other"], "datasets": [{"label": "Color", "data": [3, 1, 5]}]}},
            response.json(),
        )

        # test non-existent result key
        chart_url_invalid = reverse("flows.flow_result_chart", args=[flow1.uuid, "nonexistent"])
        response = self.assertReadFetch(chart_url_invalid, [self.editor, self.admin])
        self.assertEqual({"data": {"labels": [], "datasets": []}}, response.json())

    def test_results(self):
        flow = self.create_flow("Test 1")

        results_url = reverse("flows.flow_results", args=[flow.uuid])

        self.assertRequestDisallowed(results_url, [None, self.agent])
        self.assertReadFetch(results_url, [self.editor, self.admin])

        flow.release(self.admin)

        response = self.requestView(results_url, self.admin)
        self.assertEqual(404, response.status_code)

    @patch("django.utils.timezone.now")
    def test_engagement_timeline(self, mock_now):
        """Test timeline rollup modes for different date ranges"""
        mock_now.return_value = datetime(2024, 11, 25, 12, 5, 0, tzinfo=tzone.utc)

        flow1 = self.create_flow("Test 1")
        timeline_url = reverse("flows.flow_engagement_timeline", args=[flow1.uuid])

        # check permissions
        self.assertRequestDisallowed(timeline_url, [None, self.agent])

        # empty timeline
        response = self.requestView(timeline_url, self.admin).json()

        # should be empty
        self.assertEqual(response["rollup_by"], "day")
        self.assertEqual(len(response["data"]["labels"]), 0)
        self.assertEqual(response["data"]["datasets"][0]["data"], [])

        # test week rollup mode (1-3 years ago)
        flow1.counts.create(scope="msgsin:date:2022-11-25", count=5)
        flow1.counts.create(scope="msgsin:date:2022-11-29", count=50)
        flow1.counts.create(scope="msgsin:date:2022-12-1", count=8)
        response = self.requestView(timeline_url, self.admin).json()

        self.assertEqual("week", response["rollup_by"])
        self.assertEqual(["2022-11-21", "2022-11-28"], response["data"]["labels"][0:2])
        self.assertEqual(5, response["data"]["datasets"][0]["data"][0])
        self.assertEqual(58, response["data"]["datasets"][0]["data"][1])
        flow1.counts.all().delete()

        # test month rollup mode (>3 years ago)
        flow1.counts.create(scope="msgsin:date:2020-11-25", count=10)
        flow1.counts.create(scope="msgsin:date:2020-12-26", count=5)
        flow1.counts.create(scope="msgsin:date:2020-12-27", count=6)
        response = self.requestView(timeline_url, self.admin).json()
        self.assertEqual("month", response["rollup_by"])
        self.assertEqual(["2020-11-01", "2020-12-01"], response["data"]["labels"][0:2])
        self.assertEqual(10, response["data"]["datasets"][0]["data"][0])
        self.assertEqual(11, response["data"]["datasets"][0]["data"][1])

    @patch("django.utils.timezone.now")
    def test_engagement_progress(self, mock_now):
        mock_now.return_value = datetime(2024, 11, 25, 12, 5, 0, tzinfo=tzone.utc)

        flow1 = self.create_flow("Test 1")
        progress_url = reverse("flows.flow_engagement_progress", args=[flow1.uuid])

        # check permissions
        self.assertRequestDisallowed(progress_url, [None, self.agent])

        # empty progress
        response = self.requestView(progress_url, self.admin)
        self.assertEqual(
            {
                "data": {
                    "labels": ["Ongoing", "Completed", "Expired", "Interrupted"],
                    "datasets": [{"label": "Progress", "data": [0, 0, 0, 0]}],
                }
            },
            response.json(),
        )

        # with run data
        from temba.flows.models import FlowRun

        flow1.counts.create(scope=f"status:{FlowRun.STATUS_ACTIVE}", count=5)
        flow1.counts.create(scope=f"status:{FlowRun.STATUS_COMPLETED}", count=3)
        flow1.counts.create(scope=f"status:{FlowRun.STATUS_EXPIRED}", count=1)

        response = self.requestView(progress_url, self.admin)
        resp_data = response.json()["data"]
        self.assertEqual([5, 3, 1, 0], resp_data["datasets"][0]["data"])

        # test additional status types for complete coverage
        flow1.counts.create(scope=f"status:{FlowRun.STATUS_WAITING}", count=2)
        flow1.counts.create(scope=f"status:{FlowRun.STATUS_FAILED}", count=1)
        flow1.counts.create(scope=f"status:{FlowRun.STATUS_INTERRUPTED}", count=3)

        response = self.requestView(progress_url, self.admin)
        resp_data = response.json()["data"]
        # Ongoing includes both ACTIVE (5) and WAITING (2) = 7
        self.assertEqual([7, 3, 1, 4], resp_data["datasets"][0]["data"])

    @patch("django.utils.timezone.now")
    def test_engagement_dow(self, mock_now):
        mock_now.return_value = datetime(2024, 11, 25, 12, 5, 0, tzinfo=tzone.utc)

        flow1 = self.create_flow("Test 1")
        dow_url = reverse("flows.flow_engagement_dow", args=[flow1.uuid])

        # check permissions
        self.assertRequestDisallowed(dow_url, [None, self.agent])

        # empty dow
        response = self.requestView(dow_url, self.admin)
        resp_data = response.json()["data"]
        self.assertEqual(7, len(resp_data["labels"]))  # 7 days
        self.assertEqual([0, 0, 0, 0, 0, 0, 0], resp_data["datasets"][0]["data"])

        # with dow data
        flow1.counts.create(scope="msgsin:dow:0", count=4)  # Sunday
        flow1.counts.create(scope="msgsin:dow:1", count=2)  # Monday

        response = self.requestView(dow_url, self.admin)
        resp_data = response.json()["data"]
        self.assertEqual([4, 2, 0, 0, 0, 0, 0], resp_data["datasets"][0]["data"])

        # test that labels are datetime objects starting from Sunday
        labels = resp_data["labels"]
        self.assertEqual(7, len(labels))
        # Labels should be datetime objects based on 2023-01-01 (Sunday) + day_index
        self.assertIsInstance(labels[0], str)  # datetime gets serialized to string in JSON

    def test_engagement_dow_labels(self):
        """Test that EngagementDow generates correct day labels"""
        flow1 = self.create_flow("Test 1")
        dow_url = reverse("flows.flow_engagement_dow", args=[flow1.uuid])

        response = self.requestView(dow_url, self.admin)
        resp_data = response.json()["data"]

        # The view should create labels for 7 days starting from Sunday (2023-01-01)
        labels = resp_data["labels"]
        self.assertEqual(7, len(labels))

    @patch("django.utils.timezone.now")
    def test_engagement_hod(self, mock_now):
        mock_now.return_value = datetime(2024, 11, 25, 12, 5, 0, tzinfo=tzone.utc)

        flow1 = self.create_flow("Test 1")
        hod_url = reverse("flows.flow_engagement_hod", args=[flow1.uuid])

        # check permissions
        self.assertRequestDisallowed(hod_url, [None, self.agent])

        # empty hod
        response = self.requestView(hod_url, self.admin)
        resp_data = response.json()["data"]
        self.assertEqual(24, len(resp_data["labels"]))  # 24 hours
        self.assertEqual([0] * 24, resp_data["datasets"][0]["data"])

        # hod data is stored in UTC, so we need to adjust for the timezone
        kigali_offset = 2
        flow1.counts.create(scope=f"msgsin:hour:{9 - kigali_offset}", count=5)  # 9a in Kigali
        flow1.counts.create(scope=f"msgsin:hour:{12 - kigali_offset}", count=3)  # 12p in Kigali

        response = self.requestView(hod_url, self.admin)
        resp_data = response.json()["data"]
        # Check that hour 9 and 12 have the right values
        self.assertEqual(5, resp_data["datasets"][0]["data"][9])
        self.assertEqual(3, resp_data["datasets"][0]["data"][12])

    def test_engagement_hod_labels(self):
        """Test that EngagementHod generates correct hour labels"""
        flow1 = self.create_flow("Test 1")
        hod_url = reverse("flows.flow_engagement_hod", args=[flow1.uuid])

        response = self.requestView(hod_url, self.admin)
        resp_data = response.json()["data"]

        # Test that labels are properly formatted as "00:00", "01:00", etc.
        labels = resp_data["labels"]
        self.assertEqual(24, len(labels))
        self.assertEqual("00:00", labels[0])
        self.assertEqual("01:00", labels[1])
        self.assertEqual("12:00", labels[12])
        self.assertEqual("23:00", labels[23])

    def test_activity(self):
        flow1 = self.create_flow("Test 1")
        flow2 = self.create_flow("Test 2")

        flow1.counts.create(scope="node:01c175da-d23d-40a4-a845-c4a9bb4b481a", count=4)
        flow1.counts.create(scope="node:400d6b5e-c963-42a1-a06c-50bb9b1e38b1", count=5)

        flow1.counts.create(
            scope="segment:1fff74f4-c81f-4f4c-a03d-58d113c17da1:01c175da-d23d-40a4-a845-c4a9bb4b481a", count=3
        )
        flow1.counts.create(
            scope="segment:1fff74f4-c81f-4f4c-a03d-58d113c17da1:01c175da-d23d-40a4-a845-c4a9bb4b481a", count=4
        )
        flow1.counts.create(
            scope="segment:6f607948-f3f0-4a6a-94b8-7fdd877895ca:400d6b5e-c963-42a1-a06c-50bb9b1e38b1", count=5
        )
        flow2.counts.create(
            scope="segment:a4fe3ada-b062-47e4-be58-bcbe1bca31b4:74a53ff4-fe63-4d89-875e-cae3caca177c", count=6
        )

        activity_url = reverse("flows.flow_activity", args=[flow1.uuid])

        self.assertRequestDisallowed(activity_url, [None, self.agent])

        response = self.assertReadFetch(activity_url, [self.editor, self.admin])
        self.assertEqual(
            {
                "nodes": {"01c175da-d23d-40a4-a845-c4a9bb4b481a": 4, "400d6b5e-c963-42a1-a06c-50bb9b1e38b1": 5},
                "segments": {
                    "1fff74f4-c81f-4f4c-a03d-58d113c17da1:01c175da-d23d-40a4-a845-c4a9bb4b481a": 7,
                    "6f607948-f3f0-4a6a-94b8-7fdd877895ca:400d6b5e-c963-42a1-a06c-50bb9b1e38b1": 5,
                },
            },
            response.json(),
        )

    def test_activity_inactive_flow(self):
        flow = self.create_flow("Deleted")
        flow.release(self.admin)

        self.login(self.admin)

        response = self.client.get(reverse("flows.flow_revisions", args=[flow.uuid]))

        self.assertEqual(404, response.status_code)

        response = self.client.get(reverse("flows.flow_activity", args=[flow.uuid]))

        self.assertEqual(404, response.status_code)

    @mock_mailroom
    def test_write_protection(self, mr_mocks):
        flow = self.get_flow("favorites_v13")
        flow_json = flow.get_definition()
        flow_json_copy = flow_json.copy()

        self.assertEqual(1, flow_json["revision"])

        self.login(self.admin)

        # rename so the next save isn't a no-op (identical definitions don't create
        # a new revision)
        flow.name = "Favorites Renamed"
        flow.save(update_fields=("name",))

        # saving should work
        flow.save_revision(self.admin, flow_json)

        self.assertEqual(2, flow_json["revision"])

        # we can't save with older revision number
        with self.assertRaises(FlowUserConflictException):
            flow.save_revision(self.admin, flow_json_copy)

        # make flow definition invalid by creating a duplicate node UUID - goflow rejects it on inspect, which we
        # don't reimplement in tests, so stub the validation failure mailroom would return
        mode0_uuid = flow_json["nodes"][0]["uuid"]
        flow_json["nodes"][1]["uuid"] = mode0_uuid

        mr_mocks.exception(mailroom.FlowValidationException(f"node UUID {mode0_uuid} isn't unique"))
        with self.assertRaises(mailroom.FlowValidationException) as cm:
            flow.save_revision(self.admin, flow_json)

        self.assertEqual(f"node UUID {mode0_uuid} isn't unique", str(cm.exception))

        # check view converts exception to error response
        mr_mocks.exception(mailroom.FlowValidationException(f"node UUID {mode0_uuid} isn't unique"))
        response = self.client.post(
            reverse("flows.flow_revisions", args=[flow.uuid]), data=flow_json, content_type="application/json"
        )

        self.assertEqual(400, response.status_code)
        self.assertEqual(
            {
                "status": "failure",
                "description": "Your flow failed validation. Please refresh your browser.",
                "detail": f"node UUID {mode0_uuid} isn't unique",
            },
            response.json(),
        )

    @mock_mailroom
    def test_change_language(self, mr_mocks):
        self.org.set_flow_languages(self.admin, ["eng", "spa", "ara"])

        flow = self.get_flow("favorites_v13")

        change_url = reverse("flows.flow_change_language", args=[flow.uuid])

        # agents don't have permission to change the language
        self.login(self.agent)
        response = self.client.post(change_url, {"language": "spa"}, content_type="application/json")
        self.assertPermissionDenied(response)

        self.login(self.admin)

        # this endpoint is POST-only - a GET is not allowed (rather than 500ing on a missing template)
        response = self.client.get(change_url)
        self.assertEqual(405, response.status_code)

        # a missing or empty language is rejected
        response = self.client.post(change_url, {"language": ""}, content_type="application/json")
        self.assertEqual(400, response.status_code)
        self.assertEqual("Not a valid language.", response.json()["description"])

        # a language that isn't one of the org's flow languages is rejected
        response = self.client.post(change_url, {"language": "fra"}, content_type="application/json")
        self.assertEqual(400, response.status_code)
        self.assertEqual("Not a valid language.", response.json()["description"])

        # the flow's current base language is rejected
        response = self.client.post(change_url, {"language": "eng"}, content_type="application/json")
        self.assertEqual(400, response.status_code)
        self.assertEqual("Flow is already in this language.", response.json()["description"])

        # changing to a valid language switches the base language and saves a new revision. mailroom does the actual
        # re-basing of the definition so we just mock the definition it returns.
        changed_def = flow.get_definition()
        changed_def["language"] = "spa"
        changed_def["localization"]["eng"] = {}
        changed_def["nodes"][0]["actions"][0]["text"] = "¿Cuál es tu color favorito?"
        mr_mocks.flow_change_language(changed_def)

        response = self.client.post(change_url, {"language": "spa"}, content_type="application/json")
        self.assertEqual(200, response.status_code)
        self.assertEqual("success", response.json()["status"])
        self.assertEqual(flow.revisions.order_by("-revision").first().revision, response.json()["revision"]["revision"])

        # the flow's current (base-language English) definition was sent to mailroom along with the target language
        passed_def, passed_lang = mr_mocks.calls["flow_change_language"][-1].args
        self.assertEqual("eng", passed_def["language"])
        self.assertEqual("spa", passed_lang)

        # the re-based definition mailroom returned is what we saved
        flow_def = flow.get_definition()
        self.assertEqual("spa", flow_def["language"])
        self.assertIn("eng", flow_def["localization"])
        self.assertEqual("¿Cuál es tu color favorito?", flow_def["nodes"][0]["actions"][0]["text"])

        # if mailroom rejects the resulting definition we return a failure response rather than a stack trace
        mr_mocks.exception(mailroom.FlowValidationException("node isn't unique"))
        response = self.client.post(change_url, {"language": "ara"}, content_type="application/json")
        self.assertEqual(400, response.status_code)
        self.assertEqual(
            {
                "status": "failure",
                "description": "Your flow failed validation. Please refresh your browser.",
                "detail": "node isn't unique",
            },
            response.json(),
        )

        # a request body that isn't valid JSON is rejected
        response = self.client.post(change_url, data="not json", content_type="application/json")
        self.assertEqual(400, response.status_code)
        self.assertEqual("Invalid request.", response.json()["description"])

        # a version conflict whilst saving the new revision is converted to an error response
        mr_mocks.flow_change_language(flow.get_definition())
        with patch("temba.flows.models.Flow.save_revision") as mock_save_revision:
            mock_save_revision.side_effect = FlowVersionConflictException(13)
            response = self.client.post(change_url, {"language": "ara"}, content_type="application/json")
        self.assertEqual(400, response.status_code)
        self.assertEqual(
            {
                "status": "failure",
                "description": "Your flow has been upgraded to the latest version. "
                "In order to continue editing, please refresh your browser.",
                "detail": None,
            },
            response.json(),
        )

        # a user conflict whilst saving the new revision is converted to an error response
        mr_mocks.flow_change_language(flow.get_definition())
        with patch("temba.flows.models.Flow.save_revision") as mock_save_revision:
            mock_save_revision.side_effect = FlowUserConflictException("Jim", None)
            response = self.client.post(change_url, {"language": "ara"}, content_type="application/json")
        self.assertEqual(400, response.status_code)
        self.assertEqual(
            {
                "status": "failure",
                "description": "Jim is currently editing this Flow. "
                "Your changes will not be saved until you refresh your browser.",
                "detail": None,
            },
            response.json(),
        )

        # a failed request to mailroom is converted to an error response
        mr_mocks.exception(mailroom.RequestException("", "", MockResponse(500, '{"error": "boom"}')))
        response = self.client.post(change_url, {"language": "ara"}, content_type="application/json")
        self.assertEqual(500, response.status_code)
        self.assertEqual("Unable to change the flow's language.", response.json()["description"])

    def test_export_results(self):
        export_url = reverse("flows.flow_export_results")

        flow1 = self.create_flow("Test 1")
        flow2 = self.create_flow("Test 2")
        testers = self.create_group("Testers", contacts=[])
        gender = self.create_field("gender", "Gender")

        self.assertRequestDisallowed(export_url, [None, self.agent])
        response = self.assertUpdateFetch(
            export_url + f"?ids={flow1.id},{flow2.id}",
            [self.editor, self.admin],
            form_fields=(
                "start_date",
                "end_date",
                "with_fields",
                "with_groups",
                "flows",
                "extra_urns",
                "responded_only",
            ),
        )
        self.assertNotContains(response, "already an export in progress")

        # anon orgs don't see urns option
        with self.anonymous(self.org):
            response = self.client.get(export_url)
            self.assertEqual(
                ["start_date", "end_date", "with_fields", "with_groups", "flows", "responded_only", "loc"],
                list(response.context["form"].fields.keys()),
            )

        # create a dummy export task so that we won't be able to export
        blocking_export = ResultsExport.create(
            self.org, self.admin, start_date=date.today() - timedelta(days=7), end_date=date.today()
        )

        response = self.client.get(export_url)
        self.assertContains(response, "already an export in progress")

        # check we can't submit in case a user opens the form and whilst another user is starting an export
        response = self.client.post(
            export_url, {"start_date": "2022-06-28", "end_date": "2022-09-28", "flows": [flow1.id]}
        )
        self.assertContains(response, "already an export in progress")
        self.assertEqual(1, Export.objects.count())

        # mark that one as finished so it's no longer a blocker
        blocking_export.status = Export.STATUS_COMPLETE
        blocking_export.save(update_fields=("status",))

        # try to submit with no values
        response = self.client.post(export_url, {})
        self.assertFormError(response.context["form"], "start_date", "This field is required.")
        self.assertFormError(response.context["form"], "end_date", "This field is required.")
        self.assertFormError(response.context["form"], "flows", "This field is required.")

        response = self.client.post(
            export_url,
            {
                "start_date": "2022-06-28",
                "end_date": "2022-09-28",
                "flows": [flow1.id],
                "with_groups": [testers.id],
                "with_fields": [gender.id],
            },
        )
        self.assertEqual(200, response.status_code)

        export = Export.objects.exclude(id=blocking_export.id).get()
        self.assertEqual("results", export.export_type)
        self.assertEqual(date(2022, 6, 28), export.start_date)
        self.assertEqual(date(2022, 9, 28), export.end_date)
        self.assertEqual(
            {
                "flow_ids": [flow1.id],
                "with_groups": [testers.id],
                "with_fields": [gender.id],
                "extra_urns": [],
                "responded_only": False,
            },
            export.config,
        )

    @mock_mailroom
    def test_simulate(self, mr_mocks):
        flow = self.create_flow("Test")

        payload = {
            "contact": {"uuid": "8ada55d2-2f5e-4d56-8f10-26971332cd1c"},
            "trigger": {"type": "manual"},
            "flow": {"uuid": "5c5d5ba9-adb9-41c2-9da9-590e90b3cf01", "name": "Test"},
        }

        self.login(self.admin)
        simulate_url = reverse("flows.flow_simulate", args=[flow.uuid])

        # a mailroom error becomes a 500
        mr_mocks.exception(mailroom.RequestException("sim/start", {}, MockJsonResponse(400, {"error": "boom"})))

        response = self.client.post(simulate_url, json.dumps(payload), content_type="application/json")
        self.assertEqual(500, response.status_code)

        # start a flow
        response = self.client.post(simulate_url, json.dumps(payload), content_type="application/json")
        self.assertEqual(200, response.status_code)
        self.assertEqual({}, response.json()["session"])

        (sent,) = mr_mocks.calls["sim_start"][0].args

        self.assertEqual(flow.org_id, sent["org_id"])
        self.assertEqual({"uuid": "8ada55d2-2f5e-4d56-8f10-26971332cd1c"}, sent["contact"])
        self.assertEqual({"type": "manual", "user": {"uuid": str(self.admin.uuid), "name": "Andy"}}, sent["trigger"])
        self.assertEqual(1, len(sent["assets"]["channels"]))  # fake channel

        # try a resume
        payload = {
            "contact": {"uuid": "8ada55d2-2f5e-4d56-8f10-26971332cd1c", "fields": {"age": Decimal("39")}},
            "session": {"uuid": "01979ebb-044a-7768-a0d0-0455ef356441", "status": "waiting"},
            "resume": {},
            "flow": {},
        }

        mr_mocks.exception(mailroom.RequestException("sim/resume", {}, MockJsonResponse(400, {"error": "boom"})))

        response = self.client.post(simulate_url, json.dumps(payload), content_type="application/json")
        self.assertEqual(500, response.status_code)

        response = self.client.post(simulate_url, json.dumps(payload), content_type="application/json")
        self.assertEqual(200, response.status_code)
        self.assertEqual({}, response.json()["session"])

        (sent,) = mr_mocks.calls["sim_resume"][0].args

        self.assertEqual(flow.org_id, sent["org_id"])
        self.assertEqual({"uuid": "01979ebb-044a-7768-a0d0-0455ef356441", "status": "waiting"}, sent["session"])
        self.assertEqual(1, len(sent["assets"]["channels"]))  # fake channel

    @mock_mailroom
    def test_simulate_voice(self, mr_mocks):
        flow = self.create_flow("Test", flow_type=Flow.TYPE_VOICE)

        self.login(self.admin)
        simulate_url = reverse("flows.flow_simulate", args=[flow.uuid])

        response = self.client.post(
            simulate_url,
            {
                "contact": {"uuid": "8ada55d2-2f5e-4d56-8f10-26971332cd1c"},
                "trigger": {"type": "manual"},
                "flow": {},
            },
            content_type="application/json",
        )

        self.assertEqual(200, response.status_code)
        self.assertEqual({"session": {}, "events": []}, response.json())

        (sent,) = mr_mocks.calls["sim_start"][0].args

        # since this is an IVR flow, we need to include a call
        self.assertEqual(
            {
                "uuid": "01979e0b-3072-7345-ae19-879750caaaf6",
                "channel": {"uuid": "440099cf-200c-4d45-a8e7-4a564f4a0e8b", "name": "Test Channel"},
                "urn": "tel:+12065551212",
            },
            sent["call"],
        )
        self.assertEqual({"type": "manual", "user": {"uuid": str(self.admin.uuid), "name": "Andy"}}, sent["trigger"])

    def test_delete(self):
        child = self.create_flow("Child")
        parent = self.create_flow("Parent")
        parent.field_dependencies.add(self.create_field("age", "Age"))
        parent.flow_dependencies.add(child)

        flow1_delete_url = reverse("flows.flow_delete", args=[child.uuid])
        flow2_delete_url = reverse("flows.flow_delete", args=[parent.uuid])

        self.assertRequestDisallowed(flow1_delete_url, [None, self.agent, self.admin2])
        self.assertDeleteFetch(flow1_delete_url, [self.editor, self.admin])
        self.assertDeleteSubmit(flow1_delete_url, self.admin, object_deactivated=child, success_status=200)

        # parent flow should now be marked as having issues
        parent.refresh_from_db()
        self.assertTrue(parent.is_active)
        self.assertTrue(parent.has_issues)
        self.assertNotIn(set(), set(parent.flow_dependencies.all()))

        # deleting our parent flow should also work
        self.assertDeleteFetch(flow2_delete_url, [self.editor, self.admin])
        self.assertDeleteSubmit(flow2_delete_url, self.admin, object_deactivated=parent, success_status=200)

        parent.refresh_from_db()
        self.assertEqual(0, parent.field_dependencies.all().count())
        self.assertEqual(0, parent.flow_dependencies.all().count())

    def test_delete_of_inactive_flow(self):
        flow = self.create_flow("Test")
        flow.release(self.admin)

        self.login(self.admin)
        response = self.client.post(reverse("flows.flow_delete", args=[flow.pk]))

        # can't delete already released flow
        self.assertEqual(response.status_code, 404)

    def test_open_ended_no_chart(self):
        flow = self.create_flow("Open Ended Flow")

        # define a result that ends up with only one category
        flow.info["results"] = [{"key": "feedback", "name": "Feedback", "categories": ["All Responses"]}]
        flow.save(update_fields=("info",))

        # add a single category count
        flow.result_counts.create(result="feedback", category="Yes", count=5)
        results_url = reverse("flows.flow_results", args=[flow.uuid])

        self.login(self.admin)
        response = self.client.get(results_url)
        self.assertEqual(200, response.status_code)

        # page should not include a chart for feedback
        self.assertNotContains(response, "Feedback")

    @mock_mailroom
    def test_interrupt(self, mr_mocks):
        flow = self.create_flow("Test Flow")
        other_org_flow = self.create_flow("Other Org Flow", org=self.org2)

        interrupt_url = reverse("flows.flow_interrupt", args=[flow.uuid])
        other_org_interrupt_url = reverse("flows.flow_interrupt", args=[other_org_flow.uuid])

        # anonymous and agents should not have access
        self.assertRequestDisallowed(interrupt_url, [None, self.agent])

        # can't interrupt flow in other org
        self.assertRequestDisallowed(other_org_interrupt_url, [self.admin])

        # fetch the interrupt modal with no waiting contacts
        response = self.assertUpdateFetch(interrupt_url, [self.editor, self.admin], form_fields=("archive",))
        self.assertEqual(0, response.context["run_count"])
        self.assertTrue(response.context["can_interrupt"])
        self.assertContains(response, "There are no contacts currently in this flow")
        self.assertNotContains(response, '<input type="submit"')

        # add some waiting contacts
        flow.counts.create(scope=f"status:{FlowRun.STATUS_WAITING}", count=15)

        # fetch should now show the count
        response = self.assertUpdateFetch(interrupt_url, [self.admin], form_fields=("archive",))
        self.assertEqual(15, response.context["run_count"])
        self.assertTrue(response.context["can_interrupt"])
        self.assertTrue(response.context["can_archive"])
        self.assertContains(response, "15")
        self.assertContains(response, '<input type="submit"')

        # submit the interrupt without archiving
        self.requestView(interrupt_url, self.admin, post_data={})

        # should have called mailroom to interrupt the flow
        self.assertEqual([call(self.org, flow)], mr_mocks.calls["flow_interrupt"])

        # flow should not be archived
        flow.refresh_from_db()
        self.assertFalse(flow.is_archived)

        # submit the interrupt with archive option
        mr_mocks.calls.clear()
        self.requestView(interrupt_url, self.admin, post_data={"archive": True})

        # should have called mailroom to interrupt the flow again
        self.assertEqual([call(self.org, flow)], mr_mocks.calls["flow_interrupt"])

        # flow should now be archived
        flow.refresh_from_db()
        self.assertTrue(flow.is_archived)

        # create a new flow used by a campaign
        campaign_flow = self.create_flow("Campaign Flow")
        campaign_flow.counts.create(scope=f"status:{FlowRun.STATUS_WAITING}", count=10)
        group = self.create_group("Reporters", contacts=[])
        campaign = Campaign.create(self.org, self.admin, "Reminders", group)
        registered = self.create_field("registered", "Registered", value_type="D")
        CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, registered, offset=1, unit="W", flow=campaign_flow, delivery_hour="13"
        )

        campaign_interrupt_url = reverse("flows.flow_interrupt", args=[campaign_flow.uuid])

        # fetch the interrupt modal - should show warning instead of archive checkbox
        response = self.assertUpdateFetch(campaign_interrupt_url, [self.admin], form_fields=("archive",))
        self.assertFalse(response.context["can_archive"])
        self.assertContains(response, "used by active campaigns")
        self.assertNotContains(response, "Archive Flow")

        # submit the interrupt with archive option - should not archive because of campaigns
        mr_mocks.calls.clear()
        self.requestView(campaign_interrupt_url, self.admin, post_data={"archive": True})

        self.assertEqual([call(self.org, campaign_flow)], mr_mocks.calls["flow_interrupt"])

        campaign_flow.refresh_from_db()
        self.assertFalse(campaign_flow.is_archived)

        # test blocking when an interruption is already in progress
        r = get_valkey_connection()
        in_progress_flow = self.create_flow("In Progress Flow")
        in_progress_flow.counts.create(scope=f"status:{FlowRun.STATUS_WAITING}", count=5)
        in_progress_url = reverse("flows.flow_interrupt", args=[in_progress_flow.uuid])

        # set the redis key to indicate an interruption is in progress
        progress_key = f"interrupt_flow_progress:{in_progress_flow.id}"
        r.set(progress_key, 10)

        # fetch should show that we can't interrupt
        response = self.assertUpdateFetch(in_progress_url, [self.admin], form_fields=("archive",))
        self.assertFalse(response.context["can_interrupt"])

        # try to submit the interrupt - should be blocked
        mr_mocks.calls.clear()
        self.requestView(in_progress_url, self.admin, post_data={})

        # should NOT have called mailroom
        self.assertEqual([], mr_mocks.calls["flow_interrupt"])

        # clean up the redis key
        r.delete(progress_key)

        # now it should work
        response = self.assertUpdateFetch(in_progress_url, [self.admin], form_fields=("archive",))
        self.assertTrue(response.context["can_interrupt"])

        self.requestView(in_progress_url, self.admin, post_data={})
        self.assertEqual([call(self.org, in_progress_flow)], mr_mocks.calls["flow_interrupt"])

        # test with redis key set to 0 (interruption complete)
        r.set(progress_key, 0)
        response = self.assertUpdateFetch(in_progress_url, [self.admin], form_fields=("archive",))
        self.assertTrue(response.context["can_interrupt"])

        # clean up
        r.delete(progress_key)
