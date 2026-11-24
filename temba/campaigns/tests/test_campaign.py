import json
from unittest.mock import call
from zoneinfo import ZoneInfo

from django.core.files.storage import default_storage

from temba.campaigns.models import Campaign, CampaignEvent
from temba.contacts.models import ContactField
from temba.flows.models import Flow
from temba.orgs.models import DefinitionExport, Org
from temba.tests import TembaTest, mock_mailroom


class CampaignTest(TembaTest):
    def setUp(self):
        super().setUp()

        self.farmer1 = self.create_contact("Rob Jasper", phone="+250788111111")
        self.farmer2 = self.create_contact("Mike Gordon", phone="+250788222222", language="spa")

        self.nonfarmer = self.create_contact("Trey Anastasio", phone="+250788333333")
        self.farmers = self.create_group("Farmers", [self.farmer1, self.farmer2])

        self.reminder_flow = self.create_flow(name="Reminder Flow")
        self.reminder2_flow = self.create_flow(name="Planting Reminder")

        self.background_flow = self.create_flow(name="Background Flow", flow_type=Flow.TYPE_BACKGROUND)

        # create a voice flow to make sure they work too, not a proper voice flow but
        # sufficient for assuring these flow types show up where they should
        self.voice_flow = self.create_flow(name="IVR flow", flow_type="V")

        # create a contact field for our planting date
        self.planting_date = self.create_field("planting_date", "Planting Date", value_type=ContactField.TYPE_DATETIME)

    @mock_mailroom
    def test_model(self, mr_mocks):
        campaign = Campaign.create(self.org, self.admin, Campaign.get_unique_name(self.org, "Reminders"), self.farmers)
        flow = self.create_flow("Test Flow")

        event1 = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, self.planting_date, offset=1, unit="W", flow=flow, delivery_hour=13
        )
        event2 = CampaignEvent.create_message_event(
            self.org,
            self.admin,
            campaign,
            self.planting_date,
            offset=3,
            unit="D",
            translations={"eng": {"text": "Hello"}},
            base_language="eng",
            delivery_hour=9,
        )

        self.assertEqual("Reminders", campaign.name)
        self.assertEqual("Reminders", str(campaign))
        self.assertEqual({event1, event2}, set(campaign.get_events()))

        campaign.schedule_async()

        # existing events should be scheduling with bumped fire versions
        event1.refresh_from_db()
        event2.refresh_from_db()
        self.assertEqual(event1.status, "S")
        self.assertEqual(event1.fire_version, 1)
        self.assertEqual(event2.status, "S")
        self.assertEqual(event2.fire_version, 1)

        # should have called mailroom to schedule our events
        self.assertEqual([call(self.org, event1), call(self.org, event2)], mr_mocks.calls["campaign_schedule"])

    def test_get_offset_display(self):
        campaign = Campaign.create(self.org, self.admin, Campaign.get_unique_name(self.org, "Reminders"), self.farmers)
        flow = self.create_flow("Test")
        event = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, self.planting_date, offset=0, unit="W", flow=flow
        )

        def assert_display(offset: int, unit: str, expected: str):
            event.offset = offset
            event.unit = unit
            self.assertEqual(expected, event.offset_display)

        assert_display(-2, "M", "2 minutes before")
        assert_display(-1, "M", "1 minute before")
        assert_display(0, "M", "on")
        assert_display(1, "M", "1 minute after")
        assert_display(2, "M", "2 minutes after")
        assert_display(-2, "H", "2 hours before")
        assert_display(-1, "H", "1 hour before")
        assert_display(0, "H", "on")
        assert_display(1, "H", "1 hour after")
        assert_display(2, "H", "2 hours after")
        assert_display(-2, "D", "2 days before")
        assert_display(-1, "D", "1 day before")
        assert_display(0, "D", "on")
        assert_display(1, "D", "1 day after")
        assert_display(2, "D", "2 days after")
        assert_display(-2, "W", "2 weeks before")
        assert_display(-1, "W", "1 week before")
        assert_display(0, "W", "on")
        assert_display(1, "W", "1 week after")
        assert_display(2, "W", "2 weeks after")

    def test_get_unique_name(self):
        self.assertEqual("Reminders", Campaign.get_unique_name(self.org, "Reminders"))

        # ensure checking against existing campaigns is case-insensitive
        reminders = Campaign.create(self.org, self.admin, "REMINDERS", self.farmers)

        self.assertEqual("Reminders 2", Campaign.get_unique_name(self.org, "Reminders"))
        self.assertEqual("Reminders", Campaign.get_unique_name(self.org, "Reminders", ignore=reminders))
        self.assertEqual("Reminders", Campaign.get_unique_name(self.org2, "Reminders"))  # different org

        Campaign.create(self.org, self.admin, "Reminders 2", self.farmers)

        self.assertEqual("Reminders 3", Campaign.get_unique_name(self.org, "Reminders"))

        # ensure we don't exceed the name length limit
        Campaign.create(self.org, self.admin, "X" * 64, self.farmers)

        self.assertEqual(f"{'X' * 62} 2", Campaign.get_unique_name(self.org, "X" * 64))

    def test_get_sorted_events(self):
        # create a campaign
        campaign = Campaign.create(self.org, self.editor, "Planting Reminders", self.farmers)
        joined_on = self.create_field("joined_on", "Joined On", value_type=ContactField.TYPE_DATETIME)
        flow = self.create_flow("Test 1")

        event1 = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, self.planting_date, offset=8, unit="D", flow=flow
        )
        event2 = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, self.planting_date, offset=3, unit="D", flow=flow
        )
        event3 = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, self.planting_date, offset=1, unit="W", flow=flow
        )
        event4 = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, joined_on, offset=24, unit="H", flow=flow
        )

        self.assertEqual(campaign.get_sorted_events(), [event4, event2, event3, event1])

    def test_message_event(self):
        # create a campaign with a message event 1 day after planting date
        campaign = Campaign.create(self.org, self.admin, "Planting Reminders", self.farmers)
        event = CampaignEvent.create_message_event(
            self.org,
            self.admin,
            campaign,
            relative_to=self.planting_date,
            offset=1,
            unit="D",
            translations={
                "eng": {
                    "text": "Hi @(upper(contact.name)) don't forget to plant on @(format_date(contact.planting_date))"
                }
            },
            base_language="eng",
        )

        self.assertEqual(self.planting_date, event.relative_to)
        self.assertEqual(1, event.offset)
        self.assertEqual("D", event.unit)
        self.assertEqual(
            {
                "eng": {
                    "text": "Hi @(upper(contact.name)) don't forget to plant on @(format_date(contact.planting_date))"
                }
            },
            event.translations,
        )
        self.assertEqual("eng", event.base_language)

    def test_import(self):
        self.import_file("flows/the_clinic.json")
        self.assertEqual(1, Campaign.objects.count())

        campaign = Campaign.objects.get()
        self.assertEqual("Appointment Schedule", campaign.name)
        self.assertEqual(6, campaign.events.count())

        events = list(campaign.events.order_by("id"))
        self.assertEqual(CampaignEvent.TYPE_FLOW, events[0].event_type)
        self.assertEqual(CampaignEvent.TYPE_FLOW, events[1].event_type)
        self.assertEqual(CampaignEvent.TYPE_FLOW, events[2].event_type)
        self.assertEqual(CampaignEvent.TYPE_FLOW, events[3].event_type)
        self.assertEqual(CampaignEvent.TYPE_MESSAGE, events[4].event_type)
        self.assertEqual(CampaignEvent.TYPE_MESSAGE, events[5].event_type)
        self.assertEqual({"und": {"text": "This is a second campaign message"}}, events[5].translations)
        self.assertEqual("und", events[5].base_language)

    def test_import_created_on_event(self):
        campaign = Campaign.create(self.org, self.admin, "New contact reminders", self.farmers)
        created_on = self.org.fields.get(key="created_on")

        CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, relative_to=created_on, offset=3, unit="D", flow=self.reminder_flow
        )

        self.login(self.admin)

        export = DefinitionExport.create(self.org, self.admin, flows=[], campaigns=[campaign])
        export.perform()

        with default_storage.open(f"orgs/{self.org.id}/definition_exports/{export.uuid}.json") as export_file:
            exported = json.loads(export_file.read())

        self.org.import_app(exported, self.admin)

    def test_update_to_non_date(self):
        # create our campaign and event
        campaign = Campaign.create(self.org, self.admin, "Planting Reminders", self.farmers)
        event = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, relative_to=self.planting_date, offset=2, unit="D", flow=self.reminder_flow
        )

        # try changing our field type to something non-date, should throw
        with self.assertRaises(ValueError):
            ContactField.get_or_create(self.org, self.admin, "planting_date", value_type=ContactField.TYPE_TEXT)

        # release our campaign event
        event.release(self.admin)

        # should be able to change our field type now
        ContactField.get_or_create(self.org, self.admin, "planting_date", value_type=ContactField.TYPE_TEXT)

    def test_unarchiving_campaigns(self):
        # create a campaign
        campaign = Campaign.create(self.org, self.editor, "Planting Reminders", self.farmers)

        flow = self.create_flow("Test")

        CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, self.planting_date, offset=1, unit="W", flow=flow, delivery_hour="13"
        )
        CampaignEvent.create_flow_event(
            self.org,
            self.admin,
            campaign,
            self.planting_date,
            offset=1,
            unit="W",
            flow=self.reminder_flow,
            delivery_hour="9",
        )

        CampaignEvent.create_message_event(
            self.org,
            self.admin,
            campaign,
            self.planting_date,
            1,
            CampaignEvent.UNIT_DAYS,
            {"eng": {"text": "Don't forget to brush your teeth"}},
            base_language="eng",
        )

        flow.archive(self.admin)
        campaign.is_archived = True
        campaign.save(update_fields=("is_archived",))

        self.assertTrue(campaign.is_archived)
        self.assertTrue(Flow.objects.filter(is_archived=True))

        # unarchive
        Campaign.apply_action_restore(self.admin, Campaign.objects.filter(pk=campaign.pk))
        campaign.refresh_from_db()
        self.assertFalse(campaign.is_archived)
        self.assertFalse(Flow.objects.filter(is_archived=True))

    def test_as_export_def(self):
        field_created_on = self.org.fields.get(key="created_on")
        campaign = Campaign.create(self.org, self.admin, "Planting Reminders", self.farmers)

        # create a reminder for our first planting event
        planting_reminder = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, relative_to=self.planting_date, offset=3, unit="D", flow=self.reminder_flow
        )

        self.assertEqual(
            campaign.as_export_def(),
            {
                "name": "Planting Reminders",
                "uuid": str(campaign.uuid),
                "group": {"uuid": str(self.farmers.uuid), "name": "Farmers"},
                "events": [
                    {
                        "uuid": str(planting_reminder.uuid),
                        "offset": 3,
                        "unit": "D",
                        "event_type": "F",
                        "start_mode": "I",
                        "delivery_hour": -1,
                        "relative_to": {"label": "Planting Date", "key": "planting_date"},
                        "flow": {"uuid": str(self.reminder_flow.uuid), "name": "Reminder Flow"},
                    }
                ],
            },
        )

        campaign2 = Campaign.create(self.org, self.admin, "Planting Reminders 2", self.farmers)
        planting_reminder2 = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign2, relative_to=field_created_on, offset=2, unit="D", flow=self.reminder_flow
        )

        self.assertEqual(
            campaign2.as_export_def(),
            {
                "name": "Planting Reminders 2",
                "uuid": str(campaign2.uuid),
                "group": {"uuid": str(self.farmers.uuid), "name": "Farmers"},
                "events": [
                    {
                        "uuid": str(planting_reminder2.uuid),
                        "offset": 2,
                        "unit": "D",
                        "event_type": "F",
                        "start_mode": "I",
                        "delivery_hour": -1,
                        "relative_to": {"key": "created_on", "label": "Created On"},
                        "flow": {"uuid": str(self.reminder_flow.uuid), "name": "Reminder Flow"},
                    }
                ],
            },
        )

        campaign3 = Campaign.create(self.org, self.admin, "Planting Reminders 2", self.farmers)
        planting_reminder3 = CampaignEvent.create_message_event(
            self.org,
            self.admin,
            campaign3,
            relative_to=field_created_on,
            offset=2,
            unit="D",
            translations={"eng": {"text": "o' a framer?"}},
            base_language="eng",
        )

        self.assertEqual(
            campaign3.as_export_def(),
            {
                "name": "Planting Reminders 2",
                "uuid": str(campaign3.uuid),
                "group": {"uuid": str(self.farmers.uuid), "name": "Farmers"},
                "events": [
                    {
                        "uuid": str(planting_reminder3.uuid),
                        "offset": 2,
                        "unit": "D",
                        "event_type": "M",
                        "start_mode": "I",
                        "delivery_hour": -1,
                        "message": {"eng": "o' a framer?"},
                        "relative_to": {"key": "created_on", "label": "Created On"},
                        "base_language": "eng",
                    }
                ],
            },
        )

    def test_create_flow_event(self):
        gender = self.create_field("gender", "Gender", value_type="T")
        created_on = self.org.fields.get(key="created_on")
        campaign = Campaign.create(self.org, self.admin, "Planting Reminders", self.farmers)

        new_org = Org.objects.create(
            name="Temba New", timezone=ZoneInfo("Africa/Kigali"), created_by=self.editor, modified_by=self.editor
        )

        self.assertRaises(
            ValueError,
            CampaignEvent.create_flow_event,
            new_org,
            self.admin,
            campaign,
            offset=3,
            unit="D",
            flow=self.reminder_flow,
            relative_to=self.planting_date,
        )

        # can't create event relative to non-date field
        with self.assertRaises(ValueError):
            CampaignEvent.create_flow_event(
                self.org,
                self.admin,
                campaign,
                offset=3,
                unit="D",
                flow=self.reminder_flow,
                relative_to=gender,
            )

        campaign_event = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, offset=3, unit="D", flow=self.reminder_flow, relative_to=self.planting_date
        )

        self.assertEqual(campaign_event.campaign, campaign)
        self.assertEqual(campaign_event.offset, 3)
        self.assertEqual(campaign_event.unit, "D")
        self.assertEqual(campaign_event.relative_to, self.planting_date)
        self.assertEqual(campaign_event.flow, self.reminder_flow)
        self.assertEqual(campaign_event.event_type, "F")
        self.assertEqual(campaign_event.translations, None)
        self.assertEqual(campaign_event.base_language, None)
        self.assertEqual(campaign_event.delivery_hour, -1)

        campaign_event = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign, offset=3, unit="D", flow=self.reminder_flow, relative_to=created_on
        )

        self.assertEqual(campaign_event.campaign, campaign)
        self.assertEqual(campaign_event.offset, 3)
        self.assertEqual(campaign_event.unit, "D")
        self.assertEqual(campaign_event.relative_to, created_on)
        self.assertEqual(campaign_event.flow, self.reminder_flow)
        self.assertEqual(campaign_event.event_type, "F")
        self.assertEqual(campaign_event.translations, None)
        self.assertEqual(campaign_event.base_language, None)
        self.assertEqual(campaign_event.delivery_hour, -1)

    def test_create_message_event(self):
        gender = self.create_field("gender", "Gender", value_type="T")
        campaign = Campaign.create(self.org, self.admin, "Planting Reminders", self.farmers)

        new_org = Org.objects.create(
            name="Temba New", timezone=ZoneInfo("Africa/Kigali"), created_by=self.editor, modified_by=self.editor
        )

        with self.assertRaises(AssertionError):
            CampaignEvent.create_message_event(
                new_org,
                self.admin,
                campaign,
                offset=3,
                unit="D",
                translations={"eng": {"text": "oy, pancake man, come back"}},
                base_language="eng",
                relative_to=self.planting_date,
            )

        # can't create event relative to non-date field
        with self.assertRaises(ValueError):
            CampaignEvent.create_message_event(
                self.org,
                self.admin,
                campaign,
                offset=3,
                unit="D",
                translations={"eng": {"text": "oy, pancake man, come back"}},
                base_language="eng",
                relative_to=gender,
            )

        campaign_event = CampaignEvent.create_message_event(
            self.org,
            self.admin,
            campaign,
            offset=3,
            unit="D",
            translations={"eng": {"text": "oy, pancake man, come back"}},
            base_language="eng",
            relative_to=self.planting_date,
        )

        self.assertEqual(campaign_event.campaign, campaign)
        self.assertEqual(campaign_event.offset, 3)
        self.assertEqual(campaign_event.unit, "D")
        self.assertEqual(campaign_event.relative_to, self.planting_date)
        self.assertEqual(campaign_event.event_type, "M")
        self.assertEqual(campaign_event.translations, {"eng": {"text": "oy, pancake man, come back"}})
        self.assertEqual(campaign_event.base_language, "eng")
        self.assertEqual(campaign_event.delivery_hour, -1)
        self.assertIsNone(campaign_event.flow)
