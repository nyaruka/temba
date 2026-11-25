from unittest.mock import call, patch

from django.urls import reverse

from temba.campaigns.models import Campaign, CampaignEvent
from temba.contacts.models import ContactField, ContactGroup
from temba.flows.models import (
    Flow,
    FlowRevision,
    FlowRun,
    FlowStart,
    FlowStartCount,
    FlowUserConflictException,
    FlowVersionConflictException,
)
from temba.flows.tasks import squash_flow_counts
from temba.globals.models import Global
from temba.tests import CRUDLTestMixin, TembaTest, matchers, mock_mailroom
from temba.tests.engine import MockSessionWriter
from temba.triggers.models import Trigger


class FlowTest(TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        self.contact = self.create_contact("Eric", phone="+250788382382")
        self.contact2 = self.create_contact("Nic", phone="+250788383383")
        self.contact3 = self.create_contact("Norbert", phone="+250788123456")
        self.contact4 = self.create_contact("Teeh", phone="+250788123457", language="por")

        self.other_group = self.create_group("Other", [])

    def test_get_unique_name(self):
        self.assertEqual("Testing", Flow.get_unique_name(self.org, "Testing"))

        # ensure checking against existing flows is case-insensitive
        testing = self.create_flow("TESTING")

        self.assertEqual("Testing 2", Flow.get_unique_name(self.org, "Testing"))
        self.assertEqual("Testing", Flow.get_unique_name(self.org, "Testing", ignore=testing))
        self.assertEqual("Testing", Flow.get_unique_name(self.org2, "Testing"))  # different org

        self.create_flow("Testing 2")

        self.assertEqual("Testing 3", Flow.get_unique_name(self.org, "Testing"))

        # ensure we don't exceed the name length limit
        self.create_flow("X" * 64)

        self.assertEqual(f"{'X' * 62} 2", Flow.get_unique_name(self.org, "X" * 64))

    def test_clean_name(self):
        self.assertEqual("Hello", Flow.clean_name("Hello\0"))
        self.assertEqual("Hello/n", Flow.clean_name("Hello\\n"))
        self.assertEqual("Say 'Hi'", Flow.clean_name('Say "Hi"'))
        self.assertEqual("x" * 64, Flow.clean_name("x" * 100))
        self.assertEqual("a                                b", Flow.clean_name(f"a{' ' * 32}b{' ' * 32}c"))

    @mock_mailroom
    def test_archive(self, mr_mocks):
        flow = self.create_flow("Test")
        flow.archive(self.admin)

        self.assertEqual([call(self.org, flow)], mr_mocks.calls["flow_interrupt"])

        flow.refresh_from_db()
        self.assertEqual(flow.is_archived, True)
        self.assertEqual(flow.is_active, True)

    @mock_mailroom
    def test_release(self, mr_mocks):
        global1 = Global.get_or_create(self.org, self.admin, "api_key", "API Key", "234325")
        flow = self.create_flow("Test")
        flow.global_dependencies.add(global1)

        flow.release(self.admin)

        self.assertEqual([call(self.org, flow)], mr_mocks.calls["flow_interrupt"])

        flow.refresh_from_db()
        self.assertTrue(flow.name.startswith("deleted-"))
        self.assertFalse(flow.is_archived)
        self.assertFalse(flow.is_active)
        self.assertEqual(0, flow.global_dependencies.count())

    @mock_mailroom
    def test_get_definition(self, mr_mocks):
        favorites = self.get_flow("favorites_v13")

        # fill the definition with junk metadata
        rev = favorites.get_current_revision()
        rev.definition["uuid"] = "Nope"
        rev.definition["name"] = "Not the name"
        rev.definition["revision"] = 1234567
        rev.definition["expire_after_minutes"] = 7654
        rev.save(update_fields=("definition",))

        # definition should use values from flow db object
        definition = favorites.get_definition()
        self.assertEqual(definition["uuid"], str(favorites.uuid))
        self.assertEqual(definition["name"], "Favorites")
        self.assertEqual(definition["revision"], 1)
        self.assertEqual(definition["expire_after_minutes"], 720)

        # when saving a new revision we overwrite metadata
        favorites.save_revision(self.admin, rev.definition)
        rev = favorites.get_current_revision()
        self.assertEqual(rev.definition["uuid"], str(favorites.uuid))
        self.assertEqual(rev.definition["name"], "Favorites")
        self.assertEqual(rev.definition["revision"], 2)
        self.assertEqual(rev.definition["expire_after_minutes"], 720)

        # can't get definition of a flow with no revisions
        favorites.revisions.all().delete()
        self.assertRaises(AssertionError, favorites.get_definition)

    @mock_mailroom
    def test_ensure_current_version(self, mr_mocks):
        # importing migrates to latest spec version
        flow = self.get_flow("favorites_v13")
        self.assertEqual(Flow.CURRENT_SPEC_VERSION, flow.version_number)
        self.assertEqual(1, flow.revisions.count())

        # rewind one spec version..
        flow.version_number = "13.0.0"
        flow.save(update_fields=("version_number",))
        rev = flow.revisions.get()
        rev.definition["spec_version"] = "13.0.0"
        rev.spec_version = "13.0.0"
        rev.save()

        old_modified_on = flow.modified_on
        old_saved_on = flow.saved_on

        flow.ensure_current_version()

        # spec migration is itself a recorded change — a new revision is created with
        # the "spec" tag even if the migration is content-equivalent for this fixture
        self.assertEqual(Flow.CURRENT_SPEC_VERSION, flow.version_number)
        self.assertEqual(2, flow.revisions.count())
        latest = flow.revisions.order_by("id").last()
        self.assertEqual("system", latest.created_by.email)
        self.assertEqual({"tags": ["spec"]}, latest.changes)

        # saved on won't have been updated but modified on will
        self.assertEqual(old_saved_on, flow.saved_on)
        self.assertGreater(flow.modified_on, old_modified_on)

    @mock_mailroom
    def test_flow_archive_with_campaign(self, mr_mocks):
        self.login(self.admin)
        self.get_flow("the_clinic")

        campaign = Campaign.objects.get(name="Appointment Schedule")
        flow = Flow.objects.get(name="Confirm Appointment")

        campaign_event = CampaignEvent.objects.filter(flow=flow, campaign=campaign).first()
        self.assertIsNotNone(campaign_event)

        # do not archive if the campaign is active
        Flow.apply_action_archive(self.admin, Flow.objects.filter(pk=flow.pk))

        flow.refresh_from_db()
        self.assertFalse(flow.is_archived)

        campaign.is_archived = True
        campaign.save()

        # can archive if the campaign is archived
        Flow.apply_action_archive(self.admin, Flow.objects.filter(pk=flow.pk))

        flow.refresh_from_db()
        self.assertTrue(flow.is_archived)

        campaign.is_archived = False
        campaign.save()

        flow.is_archived = False
        flow.save()

        campaign_event.is_active = False
        campaign_event.save()

        # can archive if the campaign is not archived with no active event
        Flow.apply_action_archive(self.admin, Flow.objects.filter(pk=flow.pk))

        flow.refresh_from_db()
        self.assertTrue(flow.is_archived)

    @mock_mailroom
    def test_flow_archive_with_ongoing_runs(self, mr_mocks):
        self.login(self.admin)
        flow = self.create_flow("Test Flow")

        # add ongoing runs
        flow.counts.create(scope=f"status:{FlowRun.STATUS_WAITING}", count=10)

        # do not archive if flow has ongoing runs
        Flow.apply_action_archive(self.admin, Flow.objects.filter(pk=flow.pk))

        flow.refresh_from_db()
        self.assertFalse(flow.is_archived)

        # clear the waiting runs and add only completed
        flow.counts.all().delete()
        flow.counts.create(scope=f"status:{FlowRun.STATUS_COMPLETED}", count=10)

        # can archive if no ongoing runs
        Flow.apply_action_archive(self.admin, Flow.objects.filter(pk=flow.pk))

        flow.refresh_from_db()
        self.assertTrue(flow.is_archived)

    def test_editor(self):
        flow = self.create_flow("Test")

        self.login(self.admin)

        flow_editor_url = reverse("flows.flow_editor", args=[flow.uuid])

        response = self.client.get(flow_editor_url)
        self.assertEqual(response.status_code, 200)

        # flows that are archived can't be edited, started or simulated
        flow.is_archived = True
        flow.save(update_fields=("is_archived",))

        response = self.client.get(flow_editor_url)

        self.assertFalse(response.context["mutable"])
        self.assertFalse(response.context["can_start"])
        self.assertFalse(response.context["can_simulate"])

    def test_save_revision(self):
        self.login(self.admin)
        self.client.post(
            reverse("flows.flow_create"), {"name": "Go Flow", "flow_type": Flow.TYPE_MESSAGE, "base_language": "eng"}
        )
        flow = Flow.objects.get(
            org=self.org, name="Go Flow", flow_type=Flow.TYPE_MESSAGE, version_number=Flow.CURRENT_SPEC_VERSION
        )

        # initial revision has no diff baseline so changes is null
        first = flow.revisions.order_by("id").last()
        self.assertIsNone(first.changes)

        # saving an unchanged definition is a no-op — returns the current revision and
        # doesn't create a new one
        same, _ = flow.save_revision(self.admin, dict(first.definition))
        self.assertEqual(first.id, same.id)
        self.assertEqual(1, flow.revisions.count())

        # renaming the flow shows up as a metadata tag in the next saved revision
        flow.name = "Renamed"
        flow.save(update_fields=("name",))
        rev2, _ = flow.save_revision(self.admin, dict(first.definition))
        self.assertEqual({"tags": ["metadata"]}, rev2.changes)

        # if migrating the prior revision blows up the save still succeeds with changes=None
        rev2.spec_version = "11.12"
        rev2.save(update_fields=("spec_version",))
        with patch(
            "temba.flows.models.FlowRevision.get_migrated_definition",
            side_effect=ValueError("boom"),
        ):
            rev3, _ = flow.save_revision(self.admin, dict(rev2.definition))
        self.assertIsNone(rev3.changes)

        # a trim failure shouldn't surface as a save failure — the inline trim is
        # best-effort housekeeping and the cron task is the safety net
        flow.name = "Trim Test"
        flow.save(update_fields=("name",))
        latest_def = flow.revisions.order_by("id").last().definition
        with patch(
            "temba.flows.models.FlowRevision.trim_for_flow",
            side_effect=RuntimeError("trim boom"),
        ):
            rev_after_trim_fail, _ = flow.save_revision(self.admin, dict(latest_def))
        self.assertIsNotNone(rev_after_trim_fail)
        self.assertTrue(FlowRevision.objects.filter(id=rev_after_trim_fail.id).exists())

        # can't save older spec version over newer
        definition = flow.revisions.order_by("id").last().definition
        definition["spec_version"] = Flow.FINAL_LEGACY_VERSION

        with self.assertRaises(FlowVersionConflictException):
            flow.save_revision(self.admin, definition)

        # can't save older revision over newer
        definition["spec_version"] = Flow.CURRENT_SPEC_VERSION
        definition["revision"] = 0

        with self.assertRaises(FlowUserConflictException):
            flow.save_revision(self.admin, definition)

    def test_clone(self):
        flow = self.create_flow("123456789012345678901234567890123456789012345678901234567890")  # 60 chars
        flow.expires_after_minutes = 60
        flow.save(update_fields=("expires_after_minutes",))

        copy1 = flow.clone(self.admin)

        self.assertNotEqual(flow.id, copy1.id)
        self.assertEqual(60, copy1.expires_after_minutes)

        # name should start with "Copy of" and be truncated to 64 chars
        self.assertEqual("Copy of 12345678901234567890123456789012345678901234567890123456", copy1.name)

        # cloning again should generate a unique name
        copy2 = flow.clone(self.admin)
        self.assertEqual("Copy of 123456789012345678901234567890123456789012345678901234 2", copy2.name)
        copy3 = flow.clone(self.admin)
        self.assertEqual("Copy of 123456789012345678901234567890123456789012345678901234 3", copy3.name)

        # ensure that truncating doesn't leave trailing spaces
        flow2 = self.create_flow("abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabc efghijkl")
        copy2 = flow2.clone(self.admin)
        self.assertEqual("Copy of abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabc", copy2.name)

    def test_get_activity(self):
        flow1 = self.create_flow("Test 1")
        flow2 = self.create_flow("Test 2")

        flow1.counts.create(scope="node:01c175da-d23d-40a4-a845-c4a9bb4b481a", count=3)
        flow1.counts.create(scope="node:01c175da-d23d-40a4-a845-c4a9bb4b481a", count=1)
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

        self.assertEqual(
            (
                {"01c175da-d23d-40a4-a845-c4a9bb4b481a": 4, "400d6b5e-c963-42a1-a06c-50bb9b1e38b1": 5},
                {
                    "1fff74f4-c81f-4f4c-a03d-58d113c17da1:01c175da-d23d-40a4-a845-c4a9bb4b481a": 7,
                    "6f607948-f3f0-4a6a-94b8-7fdd877895ca:400d6b5e-c963-42a1-a06c-50bb9b1e38b1": 5,
                },
            ),
            flow1.get_activity(),
        )
        self.assertEqual(
            ({}, {"a4fe3ada-b062-47e4-be58-bcbe1bca31b4:74a53ff4-fe63-4d89-875e-cae3caca177c": 6}), flow2.get_activity()
        )

    def test_get_category_counts(self):
        flow = self.create_flow("Favorites")
        flow.info = {
            "results": [
                {"key": "color", "name": "Color", "categories": ["Red", "Blue", "Green", "Other"]},
                {"key": "beer", "name": "Beer", "categories": ["Primus", "Mutzig", "Turbo King", "Skol", "Other"]},
                {"key": "name", "name": "Name", "categories": ["All Responses"]},
            ]
        }
        flow.save(update_fields=("info",))

        flow.result_counts.create(result="color", category="Blue", count=10)
        flow.result_counts.create(result="beer", category="Primus", count=10)
        flow.result_counts.create(result="name", category="All Responses", count=10)

        flow.result_counts.create(result="color", category="Red", count=5)
        flow.result_counts.create(result="beer", category="Primus", count=5)
        flow.result_counts.create(result="name", category="All Responses", count=5)

        flow.result_counts.create(result="color", category="Other", count=5)
        flow.result_counts.create(result="color", category="Other", count=-5)
        flow.result_counts.create(result="color", category="Green", count=5)
        flow.result_counts.create(result="beer", category="Skol", count=5)
        flow.result_counts.create(result="name", category="All Responses", count=5)

        # categories can be empty (e.g. set_run_result)
        flow.result_counts.create(result="color", category="", count=5)

        # name shouldn't be included since it's open ended
        self.assertEqual(
            [
                {
                    "key": "color",
                    "name": "Color",
                    "categories": [
                        {"name": "", "count": 5, "pct": 0.2},
                        {"name": "Blue", "count": 10, "pct": 0.4},
                        {"name": "Green", "count": 5, "pct": 0.2},
                        {"name": "Other", "count": 0, "pct": 0.0},
                        {"name": "Red", "count": 5, "pct": 0.2},
                    ],
                    "total": 25,
                },
                {
                    "key": "beer",
                    "name": "Beer",
                    "categories": [
                        {"name": "Primus", "count": 15, "pct": 0.75},
                        {"name": "Skol", "count": 5, "pct": 0.25},
                    ],
                    "total": 20,
                },
            ],
            flow.get_category_counts(),
        )

        # check no change after squashing except zero count for Other gone
        squash_flow_counts()

        self.assertEqual(
            [
                {
                    "key": "color",
                    "name": "Color",
                    "categories": [
                        {"name": "", "count": 5, "pct": 0.2},
                        {"name": "Blue", "count": 10, "pct": 0.4},
                        {"name": "Green", "count": 5, "pct": 0.2},
                        {"name": "Red", "count": 5, "pct": 0.2},
                    ],
                    "total": 25,
                },
                {
                    "key": "beer",
                    "name": "Beer",
                    "categories": [
                        {"name": "Primus", "count": 15, "pct": 0.75},
                        {"name": "Skol", "count": 5, "pct": 0.25},
                    ],
                    "total": 20,
                },
            ],
            flow.get_category_counts(),
        )

    def test_start_counts(self):
        # create start for 10 contacts
        flow = self.create_flow("Test")
        start = FlowStart.objects.create(org=self.org, flow=flow, created_by=self.admin)
        for i in range(10):
            start.contacts.add(self.create_contact("Bob", urns=[f"twitter:bobby{i}"]))

        # create runs for first 5
        for c in start.contacts.order_by("id")[:5]:
            MockSessionWriter(contact=c, flow=flow, start=start).wait().save()

        # check our count
        self.assertEqual(FlowStartCount.get_count(start), 5)

        # create runs for last 5
        for c in start.contacts.order_by("id")[5:]:
            MockSessionWriter(contact=c, flow=flow, start=start).wait().save()

        # check our count
        self.assertEqual(FlowStartCount.get_count(start), 10)

        # squash them
        FlowStartCount.squash()
        self.assertEqual(FlowStartCount.get_count(start), 10)

    def test_flow_keyword_update(self):
        self.login(self.admin)
        flow = Flow.create(self.org, self.admin, "Flow")
        flow.flow_type = Flow.TYPE_SURVEY
        flow.save()

        # keywords aren't an option for survey flows
        response = self.client.get(reverse("flows.flow_update", args=[flow.uuid]))
        self.assertNotIn("keyword_triggers", response.context["form"].fields)
        self.assertNotIn("ignore_triggers", response.context["form"].fields)

        # send update with triggers and ignore flag anyways
        post_data = dict()
        post_data["name"] = "Flow With Keyword Triggers"
        post_data["keyword_triggers"] = "notallowed"
        post_data["ignore_keywords"] = True
        post_data["expires_after_minutes"] = 60 * 12
        response = self.client.post(reverse("flows.flow_update", args=[flow.uuid]), post_data, follow=True)

        # still shouldn't have any triggers
        flow.refresh_from_db()
        self.assertFalse(flow.ignore_triggers)
        self.assertEqual(0, flow.triggers.all().count())

    def test_importing_dependencies(self):
        # create channel to be matched by name
        channel = self.create_channel("TG", "RapidPro Test", "12345324635")

        flow = self.get_flow("dependencies_v13")
        flow_def = flow.get_definition()

        # global should have been created with blank value
        self.assertTrue(self.org.globals.filter(name="Org Name", key="org_name", value="").exists())

        # topic should have been created too
        self.assertTrue(self.org.topics.filter(name="Support").exists())

        # fields created with type if exists in export
        self.assertTrue(self.org.fields.filter(key="cat_breed", name="Cat Breed", value_type="T").exists())
        self.assertTrue(self.org.fields.filter(key="french_age", value_type="N").exists())

        # reference to channel changed to match existing channel by name
        self.assertEqual(
            {"uuid": str(channel.uuid), "name": "RapidPro Test"}, flow_def["nodes"][0]["actions"][4]["channel"]
        )

    def test_flow_info(self):
        # test importing both old and new flow formats
        for flow_file in ("favorites", "favorites_v13"):
            flow = self.get_flow(flow_file)

            self.assertEqual(
                flow.info["results"],
                [
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
            )
            self.assertEqual(len(flow.info["parent_refs"]), 0)

    @mock_mailroom
    def test_group_send(self, mr_mocks):
        # create an inactive group with the same name, to test that this doesn't blow up our import
        group = ContactGroup.get_or_create(self.org, self.admin, "Survey Audience")
        group.release(self.admin)

        # and create another as well
        ContactGroup.get_or_create(self.org, self.admin, "Survey Audience")

        # fetching a flow with a group send shouldn't throw
        self.get_flow("group_send_flow")

    @mock_mailroom
    def test_delete(self, mr_mocks):
        flow = self.get_flow("favorites_v13")
        flow_nodes = flow.get_definition()["nodes"]
        color_prompt = flow_nodes[0]
        color_split = flow_nodes[2]
        beer_prompt = flow_nodes[3]
        beer_split = flow_nodes[5]

        # create a campaign that contains this flow
        friends = self.create_group("Friends", [])
        poll_date = self.create_field("poll_date", "Poll Date", value_type=ContactField.TYPE_DATETIME)

        campaign = Campaign.create(self.org, self.admin, Campaign.get_unique_name(self.org, "Favorite Poll"), friends)
        event1 = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, poll_date, offset=0, unit="D", flow=flow, delivery_hour="13"
        )

        # create a trigger that contains this flow
        trigger = Trigger.create(
            self.org, self.admin, Trigger.TYPE_KEYWORD, flow, keywords=["poll"], match_type=Trigger.MATCH_FIRST_WORD
        )

        # run the flow
        (
            MockSessionWriter(self.contact, flow)
            .visit(color_prompt)
            .visit(color_split)
            .wait()
            .resume(msg=self.create_incoming_msg(self.contact, "RED"))
            .visit(beer_prompt)
            .visit(beer_split)
            .wait()
            .save()
        )

        # run it again to completion
        joe = self.create_contact("Joe", phone="1234")
        (
            MockSessionWriter(joe, flow)
            .visit(color_prompt)
            .visit(color_split)
            .wait()
            .resume(msg=self.create_incoming_msg(joe, "green"))
            .visit(beer_prompt)
            .visit(beer_split)
            .wait()
            .resume(msg=self.create_incoming_msg(joe, "primus"))
            .complete()
            .save()
        )

        # try to remove the flow, not logged in, no dice
        response = self.client.post(reverse("flows.flow_delete", args=[flow.uuid]))
        self.assertLoginRedirect(response)

        # login as admin
        self.login(self.admin)
        response = self.client.post(reverse("flows.flow_delete", args=[flow.uuid]))
        self.assertEqual(200, response.status_code)

        # flow should no longer be active
        flow.refresh_from_db()
        self.assertFalse(flow.is_active)

        # runs should not be deleted
        self.assertEqual(flow.runs.count(), 2)

        # our campaign event and trigger should no longer be active
        event1.refresh_from_db()
        self.assertFalse(event1.is_active)

        trigger.refresh_from_db()
        self.assertFalse(trigger.is_active)
