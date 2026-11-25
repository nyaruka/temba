import io
from datetime import date, datetime, timedelta, timezone as tzone
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.db.models import F, Model
from django.test.utils import override_settings
from django.urls import reverse
from django.utils import timezone

from temba.ai.models import LLM
from temba.ai.types.openai.type import OpenAIType
from temba.api.models import Resthook, WebHookEvent
from temba.archives.models import Archive
from temba.campaigns.models import Campaign, CampaignEvent
from temba.channels.models import SyncEvent
from temba.contacts.models import ContactExport, ContactField, ContactFire, ContactImport, ContactImportBatch
from temba.flows.models import FlowLabel, FlowRun, FlowSession, FlowStart, FlowStartCount, ResultsExport
from temba.globals.models import Global
from temba.locations.models import AdminBoundary
from temba.msgs.models import MessageExport, Msg
from temba.notifications.incidents.builtin import ChannelDisconnectedIncidentType
from temba.notifications.types.builtin import ExportFinishedNotificationType
from temba.orgs.models import Export, Invitation, Org, OrgMembership, OrgRole
from temba.orgs.tasks import delete_released_orgs, restart_stalled_exports
from temba.request_logs.models import HTTPLog
from temba.schedules.models import Schedule
from temba.templates.models import TemplateTranslation
from temba.tests import TembaTest, mock_mailroom
from temba.tests.base import get_contact_search
from temba.tickets.models import Team, TicketExport, Topic
from temba.triggers.models import Trigger
from temba.utils import json
from temba.utils.uuid import uuid4


class OrgTest(TembaTest):
    def test_create(self):
        new_org = Org.create(self.admin, "Cool Stuff", ZoneInfo("Africa/Kigali"))
        self.assertEqual("Cool Stuff", new_org.name)
        self.assertEqual(self.admin, new_org.created_by)
        self.assertEqual("en-us", new_org.language)
        self.assertEqual(["eng"], new_org.flow_languages)
        self.assertEqual("D", new_org.date_format)
        self.assertEqual(str(new_org.timezone), "Africa/Kigali")
        self.assertIn(self.admin, self.org.get_admins())
        self.assertEqual(f'<Org: id={new_org.id} name="Cool Stuff">', repr(new_org))

        # if timezone is US, should get MMDDYYYY dates
        new_org = Org.create(self.admin, "Cool Stuff", ZoneInfo("America/Los_Angeles"))
        self.assertEqual("M", new_org.date_format)
        self.assertEqual(str(new_org.timezone), "America/Los_Angeles")

    def test_get_users(self):
        admin3 = self.create_user("bob@textit.com")

        self.org.add_user(admin3, OrgRole.ADMINISTRATOR)
        self.org2.add_user(self.admin, OrgRole.ADMINISTRATOR)

        self.assertEqual(
            [self.admin, self.editor, admin3],
            list(self.org.get_users(roles=[OrgRole.ADMINISTRATOR, OrgRole.EDITOR]).order_by("id")),
        )
        self.assertEqual(
            [self.admin, self.admin2],
            list(self.org2.get_users(roles=[OrgRole.ADMINISTRATOR, OrgRole.EDITOR]).order_by("id")),
        )

        self.assertEqual([self.admin, admin3], list(self.org.get_admins().order_by("id")))
        self.assertEqual([self.admin, self.admin2], list(self.org2.get_admins().order_by("id")))

    def test_get_owner(self):
        self.org.created_by = self.agent
        self.org.save(update_fields=("created_by",))

        # admins take priority
        self.assertEqual(self.admin, self.org.get_owner())

        OrgMembership.objects.filter(org=self.org, role_code="A").delete()

        # then editors etc
        self.assertEqual(self.editor, self.org.get_owner())

        OrgMembership.objects.filter(org=self.org, role_code=OrgRole.EDITOR.code).delete()
        OrgMembership.objects.filter(org=self.org, role_code=OrgRole.AGENT.code).delete()

        # finally defaulting to org creator
        self.assertEqual(self.agent, self.org.get_owner())

    def test_format_datetime(self):
        self.org.timezone = ZoneInfo("America/Mexico_City")
        self.org.save()

        date1 = datetime(2000, 1, 1, tzinfo=tzone.utc)

        self.assertEqual(self.org.format_datetime(date1), "31-12-1999 18:00")

        invalid_date = datetime(1, 1, 1, 0, 0, tzinfo=tzone(timedelta(days=-1, seconds=62640), "-06:36"))

        self.assertEqual(self.org.format_datetime(invalid_date), "")

    def test_get_unique_slug(self):
        self.org.slug = "allo"
        self.org.save()

        self.assertEqual(Org.get_unique_slug("foo"), "foo")
        self.assertEqual(Org.get_unique_slug("Which part?"), "which-part")
        self.assertEqual(Org.get_unique_slug("Allo"), "allo-2")

    def test_suspend_and_unsuspend(self):
        def assert_org(org, is_suspended):
            org.refresh_from_db()
            self.assertEqual(is_suspended, org.is_suspended)
            if is_suspended:
                self.assertIsNotNone(org.suspended_on)
            else:
                self.assertIsNone(org.suspended_on)

        self.org.features += [Org.FEATURE_CHILD_ORGS]
        org1_child1 = self.org.create_new(self.admin, "Child 1", tzone.utc, as_child=True)
        org1_child2 = self.org.create_new(self.admin, "Child 2", tzone.utc, as_child=True)

        self.org.suspend()

        assert_org(self.org, is_suspended=True)
        assert_org(org1_child1, is_suspended=True)
        assert_org(org1_child2, is_suspended=True)
        assert_org(self.org2, is_suspended=False)

        self.assertEqual(1, self.org.incidents.filter(incident_type="org:suspended", ended_on=None).count())
        self.assertEqual(1, self.admin.notifications.filter(notification_type="incident:started").count())

        self.org.suspend()  # noop

        assert_org(self.org, is_suspended=True)

        self.assertEqual(1, self.org.incidents.filter(incident_type="org:suspended", ended_on=None).count())

        self.org.unsuspend()

        assert_org(self.org, is_suspended=False)
        assert_org(org1_child1, is_suspended=False)
        assert_org(self.org2, is_suspended=False)

        self.assertEqual(0, self.org.incidents.filter(incident_type="org:suspended", ended_on=None).count())

    def test_set_flow_languages(self):
        self.org.set_flow_languages(self.admin, ["eng", "fra"])
        self.org.refresh_from_db()
        self.assertEqual(["eng", "fra"], self.org.flow_languages)

        self.org.set_flow_languages(self.admin, ["kin", "eng"])
        self.org.refresh_from_db()
        self.assertEqual(["kin", "eng"], self.org.flow_languages)

        with self.assertRaises(AssertionError):
            self.org.set_flow_languages(self.admin, ["eng", "xyz"])
        with self.assertRaises(AssertionError):
            self.org.set_flow_languages(self.admin, ["eng", "eng"])

    def test_locations_view(self):
        self.setUpLocations()

        settings_url = reverse("orgs.org_workspace")
        country_url = reverse("orgs.org_locations")

        rwanda = AdminBoundary.objects.get(name="Rwanda")

        # can't see this page if not logged in
        self.assertLoginRedirect(self.client.get(country_url))

        # login as admin instead
        self.login(self.admin)
        response = self.client.get(country_url)
        self.assertEqual(200, response.status_code)

        # clear root_location so we can verify the POST sets it
        self.org.root_location = None
        self.org.save(update_fields=("root_location",))

        # save with Rwanda as a country
        self.client.post(country_url, {"root_location": rwanda.id})

        # assert it has changed
        self.org.refresh_from_db()
        self.assertEqual("Rwanda", str(self.org.root_location))
        self.assertEqual("RW", self.org.default_country_code)

        response = self.client.get(settings_url)
        self.assertContains(response, "Rwanda")

        # if location support is disabled in the settings, don't display country formax
        with override_settings(FEATURES=[]):
            response = self.client.get(settings_url)
            self.assertNotContains(response, "Rwanda")

    def test_default_country(self):
        # if root location boundary is set and name is valid country, that has priority
        self.org.root_location = AdminBoundary.create(osm_id="171496", name="Ecuador", level=0)
        self.org.timezone = "Africa/Nairobi"
        self.org.save(update_fields=("root_location", "timezone"))

        self.assertEqual("EC", self.org.default_country.alpha_2)

        del self.org.default_country

        # if country name isn't valid, we'll try timezone
        self.org.root_location.name = "Fantasia"
        self.org.root_location.save(update_fields=("name",))

        self.assertEqual("KE", self.org.default_country.alpha_2)

        del self.org.default_country

        # not all timezones have countries in which case we look at channels
        self.org.timezone = "UTC"
        self.org.save(update_fields=("timezone",))

        self.assertEqual("RW", self.org.default_country.alpha_2)

        del self.org.default_country

        # but if we don't have any channels.. no more backdowns
        self.org.channels.all().delete()

        self.assertIsNone(self.org.default_country)

    @mock_mailroom
    def test_org_flagging_and_suspending(self, mr_mocks):
        self.login(self.admin)

        mark = self.create_contact("Mark", phone="+12065551212")
        flow = self.create_flow("Test")

        def send_broadcast_via_api():
            url = reverse("api.v2.broadcasts")
            data = dict(contacts=[mark.uuid], text="You are a distant cousin to a wealthy person.")
            return self.client.post(
                url + ".json", json.dumps(data), content_type="application/json", HTTP_X_FORWARDED_HTTPS="https"
            )

        def start_flow_via_api():
            url = reverse("api.v2.flow_starts")
            data = dict(flow=flow.uuid, urns=["tel:+250788123123"])
            return self.client.post(
                url + ".json", json.dumps(data), content_type="application/json", HTTP_X_FORWARDED_HTTPS="https"
            )

        self.org.flag()
        self.org.refresh_from_db()
        self.assertTrue(self.org.is_flagged)

        expected_message = "Sorry, your workspace is currently flagged. To re-enable starting flows and sending messages, please contact support."

        # while we are flagged, we can't send broadcasts
        send_url = reverse("msgs.broadcast_to_node") + "?node=123&count=3"
        response = self.client.get(send_url)
        self.assertContains(response, expected_message)

        start_url = f"{reverse('flows.flow_start', args=[])}?flow={flow.id}"
        # we also can't start flows
        self.assertRaises(
            AssertionError,
            self.client.post,
            start_url,
            {"flow": flow.id, "contact_search": get_contact_search(query='uuid="{mark.uuid}"')},
        )

        response = send_broadcast_via_api()
        self.assertContains(response, expected_message, status_code=400)

        response = start_flow_via_api()
        self.assertContains(response, expected_message, status_code=400)

        # unflag org and suspend it instead
        self.org.unflag()
        self.org.suspend()

        expected_message = "Sorry, your workspace is currently suspended. To re-enable starting flows and sending messages, please contact support."

        response = self.client.get(send_url)
        self.assertContains(response, expected_message)

        # we also can't start flows
        self.assertRaises(
            AssertionError,
            self.client.post,
            start_url,
            {"flow": flow.id, "contact_search": get_contact_search(query='uuid="{mark.uuid}"')},
        )

        response = send_broadcast_via_api()
        self.assertContains(response, expected_message, status_code=400)

        response = start_flow_via_api()
        self.assertContains(response, expected_message, status_code=400)

        # check our inbox page
        response = self.client.get(reverse("msgs.msg_inbox"))
        self.assertContains(response, "Your workspace is suspended")

        # still no messages or flow starts
        self.assertEqual(Msg.objects.all().count(), 0)
        self.assertEqual(mr_mocks.calls["flow_start"], [])

        # unsuspend our org and start a flow
        self.org.is_suspended = False
        self.org.save(update_fields=("is_suspended",))

        self.client.post(
            start_url,
            {"flow": flow.id, "contact_search": get_contact_search(query='uuid="{mark.uuid}"')},
        )

        self.assertEqual(len(mr_mocks.calls["flow_start"]), 1)

    def test_resthooks(self):
        resthook_url = reverse("orgs.org_resthooks")

        # no hitting this page without auth
        response = self.client.get(resthook_url)
        self.assertLoginRedirect(response)

        self.login(self.admin)

        # get our resthook management page
        response = self.client.get(resthook_url)

        # shouldn't have any resthooks listed yet
        self.assertFalse(response.context["current_resthooks"])

        # try to create one with name that's too long
        response = self.client.post(resthook_url, {"new_slug": "x" * 100})
        self.assertFormError(
            response.context["form"], "new_slug", "Ensure this value has at most 50 characters (it has 100)."
        )

        # now try to create with valid name/slug
        response = self.client.post(resthook_url, {"new_slug": "mother-registration "})
        self.assertEqual(302, response.status_code)

        # should now have a resthook
        mother_reg = Resthook.objects.get()
        self.assertEqual(mother_reg.slug, "mother-registration")
        self.assertEqual(mother_reg.org, self.org)
        self.assertEqual(mother_reg.created_by, self.admin)

        # fetch our read page, should have have our resthook
        response = self.client.get(resthook_url)
        self.assertEqual(
            [{"field": f"resthook_{mother_reg.id}", "resthook": mother_reg}],
            list(response.context["current_resthooks"]),
        )

        # let's try to create a repeat, should fail due to duplicate slug
        response = self.client.post(resthook_url, {"new_slug": "Mother-Registration"})
        self.assertFormError(response.context["form"], "new_slug", "This event name has already been used.")

        # add a subscriber
        subscriber = mother_reg.add_subscriber("http://foo", self.admin)

        # finally, let's remove that resthook
        self.client.post(resthook_url, {"resthook_%d" % mother_reg.id: "checked"})

        mother_reg.refresh_from_db()
        self.assertFalse(mother_reg.is_active)

        subscriber.refresh_from_db()
        self.assertFalse(subscriber.is_active)

        # no more resthooks!
        response = self.client.get(resthook_url)
        self.assertEqual([], list(response.context["current_resthooks"]))

    def test_org_get_limit(self):
        self.assertEqual(self.org.get_limit(Org.LIMIT_FIELDS), 250)
        self.assertEqual(self.org.get_limit(Org.LIMIT_GROUPS), 250)
        self.assertEqual(self.org.get_limit(Org.LIMIT_GLOBALS), 250)

        self.org.limits = dict(fields=500, groups=500)
        self.org.save()

        self.assertEqual(self.org.get_limit(Org.LIMIT_FIELDS), 500)
        self.assertEqual(self.org.get_limit(Org.LIMIT_GROUPS), 500)
        self.assertEqual(self.org.get_limit(Org.LIMIT_GLOBALS), 250)

    def test_org_api_rates(self):
        self.assertEqual(self.org.api_rates, {})

        self.org.api_rates = {"v2.contacts": "10000/hour"}
        self.org.save()

        self.assertEqual(self.org.api_rates, {"v2.contacts": "10000/hour"})

    def test_child_management(self):
        # error if an org without this feature tries to create a child
        with self.assertRaises(AssertionError):
            self.org.create_new(self.admin, "Sub Org", self.org.timezone, as_child=True)

        # enable feature and try again
        self.org.features = [Org.FEATURE_CHILD_ORGS]
        self.org.save(update_fields=("features",))

        sub_org = self.org.create_new(self.admin, "Sub Org", self.org.timezone, as_child=True)

        # we should be linked to our parent
        self.assertEqual(self.org, sub_org.parent)
        self.assertEqual(self.admin, sub_org.created_by)

        # default values should be the same as parent
        self.assertEqual(self.org.timezone, sub_org.timezone)

    @patch("temba.orgs.tasks.perform_export.delay")
    def test_restart_stalled_exports(self, mock_org_export_task):
        mock_org_export_task.return_value = None

        message_export1 = MessageExport.create(org=self.org, user=self.admin, start_date=None, end_date=None)
        message_export1.status = Export.STATUS_FAILED
        message_export1.save(update_fields=("status",))

        message_export2 = MessageExport.create(org=self.org, user=self.admin, start_date=None, end_date=None)
        message_export2.status = Export.STATUS_COMPLETE
        message_export2.save(update_fields=("status",))

        MessageExport.create(org=self.org, user=self.admin, start_date=None, end_date=None)

        results_export1 = ResultsExport.create(org=self.org, user=self.admin, start_date=None, end_date=None)
        results_export1.status = Export.STATUS_FAILED
        results_export1.save(update_fields=("status",))

        results_export2 = ResultsExport.create(org=self.org, user=self.admin, start_date=None, end_date=None)
        results_export2.status = Export.STATUS_COMPLETE
        results_export2.save(update_fields=("status",))

        ResultsExport.create(org=self.org, user=self.admin, start_date=None, end_date=None)

        contact_export1 = ContactExport.create(org=self.org, user=self.admin)
        contact_export1.status = Export.STATUS_FAILED
        contact_export1.save(update_fields=("status",))
        contact_export2 = ContactExport.create(org=self.org, user=self.admin)
        contact_export2.status = Export.STATUS_COMPLETE
        contact_export2.save(update_fields=("status",))
        ContactExport.create(org=self.org, user=self.admin)

        two_hours_ago = timezone.now() - timedelta(hours=2)

        Export.objects.all().update(modified_on=two_hours_ago)

        restart_stalled_exports()

        self.assertEqual(3, mock_org_export_task.call_count)


class OrgDeleteTest(TembaTest):
    def create_content(self, org, user) -> list:
        # add child workspaces
        org.features = [Org.FEATURE_CHILD_ORGS]
        org.save(update_fields=("features",))
        org.create_new(user, "Child 1", "Africa/Kigali", as_child=True)
        org.create_new(user, "Child 2", "Africa/Kigali", as_child=True)

        content = []

        def add(obj):
            content.append(obj)
            return obj

        channels = self._create_channel_content(org, add)
        contacts, fields, groups = self._create_contact_content(org, add)
        flows = self._create_flow_content(org, user, channels, contacts, groups, add)
        labels = self._create_message_content(org, user, channels, contacts, groups, add)
        self._create_campaign_content(org, user, fields, groups, flows, contacts, add)
        self._create_ticket_content(org, user, contacts, flows, add)
        self._create_export_content(org, user, flows, groups, fields, labels, add)
        self._create_archive_content(org, add)

        # suspend and flag org to generate incident and notifications
        org.suspend()
        org.unsuspend()
        org.flag()
        org.unflag()
        for incident in org.incidents.all():
            add(incident)

        return content

    def _create_channel_content(self, org, add) -> tuple:
        channel1 = add(self.create_channel("TG", "Telegram", "+250785551212", org=org))
        channel2 = add(self.create_channel("A", "Android", "+1234567890", org=org))
        add(
            SyncEvent.create(
                channel2,
                dict(pending=[], retry=[], power_source="P", power_status="full", power_level="100", network_type="W"),
                [],
            )
        )
        add(ChannelDisconnectedIncidentType.get_or_create(channel2))
        add(
            HTTPLog.objects.create(
                org=org, channel=channel2, log_type=HTTPLog.WHATSAPP_TEMPLATES_SYNCED, request_time=10, is_error=False
            )
        )

        return (channel1, channel2)

    def _create_flow_content(self, org, user, channels, contacts, groups, add) -> tuple:
        flow1 = add(self.create_flow("Registration", org=org))
        flow2 = add(self.create_flow("Goodbye", org=org))

        start1 = add(FlowStart.objects.create(org=org, flow=flow1))
        add(FlowStartCount.objects.create(start=start1, count=1))

        add(
            Trigger.create(
                org,
                user,
                flow=flow1,
                trigger_type=Trigger.TYPE_KEYWORD,
                keywords=["color"],
                match_type=Trigger.MATCH_FIRST_WORD,
                groups=groups,
            )
        )
        add(
            Trigger.create(
                org,
                user,
                flow=flow1,
                trigger_type=Trigger.TYPE_NEW_CONVERSATION,
                channel=channels[0],
                groups=groups,
            )
        )
        session1 = FlowSession.objects.create(
            uuid=uuid4(),
            contact_uuid=contacts[0].uuid,
            current_flow_uuid=flow1.uuid,
            status=FlowSession.STATUS_WAITING,
            output={"status": "waiting"},
        )
        add(
            FlowRun.objects.create(
                org=org,
                flow=flow1,
                contact=contacts[0],
                session_uuid=session1.uuid,
                status=FlowRun.STATUS_COMPLETED,
                exited_on=timezone.now(),
            )
        )
        contacts[0].current_flow = flow1
        contacts[0].save(update_fields=("current_flow",))

        flow_label1 = add(FlowLabel.create(org, user, "Cool Flows"))
        flow_label2 = add(FlowLabel.create(org, user, "Crazy Flows"))
        flow1.labels.add(flow_label1)
        flow2.labels.add(flow_label2)

        global1 = add(Global.get_or_create(org, user, "org_name", "Org Name", "Acme Ltd"))
        flow1.global_dependencies.add(global1)

        llm1 = add(LLM.create(org, user, OpenAIType(), "gpt-4o", "GPT-4", {}))
        flow1.llm_dependencies.add(llm1)

        resthook = add(Resthook.get_or_create(org, "registration", user))
        resthook.subscribers.create(target_url="http://foo.bar", created_by=user, modified_by=user)

        add(WebHookEvent.objects.create(org=org, resthook=resthook, data={}))
        add(
            HTTPLog.objects.create(
                flow=flow1,
                url="http://org2.bar/zap",
                request="GET /zap",
                response=" OK 200",
                is_error=False,
                log_type=HTTPLog.WEBHOOK_CALLED,
                request_time=10,
                org=org,
            )
        )

        template = add(
            self.create_template(
                "hello",
                [
                    TemplateTranslation(
                        channel=channels[0],
                        locale="eng-US",
                        status=TemplateTranslation.STATUS_APPROVED,
                        external_id="1234",
                        external_locale="en_US",
                    )
                ],
                org=org,
            )
        )
        flow1.template_dependencies.add(template)

        return (flow1, flow2)

    def _create_contact_content(self, org, add) -> tuple[tuple]:
        contact1 = add(self.create_contact("Bob", phone="+5931234111111", org=org))
        contact2 = add(self.create_contact("Jim", phone="+5931234222222", org=org))

        field1 = add(self.create_field("age", "Age", org=org))
        field2 = add(self.create_field("joined", "Joined", value_type=ContactField.TYPE_DATETIME, org=org))

        group1 = add(self.create_group("Adults", query="age >= 18", org=org))
        group2 = add(self.create_group("Testers", contacts=[contact1, contact2], org=org))

        # create a contact import
        group3 = add(self.create_group("Imported", contacts=[], org=org))
        imp = ContactImport.objects.create(
            org=self.org, group=group3, mappings={}, num_records=0, created_by=self.admin, modified_by=self.admin
        )
        ContactImportBatch.objects.create(contact_import=imp, specs={}, record_start=0, record_end=0)

        contact1.set_note(self.admin, "this guy for real?")

        return (contact1, contact2), (field1, field2), (group1, group2, group3)

    def _create_message_content(self, org, user, channels, contacts, groups, add) -> tuple:
        msg1 = add(self.create_incoming_msg(contact=contacts[0], text="hi", channel=channels[0]))
        add(self.create_outgoing_msg(contact=contacts[0], text="cool story", channel=channels[0]))
        add(self.create_outgoing_msg(contact=contacts[0], text="synced", channel=channels[1]))

        add(self.create_broadcast(user, {"eng": {"text": "Announcement"}}, contacts=contacts, groups=groups, org=org))

        scheduled = add(
            self.create_broadcast(
                user,
                {"eng": {"text": "Reminder"}},
                contacts=contacts,
                groups=groups,
                org=org,
                schedule=Schedule.create(org, timezone.now(), Schedule.REPEAT_DAILY),
            )
        )
        add(
            self.create_broadcast(
                user, {"eng": {"text": "Reminder"}}, contacts=contacts, groups=groups, org=org, parent=scheduled
            )
        )

        label1 = add(self.create_label("Spam", org=org))
        label2 = add(self.create_label("Important", org=org))

        label1.toggle_label([msg1], add=True)
        label2.toggle_label([msg1], add=True)

        return (label1, label2)

    def _create_campaign_content(self, org, user, fields, groups, flows, contacts, add):
        campaign = add(Campaign.create(org, user, "Reminders", groups[0]))
        event1 = add(
            CampaignEvent.create_flow_event(
                org, user, campaign, fields[1], offset=1, unit="W", flow=flows[0], delivery_hour="13"
            )
        )
        add(
            ContactFire.objects.create(
                org=org, contact=contacts[0], fire_type="C", scope=str(event1.id), fire_on=timezone.now()
            )
        )

    def _create_ticket_content(self, org, user, contacts, flows, add):
        topic = add(Topic.create(org, user, "Spam"))
        add(self.create_ticket(contacts[0], topic))
        add(self.create_ticket(contacts[0], opened_in=flows[0]))
        team = add(Team.create(org, user, "Spam Only", topics=[topic]))
        Invitation.create(org, user, "newagent@textit.com", OrgRole.AGENT, team=team)

    def _create_export_content(self, org, user, flows, groups, fields, labels, add):
        results = add(
            ResultsExport.create(
                org,
                user,
                start_date=date.today(),
                end_date=date.today(),
                flows=flows,
                with_fields=fields,
                with_groups=groups,
                responded_only=True,
                extra_urns=(),
            )
        )
        ExportFinishedNotificationType.create(results)

        contacts = add(ContactExport.create(org, user, group=groups[0]))
        ExportFinishedNotificationType.create(contacts)

        messages = add(MessageExport.create(org, user, start_date=date.today(), end_date=date.today(), label=labels[0]))
        ExportFinishedNotificationType.create(messages)

        tickets = add(
            TicketExport.create(
                org, user, start_date=date.today(), end_date=date.today(), with_groups=groups, with_fields=fields
            )
        )
        ExportFinishedNotificationType.create(tickets)

    def _create_archive_content(self, org, add):
        daily = add(self.create_archive(Archive.TYPE_MSG, Archive.PERIOD_DAILY, timezone.now(), [{"id": 1}], org=org))
        add(
            self.create_archive(
                Archive.TYPE_MSG, Archive.PERIOD_MONTHLY, timezone.now(), [{"id": 1}], rollup_of=(daily,), org=org
            )
        )

        # extra S3 file in archive dir
        Archive.storage().save(f"{org.id}/extra_file.json", io.StringIO("[]"))

    def _exists(self, obj) -> bool:
        return obj._meta.model.objects.filter(id=obj.id).exists()

    def assertOrgActive(self, org, org_content=()):
        org.refresh_from_db()

        self.assertTrue(org.is_active)
        self.assertIsNone(org.released_on)
        self.assertIsNone(org.deleted_on)

        for o in org_content:
            self.assertTrue(self._exists(o), f"{repr(o)} should still exist")

    def assertOrgReleased(self, org, org_content=()):
        org.refresh_from_db()

        self.assertFalse(org.is_active)
        self.assertIsNotNone(org.released_on)
        self.assertIsNone(org.deleted_on)

        for o in org_content:
            self.assertTrue(self._exists(o), f"{repr(o)} should still exist")

    def assertOrgDeleted(self, org, org_content=()):
        org.refresh_from_db()

        self.assertFalse(org.is_active)
        self.assertEqual({}, org.config)
        self.assertIsNotNone(org.released_on)
        self.assertIsNotNone(org.deleted_on)

        for o in org_content:
            self.assertFalse(self._exists(o), f"{repr(o)} shouldn't still exist")

    def assertUserActive(self, user):
        user.refresh_from_db()

        self.assertTrue(user.is_active)
        self.assertNotEqual("", user.password)

    def assertUserReleased(self, user):
        user.refresh_from_db()

        self.assertFalse(user.is_active)
        self.assertEqual("", user.password)

    @mock_mailroom
    def test_release_and_delete(self, mr_mocks):
        org1_content = self.create_content(self.org, self.admin)
        org2_content = self.create_content(self.org2, self.admin2)

        org1_child1 = self.org.children.get(name="Child 1")
        org1_child2 = self.org.children.get(name="Child 2")

        # add editor to second org as agent
        self.org2.add_user(self.editor, OrgRole.AGENT)

        # can't delete an org that wasn't previously released
        with self.assertRaises(AssertionError):
            self.org.delete()

        self.assertOrgActive(self.org, org1_content)
        self.assertOrgActive(self.org2, org2_content)

        self.org.release(self.customer_support)

        # org and its children should be marked for deletion
        self.assertOrgReleased(self.org, org1_content)
        self.assertOrgReleased(org1_child1)
        self.assertOrgReleased(org1_child2)
        self.assertOrgActive(self.org2, org2_content)

        self.assertUserReleased(self.admin)
        self.assertUserActive(self.editor)  # because they're also in org #2
        self.assertUserReleased(self.agent)
        self.assertUserReleased(self.admin)
        self.assertUserActive(self.admin2)

        delete_released_orgs()

        self.assertOrgReleased(self.org, org1_content)  # deletion hasn't occurred yet because releasing was too soon
        self.assertOrgReleased(org1_child1)
        self.assertOrgReleased(org1_child2)
        self.assertOrgActive(self.org2, org2_content)

        # make it look like released orgs were released over a week ago
        Org.objects.exclude(released_on=None).update(released_on=F("released_on") - timedelta(days=8))

        delete_released_orgs()

        self.assertOrgDeleted(self.org, org1_content)
        self.assertOrgDeleted(org1_child1)
        self.assertOrgDeleted(org1_child2)
        self.assertOrgActive(self.org2, org2_content)

        # only org 2 files left in S3
        for archive in self.org2.archives.all():
            self.assertTrue(Archive.storage().exists(archive.get_storage_location()[1]))

        self.assertTrue(Archive.storage().exists(f"{self.org2.id}/extra_file.json"))
        self.assertFalse(Archive.storage().exists(f"{self.org.id}/extra_file.json"))

        # check we've initiated search de-indexing for all deleted orgs
        self.assertEqual({org1_child1, org1_child2, self.org}, {c.args[0] for c in mr_mocks.calls["org_deindex"]})

        # we don't actually delete org objects but at this point there should be no related fields preventing that
        Model.delete(org1_child1)
        Model.delete(org1_child2)
        Model.delete(self.org)

        # releasing an already released org won't do anything
        prev_released_on = self.org.released_on
        self.org.release(self.customer_support)
        self.assertEqual(prev_released_on, self.org.released_on)


class AnonOrgTest(TembaTest):
    """
    Tests the case where our organization is marked as anonymous, that is the phone numbers are masked
    for users.
    """

    def setUp(self):
        super().setUp()

        self.org.is_anon = True
        self.org.save()

    def test_contacts(self):
        # are there real phone numbers on the contact list page?
        contact = self.create_contact(None, phone="+250788123123")
        self.login(self.admin)

        response = self.client.get(reverse("contacts.contact_list"))

        # phone not in the list
        self.assertNotContains(response, "788 123 123")

        # but the ref value is
        self.assertContains(response, contact.ref)

        # create an outgoing message, check number doesn't appear in outbox
        msg1 = self.create_outgoing_msg(contact, "hello", status="Q")

        response = self.client.get(reverse("msgs.msg_outbox"))

        self.assertEqual(set(response.context["object_list"]), {msg1})
        self.assertNotContains(response, "788 123 123")
        self.assertContains(response, contact.ref)

        # create an incoming message - by default (preview off) the inbox renders the legacy template which prints
        # the contact via name_or_urn, so URN masking still needs coverage on that path. In preview mode the temba-msg-list
        # component fetches messages from the internal API (separately covered in temba/api/internal/tests.py).
        msg2 = self.create_incoming_msg(contact, "ok")

        response = self.client.get(reverse("msgs.msg_inbox"))

        self.assertEqual(set(response.context["object_list"]), {msg2})
        self.assertNotContains(response, "788 123 123")
        self.assertContains(response, contact.ref)

        # create an incoming flow message, check number doesn't appear in inbox
        flow = self.create_flow("Test")
        msg3 = self.create_incoming_msg(contact, "ok", flow=flow)

        response = self.client.get(reverse("msgs.msg_flow"))

        self.assertEqual(set(response.context["object_list"]), {msg3})
        self.assertNotContains(response, "788 123 123")
        self.assertContains(response, contact.ref)

        # check contact detail page
        response = self.client.get(reverse("contacts.contact_read", args=[contact.uuid]))
        self.assertNotContains(response, "788 123 123")
        self.assertContains(response, contact.ref)
