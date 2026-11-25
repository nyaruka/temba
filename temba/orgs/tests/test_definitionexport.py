import io
from unittest.mock import patch

from django.conf import settings
from django.core.files.storage import default_storage
from django.urls import reverse

from temba import mailroom
from temba.campaigns.models import Campaign, CampaignEvent
from temba.contacts.models import ContactField, ContactGroup
from temba.flows.models import Flow
from temba.msgs.models import Label
from temba.orgs.models import DefinitionExport, Export, Org, OrgImport
from temba.tests import CRUDLTestMixin, TembaTest, matchers, mock_mailroom
from temba.triggers.models import Trigger
from temba.utils import json


class DefinitionExportTest(TembaTest, CRUDLTestMixin):
    def _export(self, flows=[], campaigns=[]):
        export = DefinitionExport.create(self.org, self.admin, flows=flows, campaigns=campaigns)
        export.perform()

        with default_storage.open(f"orgs/{self.org.id}/definition_exports/{export.uuid}.json") as export_file:
            definitions = json.loads(export_file.read())

        return definitions, export

    def test_import_validation(self):
        # export must include version field
        with self.assertRaises(ValueError):
            self.org.import_app({"flows": []}, self.admin)

        # export version can't be older than Org.EARLIEST_IMPORT_VERSION
        with self.assertRaises(ValueError):
            self.org.import_app({"version": "2", "flows": []}, self.admin)

        # export version can't be newer than Org.CURRENT_EXPORT_VERSION
        with self.assertRaises(ValueError):
            self.org.import_app({"version": "21415", "flows": []}, self.admin)

    def test_trigger_dependency(self):
        # tests the case of us doing an export of only a single flow (despite dependencies) and making sure we
        # don't include the triggers of our dependent flows (which weren't exported)
        self.import_file("test_flows/parent_child_trigger.json")

        parent = Flow.objects.filter(name="Parent Flow").first()

        self.login(self.admin)

        exported, export_obj = self._export(flows=[parent], campaigns=[])

        # shouldn't have any triggers
        self.assertFalse(exported["triggers"])

    def test_subflow_dependencies(self):
        self.import_file("test_flows/subflow.json")

        parent = Flow.objects.filter(name="Parent Flow").first()
        child = Flow.objects.filter(name="Child Flow").first()
        self.assertIn(child, parent.flow_dependencies.all())

        self.login(self.admin)
        response = self.client.get(reverse("orgs.org_export"))

        self.assertEqual(1, len(response.context["buckets"]))
        self.assertEqual([child, parent], response.context["buckets"][0])

    @mock_mailroom
    def test_import_voice_flows_expiration_time(self, mr_mocks):
        # import file has invalid expires for an IVR flow so it should get clamped to the maximum (15)
        self.get_flow("ivr")

        self.assertEqual(Flow.objects.filter(flow_type=Flow.TYPE_VOICE).count(), 1)
        voice_flow = Flow.objects.get(flow_type=Flow.TYPE_VOICE)
        self.assertEqual(voice_flow.name, "IVR Flow")
        self.assertEqual(voice_flow.expires_after_minutes, 15)

    def test_import(self):
        create_url = reverse("orgs.orgimport_create")

        self.login(self.admin)

        # try to import a file with a version that's too old
        response = self.client.post(create_url, {"file": io.BytesIO(b'{"version":"2","flows":[]}')})
        self.assertFormError(
            response.context["form"], "file", "This file is no longer valid. Please export a new version and try again."
        )

        # try to import a file with a flow with a version that's too new
        response = self.client.post(
            create_url, {"file": io.BytesIO(b'{"version":"13","flows":[{"spec_version": "1324.3.0"}]}')}
        )
        self.assertFormError(
            response.context["form"], "file", "This file contains flows with a version that is too new."
        )

        # try a file which can be migrated forwards
        response = self.client.post(
            create_url,
            {"file": open("%s/test_flows/legacy/migrations/favorites_v4.json" % settings.MEDIA_ROOT, "rb")},
        )
        self.assertEqual(302, response.status_code)

        # should have created an org import object
        self.assertTrue(OrgImport.objects.filter(org=self.org))

        org_import = OrgImport.objects.filter(org=self.org).get()
        self.assertEqual(org_import.status, OrgImport.STATUS_COMPLETE)

        read_url = reverse("orgs.orgimport_read", args=[org_import.uuid])

        self.assertRequestDisallowed(read_url, [None, self.agent, self.admin2])
        response = self.assertReadFetch(read_url, [self.admin, self.editor], context_object=org_import)
        self.assertContains(response, "Finished successfully")

        flow = self.org.flows.filter(name="Favorites").get()
        self.assertEqual(Flow.CURRENT_SPEC_VERSION, flow.version_number)

        # test import using data that is not parsable
        junk_binary_data = io.BytesIO(b"\x00!\x00b\xee\x9dh^\x01\x00\x00\x04\x00\x02[Content_Types].xml \xa2\x04\x02(")
        post_data = dict(file=junk_binary_data)
        response = self.client.post(create_url, post_data)
        self.assertFormError(response.context["form"], "file", "This file is not a valid flow definition file.")

        junk_json_data = io.BytesIO(b'{"key": "data')
        post_data = dict(file=junk_json_data)
        response = self.client.post(create_url, post_data)
        self.assertFormError(response.context["form"], "file", "This file is not a valid flow definition file.")

    def test_import_errors(self):
        self.login(self.admin)
        OrgImport.objects.all().delete()

        # simulate an unexpected exception during import
        with patch("temba.triggers.models.Trigger.import_triggers") as validate:
            validate.side_effect = Exception("Unexpected Error")
            post_data = dict(file=open("%s/test_flows/new_mother.json" % settings.MEDIA_ROOT, "rb"))
            self.client.post(reverse("orgs.orgimport_create"), post_data)

            org_import = OrgImport.objects.filter(org=self.org).last()
            self.assertEqual(org_import.status, OrgImport.STATUS_FAILED)

            # trigger import failed, new flows that were added should get rolled back
            self.assertIsNone(Flow.objects.filter(org=self.org, name="New Mother").first())

    @patch("temba.mailroom.client.client.MailroomClient.campaign_schedule")
    @mock_mailroom
    def test_import_campaign_with_translations(self, mr_mocks, mock_schedule):
        self.import_file("test_flows/campaign_import_with_translations.json")

        campaign = Campaign.objects.all().first()
        event = campaign.events.all().first()

        self.assertEqual(event.translations["swa"], {"text": "hello"})
        self.assertEqual(event.translations["eng"], {"text": "Hey"})

        # base language for this event is 'swa' despite our org languages being unset
        self.assertEqual(event.base_language, "swa")

    @patch("temba.mailroom.client.client.MailroomClient.campaign_schedule")
    @mock_mailroom
    def test_reimport(self, mr_mocks, mock_schedule):
        self.import_file("test_flows/survey_campaign.json")

        campaign = Campaign.objects.filter(is_active=True).last()
        event = campaign.events.filter(is_active=True).last()

        # create a contact and place her into our campaign
        sally = self.create_contact("Sally", phone="+12345", fields={"survey_start": "10-05-2025 12:30:10"})
        campaign.group.contacts.add(sally)

        # importing it again shouldn't result in failures
        self.import_file("test_flows/survey_campaign.json")

        # get our latest campaign and event
        new_campaign = Campaign.objects.filter(is_active=True).last()
        new_event = campaign.events.filter(is_active=True).last()

        # same campaign, but new event
        self.assertEqual(campaign.id, new_campaign.id)
        self.assertNotEqual(event.id, new_event.id)

    def test_import_mixed_flow_versions(self):
        self.import_file("test_flows/mixed_versions.json")

        group = ContactGroup.objects.get(name="Survey Audience")

        child = Flow.objects.get(name="New Child")
        self.assertEqual(child.version_number, Flow.CURRENT_SPEC_VERSION)
        self.assertEqual(set(child.flow_dependencies.all()), set())
        self.assertEqual(set(child.group_dependencies.all()), {group})

        parent = Flow.objects.get(name="Legacy Parent")
        self.assertEqual(parent.version_number, Flow.CURRENT_SPEC_VERSION)
        self.assertEqual(set(parent.flow_dependencies.all()), {child})
        self.assertEqual(set(parent.group_dependencies.all()), set())

        dep_graph = self.org.generate_dependency_graph()
        self.assertEqual(dep_graph[child], {parent})
        self.assertEqual(dep_graph[parent], {child})

    def test_import_dependency_types(self):
        self.import_file("test_flows/all_dependency_types.json")

        parent = Flow.objects.get(name="All Dep Types")
        child = Flow.objects.get(name="New Child")

        age = ContactField.user_fields.get(key="age", name="Age")  # created from expression reference
        gender = ContactField.user_fields.get(key="gender")  # created from action reference

        farmers = ContactGroup.objects.get(name="Farmers")
        self.assertNotEqual(str(farmers.uuid), "967b469b-fd34-46a5-90f9-40430d6db2a4")  # created with new UUID

        self.assertEqual(set(parent.flow_dependencies.all()), {child})
        self.assertEqual(set(parent.field_dependencies.all()), {age, gender})
        self.assertEqual(set(parent.group_dependencies.all()), {farmers})

    @mock_mailroom
    def test_import_flow_issues(self, mr_mocks):
        # first call is during import to find dependencies to map or create
        mr_mocks.flow_inspect(dependencies=[{"key": "age", "name": "", "type": "field", "missing": False}])

        # second call is in save_revision and passes org to validate dependencies, but during import those
        # dependencies which didn't exist already are created in a transaction and mailroom can't see them
        mr_mocks.flow_inspect(
            dependencies=[{"key": "age", "name": "", "type": "field", "missing": True}],
            issues=[{"type": "missing_dependency"}],
        )

        # final call is after new flows and dependencies have been committed so mailroom can see them
        mr_mocks.flow_inspect(dependencies=[{"key": "age", "name": "", "type": "field", "missing": False}])

        self.import_file("test_flows/color_v13.json")

        flow = Flow.objects.get()

        self.assertFalse(flow.has_issues)

    def test_import_missing_flow_dependency(self):
        # in production this would blow up validating the flow but we can't do that during tests
        self.import_file("test_flows/parent_without_its_child.json")

        parent = Flow.objects.get(name="Single Parent")
        self.assertEqual(set(parent.flow_dependencies.all()), set())

        # create child with that name and re-import
        child1 = Flow.create(self.org, self.admin, "New Child", Flow.TYPE_MESSAGE)

        self.import_file("test_flows/parent_without_its_child.json")
        self.assertEqual(set(parent.flow_dependencies.all()), {child1})

        # create child with that UUID and re-import
        child2 = Flow.create(
            self.org, self.admin, "New Child 2", Flow.TYPE_MESSAGE, uuid="a925453e-ad31-46bd-858a-e01136732181"
        )

        self.import_file("test_flows/parent_without_its_child.json")
        self.assertEqual(set(parent.flow_dependencies.all()), {child2})

    def validate_flow_dependencies(self, definition):
        flow_info = mailroom.get_client().flow_inspect(self.org, definition)
        deps = flow_info["dependencies"]

        for dep in [d for d in deps if d["type"] == "field"]:
            self.assertTrue(
                ContactField.user_fields.filter(key=dep["key"]).exists(),
                msg=f"missing field[key={dep['key']}, name={dep['name']}]",
            )
        for dep in [d for d in deps if d["type"] == "flow"]:
            self.assertTrue(
                Flow.objects.filter(uuid=dep["uuid"]).exists(),
                msg=f"missing flow[uuid={dep['uuid']}, name={dep['name']}]",
            )
        for dep in [d for d in deps if d["type"] == "group"]:
            self.assertTrue(
                ContactGroup.objects.filter(uuid=dep["uuid"]).exists(),
                msg=f"missing group[uuid={dep['uuid']}, name={dep['name']}]",
            )

    def test_implicit_field_and_group_imports(self):
        """
        Tests importing flow definitions without fields and groups included in the export
        """
        data = self.load_json("test_flows/cataclysm.json")

        del data["fields"]
        del data["groups"]

        self.org.import_app(data, self.admin, site="http://rapidpro.io")

        flow = Flow.objects.get(name="Cataclysmic")
        self.validate_flow_dependencies(flow.get_definition())

        # we should have 5 non-system groups (all manual since we can only create manual groups from group references)
        self.assertEqual(ContactGroup.objects.filter(is_system=False).count(), 5)
        self.assertEqual(ContactGroup.objects.filter(is_system=False, group_type="M").count(), 5)

        # and so no fields created
        self.assertEqual(ContactField.user_fields.all().count(), 0)

    @mock_mailroom
    def test_implicit_field_and_explicit_group_imports(self, mr_mocks):
        """
        Tests importing flow definitions with groups included in the export but not fields
        """
        data = self.load_json("test_flows/cataclysm.json")
        del data["fields"]

        mr_mocks.contact_parse_query("facts_per_day = 1", fields=["facts_per_day"])
        mr_mocks.contact_parse_query("likes_cats = true", cleaned='likes_cats = "true"', fields=["likes_cats"])

        self.org.import_app(data, self.admin, site="http://rapidpro.io")

        flow = Flow.objects.get(name="Cataclysmic")
        self.validate_flow_dependencies(flow.get_definition())

        # we should have 5 non-system groups (2 query based)
        self.assertEqual(ContactGroup.objects.filter(is_system=False).count(), 5)
        self.assertEqual(ContactGroup.objects.filter(is_system=False, group_type="M").count(), 3)
        self.assertEqual(ContactGroup.objects.filter(is_system=False, group_type="Q").count(), 2)

        # new fields should have been created for the dynamic groups
        likes_cats = ContactField.user_fields.get(key="likes_cats")
        facts_per_day = ContactField.user_fields.get(key="facts_per_day")

        # but without implicit fields in the export, the details aren't correct
        self.assertEqual(likes_cats.name, "Likes Cats")
        self.assertEqual(likes_cats.value_type, "T")
        self.assertEqual(facts_per_day.name, "Facts Per Day")
        self.assertEqual(facts_per_day.value_type, "T")

        cat_fanciers = ContactGroup.objects.get(name="Cat Fanciers")
        self.assertEqual(cat_fanciers.query, 'likes_cats = "true"')
        self.assertEqual(set(cat_fanciers.query_fields.all()), {likes_cats})

        cat_blasts = ContactGroup.objects.get(name="Cat Blasts")
        self.assertEqual(cat_blasts.query, "facts_per_day = 1")
        self.assertEqual(set(cat_blasts.query_fields.all()), {facts_per_day})

    @mock_mailroom
    def test_explicit_field_and_group_imports(self, mr_mocks):
        """
        Tests importing flow definitions with groups and fields included in the export
        """

        mr_mocks.contact_parse_query("facts_per_day = 1", fields=["facts_per_day"])
        mr_mocks.contact_parse_query("likes_cats = true", cleaned='likes_cats = "true"', fields=["likes_cats"])

        self.import_file("test_flows/cataclysm.json")

        flow = Flow.objects.get(name="Cataclysmic")
        self.validate_flow_dependencies(flow.get_definition())

        # we should have 5 non-system groups (2 query based)
        self.assertEqual(ContactGroup.objects.filter(is_system=False).count(), 5)
        self.assertEqual(ContactGroup.objects.filter(is_system=False, group_type="M").count(), 3)
        self.assertEqual(ContactGroup.objects.filter(is_system=False, group_type="Q").count(), 2)

        # new fields should have been created for the dynamic groups
        likes_cats = ContactField.user_fields.get(key="likes_cats")
        facts_per_day = ContactField.user_fields.get(key="facts_per_day")

        # and with implicit fields in the export, the details should be correct
        self.assertEqual(likes_cats.name, "Really Likes Cats")
        self.assertEqual(likes_cats.value_type, "T")
        self.assertEqual(facts_per_day.name, "Facts-Per-Day")
        self.assertEqual(facts_per_day.value_type, "N")

        cat_fanciers = ContactGroup.objects.get(name="Cat Fanciers")
        self.assertEqual(cat_fanciers.query, 'likes_cats = "true"')
        self.assertEqual(set(cat_fanciers.query_fields.all()), {likes_cats})

        cat_blasts = ContactGroup.objects.get(name="Cat Blasts")
        self.assertEqual(cat_blasts.query, "facts_per_day = 1")
        self.assertEqual(set(cat_blasts.query_fields.all()), {facts_per_day})

    def test_import_flow_with_triggers(self):
        flow1 = self.create_flow("Test 1")
        flow2 = self.create_flow("Test 2")

        trigger1 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow1,
            keywords=["rating"],
            match_type=Trigger.MATCH_FIRST_WORD,
            is_archived=True,
        )
        trigger2 = Trigger.create(
            self.org, self.admin, Trigger.TYPE_KEYWORD, flow2, keywords=["rating"], match_type=Trigger.MATCH_FIRST_WORD
        )

        data = self.load_json("test_flows/rating_10.json")

        self.org.import_app(data, self.admin, site="http://rapidpro.io")

        # trigger1.refresh_from_db()
        # self.assertFalse(trigger1.is_archived)

        flow = Flow.objects.get(name="Rate us")
        self.assertEqual(1, Trigger.objects.filter(keywords=["rating"], is_archived=False).count())
        self.assertEqual(1, Trigger.objects.filter(flow=flow).count())

        # should have archived the existing
        self.assertFalse(Trigger.objects.filter(id=trigger1.id, is_archived=False).first())
        self.assertFalse(Trigger.objects.filter(id=trigger2.id, is_archived=False).first())

        # Archive trigger
        flow_trigger = (
            Trigger.objects.filter(flow=flow, keywords=["rating"], is_archived=False).order_by("-created_on").first()
        )
        flow_trigger.archive(self.admin)

        # re import again will restore the trigger
        data = self.load_json("test_flows/rating_10.json")
        self.org.import_app(data, self.admin, site="http://rapidpro.io")

        flow_trigger.refresh_from_db()

        self.assertEqual(1, Trigger.objects.filter(keywords=["rating"], is_archived=False).count())
        self.assertEqual(1, Trigger.objects.filter(flow=flow).count())
        self.assertFalse(Trigger.objects.filter(pk=trigger1.pk, is_archived=False).first())
        self.assertFalse(Trigger.objects.filter(pk=trigger2.pk, is_archived=False).first())

        restored_trigger = (
            Trigger.objects.filter(flow=flow, keywords=["rating"], is_archived=False).order_by("-created_on").first()
        )
        self.assertEqual(restored_trigger.pk, flow_trigger.pk)

    @patch("temba.mailroom.client.client.MailroomClient.campaign_schedule")
    def test_export_import(self, mock_schedule):
        def assert_object_counts():
            self.assertEqual(
                8,
                Flow.objects.filter(org=self.org, is_active=True, is_archived=False, flow_type="M").count(),
            )
            self.assertEqual(1, Campaign.objects.filter(org=self.org, is_archived=False).count())
            self.assertEqual(
                4, CampaignEvent.objects.filter(campaign__org=self.org, event_type="F", is_active=True).count()
            )
            self.assertEqual(
                2, CampaignEvent.objects.filter(campaign__org=self.org, event_type="M", is_active=True).count()
            )
            self.assertEqual(2, Trigger.objects.filter(org=self.org, trigger_type="K", is_archived=False).count())
            self.assertEqual(1, Trigger.objects.filter(org=self.org, trigger_type="C", is_archived=False).count())
            self.assertEqual(1, Trigger.objects.filter(org=self.org, trigger_type="M", is_archived=False).count())
            self.assertEqual(3, ContactGroup.objects.filter(org=self.org, is_system=False).count())
            self.assertEqual(1, Label.objects.filter(org=self.org).count())
            self.assertEqual(
                1, ContactField.user_fields.filter(org=self.org, value_type="D", name="Next Appointment").count()
            )

        # import all our bits
        self.import_file("test_flows/the_clinic.json")

        confirm_appointment = Flow.objects.get(name="Confirm Appointment")
        self.assertEqual(4320, confirm_appointment.expires_after_minutes)

        # check that the right number of objects successfully imported for our app
        assert_object_counts()

        # let's update some stuff
        confirm_appointment.expires_after_minutes = 360
        confirm_appointment.save(update_fields=("expires_after_minutes",))

        trigger = Trigger.objects.filter(keywords=["patient"]).first()
        trigger.flow = confirm_appointment
        trigger.save()

        # now reimport
        self.import_file("test_flows/the_clinic.json")

        # our flow should get reset from the import
        confirm_appointment.refresh_from_db()
        self.assertEqual(4320, confirm_appointment.expires_after_minutes)

        # same with our trigger
        trigger = Trigger.objects.filter(keywords=["patient"]).order_by("-created_on").first()
        self.assertEqual(Flow.objects.filter(name="Register Patient").first(), trigger.flow)

        # and we should have the same number of items as after the first import
        assert_object_counts()

        # see that everything shows up properly on our export page
        self.login(self.admin)
        response = self.client.get(reverse("orgs.org_export"))
        self.assertContains(response, "Register Patient")
        self.assertContains(response, "Catch All")
        self.assertContains(response, "Missed Call")
        self.assertContains(response, "Start Notifications")
        self.assertContains(response, "Stop Notifications")
        self.assertContains(response, "Confirm Appointment")
        self.assertContains(response, "Appointment Followup")

        # our campaign
        self.assertContains(response, "Appointment Schedule")
        self.assertNotContains(
            response, "&quot;Appointment Schedule&quot;"
        )  # previous bug rendered campaign names incorrectly

        confirm_appointment.expires_after_minutes = 60
        confirm_appointment.save(update_fields=("expires_after_minutes",))

        invalid_cases = [
            "}",
            "[]",
            '{"flows": ["foo"], "campaigns": []}',
            '{"flows": [], "campaigns": ["foo"]}',
            '{"flows": [], "campaigns": ""}',
            '{"flows": "", "campaigns": []}',
        ]
        for data in invalid_cases:
            response = self.client.post(reverse("orgs.org_export"), data, content_type="application/json", follow=True)
            self.assertEqual(0, Export.objects.count())
            self.assertEqual(400, response.status_code)

        # now let's export!
        post_data = dict(
            flows=[f.pk for f in Flow.objects.filter(flow_type="M", is_system=False)],
            campaigns=[c.pk for c in Campaign.objects.all()],
        )

        response = self.client.post(
            reverse("orgs.org_export"), json.dumps(post_data), content_type="application/json", follow=True
        )

        self.assertEqual(1, Export.objects.count())

        export = Export.objects.get()
        self.assertEqual("definition", export.export_type)

        flows = Flow.objects.filter(flow_type="M", is_system=False)
        campaigns = Campaign.objects.all()

        exported, export_obj = self._export(flows=flows, campaigns=campaigns)

        response = self.client.get(reverse("orgs.export_download", args=[export_obj.uuid]))
        self.assertEqual(response.status_code, 200)

        self.assertEqual(exported["version"], Org.CURRENT_EXPORT_VERSION)
        self.assertEqual(exported["site"], "https://app.rapidpro.io")

        self.assertEqual(8, len(exported.get("flows", [])))
        self.assertEqual(4, len(exported.get("triggers", [])))
        self.assertEqual(1, len(exported.get("campaigns", [])))
        self.assertEqual(
            exported["fields"],
            [
                {"key": "appointment_confirmed", "name": "Appointment Confirmed", "type": "text"},
                {"key": "next_appointment", "name": "Next Appointment", "type": "datetime"},
                {"key": "rating", "name": "Rating", "type": "text"},
            ],
        )
        self.assertEqual(
            exported["groups"],
            [
                {"uuid": matchers.UUIDString(version=4), "name": "Delay Notification", "query": None},
                {"uuid": matchers.UUIDString(version=4), "name": "Pending Appointments", "query": None},
                {"uuid": matchers.UUIDString(version=4), "name": "Unsatisfied Customers", "query": None},
            ],
        )

        # set our default flow language to english
        self.org.set_flow_languages(self.admin, ["eng", "fra"])

        # finally let's try importing our exported file
        self.org.import_app(exported, self.admin, site="http://app.rapidpro.io")
        assert_object_counts()

        # let's rename a flow and import our export again
        flow = Flow.objects.get(name="Confirm Appointment")
        flow.name = "A new flow"
        flow.save(update_fields=("name",))

        campaign = Campaign.objects.get()
        campaign.name = "A new campaign"
        campaign.save(update_fields=("name",))

        group = ContactGroup.objects.get(name="Pending Appointments")
        group.name = "A new group"
        group.save(update_fields=("name",))

        # it should fall back on UUIDs and not create new objects even though the names changed
        self.org.import_app(exported, self.admin, site="http://app.rapidpro.io")

        assert_object_counts()

        # and our objects should have the same names as before
        self.assertEqual("Confirm Appointment", Flow.objects.get(pk=flow.pk).name)
        self.assertEqual("Appointment Schedule", Campaign.objects.filter(is_active=True).first().name)

        # except the group.. we don't mess with their names
        self.assertFalse(ContactGroup.objects.filter(name="Pending Appointments").exists())
        self.assertTrue(ContactGroup.objects.filter(name="A new group").exists())

        # let's rename our objects again
        flow.name = "A new name"
        flow.save(update_fields=("name",))

        campaign.name = "A new campaign"
        campaign.save(update_fields=("name",))

        group.name = "A new group"
        group.save(update_fields=("name",))

        # now import the same import but pretend it's from a different site
        self.org.import_app(exported, self.admin, site="http://temba.io")

        # the newly named objects won't get updated in this case and we'll create new ones instead
        self.assertEqual(
            9, Flow.objects.filter(org=self.org, is_archived=False, flow_type="M", is_system=False).count()
        )
        self.assertEqual(2, Campaign.objects.filter(org=self.org, is_archived=False).count())
        self.assertEqual(4, ContactGroup.objects.filter(org=self.org, is_system=False).count())

        # now archive a flow
        register = Flow.objects.filter(name="Register Patient").first()
        register.is_archived = True
        register.save()

        # default view shouldn't show archived flows
        response = self.client.get(reverse("orgs.org_export"))
        self.assertNotContains(response, "Register Patient")

        # with the archived flag one, it should be there
        response = self.client.get("%s?archived=1" % reverse("orgs.org_export"))
        self.assertContains(response, "Register Patient")

        # delete our flow, and reimport
        confirm_appointment.release(self.admin, interrupt_sessions=False)
        self.org.import_app(exported, self.admin, site="https://app.rapidpro.io")

        # make sure we have the previously exported expiration
        confirm_appointment = Flow.objects.get(name="Confirm Appointment", is_active=True)
        self.assertEqual(60, confirm_appointment.expires_after_minutes)

        # should be unarchived
        register = Flow.objects.filter(name="Register Patient").first()
        self.assertFalse(register.is_archived)

        # now delete a flow
        register.is_active = False
        register.save()

        # default view shouldn't show deleted flows
        response = self.client.get(reverse("orgs.org_export"))
        self.assertNotContains(response, "Register Patient")

        # even with the archived flag one deleted flows should not show up
        response = self.client.get("%s?archived=1" % reverse("orgs.org_export"))
        self.assertNotContains(response, "Register Patient")

    @mock_mailroom
    def test_prevent_flow_type_changes(self, mr_mocks):
        flow1 = self.create_flow("Background")

        flow2 = self.get_flow("background")  # contains a flow called Background

        flow1.refresh_from_db()
        flow2.refresh_from_db()

        self.assertNotEqual(flow1, flow2)
        self.assertEqual("M", flow1.flow_type)
        self.assertEqual("B", flow2.flow_type)
        self.assertEqual("Background 2", flow2.name)
