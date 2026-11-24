from unittest.mock import call

from django.urls import reverse
from django.utils import timezone

from temba.api.v2.serializers import format_datetime
from temba.campaigns.models import Campaign, CampaignEvent
from temba.contacts.models import ContactField, ContactGroup
from temba.tests import mock_mailroom

from . import APITest


class CampaignEventsEndpointTest(APITest):
    @mock_mailroom
    def test_endpoint(self, mr_mocks):
        endpoint_url = reverse("api.v2.campaign_events") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotPermitted(endpoint_url, [None, self.agent])
        self.assertDeleteNotPermitted(endpoint_url, [None, self.agent])

        joe = self.create_contact("Joe Blow", phone="+250788123123")
        frank = self.create_contact("Frank", urns=["facebook:123456"])
        flow = self.create_flow("Test Flow")
        reporters = self.create_group("Reporters", [joe, frank])
        registration = self.create_field("registration", "Registration", value_type=ContactField.TYPE_DATETIME)
        field_created_on = self.org.fields.get(key="created_on")

        # create our contact and set a registration date
        contact = self.create_contact(
            "Joe", phone="+12065551515", fields={"registration": self.org.format_datetime(timezone.now())}
        )
        reporters.contacts.add(contact)

        campaign1 = Campaign.create(self.org, self.admin, "Reminders", reporters)
        event1 = CampaignEvent.create_message_event(
            self.org,
            self.admin,
            campaign1,
            registration,
            1,
            CampaignEvent.UNIT_DAYS,
            {"eng": {"text": "Don't forget to brush your teeth"}},
            base_language="eng",
        )

        campaign2 = Campaign.create(self.org, self.admin, "Notifications", reporters)
        event2 = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign2, registration, 6, CampaignEvent.UNIT_HOURS, flow, delivery_hour=12
        )

        campaign3 = Campaign.create(self.org, self.admin, "Alerts", reporters)
        event3 = CampaignEvent.create_flow_event(
            self.org, self.admin, campaign3, field_created_on, 6, CampaignEvent.UNIT_HOURS, flow, delivery_hour=12
        )

        # create event for another org
        joined = self.create_field("joined", "Joined On", value_type=ContactField.TYPE_DATETIME)
        spammers = ContactGroup.get_or_create(self.org2, self.admin2, "Spammers")
        spam = Campaign.create(self.org2, self.admin2, "Cool stuff", spammers)
        CampaignEvent.create_flow_event(
            self.org2, self.admin2, spam, joined, 6, CampaignEvent.UNIT_HOURS, flow, delivery_hour=12
        )

        # no filtering
        self.assertGet(
            endpoint_url,
            [self.editor, self.admin],
            results=[
                {
                    "uuid": str(event3.uuid),
                    "campaign": {"uuid": str(campaign3.uuid), "name": "Alerts"},
                    "relative_to": {"key": "created_on", "name": "Created On", "label": "Created On"},
                    "offset": 6,
                    "unit": "hours",
                    "delivery_hour": 12,
                    "flow": {"uuid": str(flow.uuid), "name": "Test Flow"},
                    "message": None,
                    "created_on": format_datetime(event3.created_on),
                },
                {
                    "uuid": str(event2.uuid),
                    "campaign": {"uuid": str(campaign2.uuid), "name": "Notifications"},
                    "relative_to": {"key": "registration", "name": "Registration", "label": "Registration"},
                    "offset": 6,
                    "unit": "hours",
                    "delivery_hour": 12,
                    "flow": {"uuid": str(flow.uuid), "name": "Test Flow"},
                    "message": None,
                    "created_on": format_datetime(event2.created_on),
                },
                {
                    "uuid": str(event1.uuid),
                    "campaign": {"uuid": str(campaign1.uuid), "name": "Reminders"},
                    "relative_to": {"key": "registration", "name": "Registration", "label": "Registration"},
                    "offset": 1,
                    "unit": "days",
                    "delivery_hour": -1,
                    "flow": None,
                    "message": {"eng": "Don't forget to brush your teeth"},
                    "created_on": format_datetime(event1.created_on),
                },
            ],
            num_queries=self.BASE_SESSION_QUERIES + 4,
        )

        # filter by UUID
        self.assertGet(endpoint_url + f"?uuid={event1.uuid}", [self.editor], results=[event1])

        # filter by campaign name
        self.assertGet(endpoint_url + "?campaign=Reminders", [self.editor], results=[event1])

        # filter by campaign UUID
        self.assertGet(endpoint_url + f"?campaign={campaign1.uuid}", [self.editor], results=[event1])

        # filter by invalid campaign
        self.assertGet(endpoint_url + "?campaign=Invalid", [self.editor], results=[])

        # try to create empty campaign event
        self.assertPost(
            endpoint_url,
            self.editor,
            {},
            errors={
                "campaign": "This field is required.",
                "relative_to": "This field is required.",
                "offset": "This field is required.",
                "unit": "This field is required.",
                "delivery_hour": "This field is required.",
            },
        )

        # try again with some invalid values
        self.assertPost(
            endpoint_url,
            self.editor,
            {
                "campaign": str(campaign1.uuid),
                "relative_to": "registration",
                "offset": 15,
                "unit": "epocs",
                "delivery_hour": 25,
                "message": {"kin": "Muraho"},
            },
            errors={
                "unit": '"epocs" is not a valid choice.',
                "delivery_hour": "Ensure this value is less than or equal to 23.",
                "message": "Message text in default flow language is required.",
            },
        )

        # provide valid values for those fields.. but not a message or flow
        self.assertPost(
            endpoint_url,
            self.editor,
            {
                "campaign": str(campaign1.uuid),
                "relative_to": "registration",
                "offset": 15,
                "unit": "weeks",
                "delivery_hour": -1,
            },
            errors={
                "non_field_errors": "Flow or a message text required.",
            },
        )

        # create a message event
        self.assertPost(
            endpoint_url,
            self.editor,
            {
                "campaign": str(campaign1.uuid),
                "relative_to": "registration",
                "offset": 15,
                "unit": "weeks",
                "delivery_hour": -1,
                "message": "You are @fields.age",
            },
            status=201,
        )

        event1 = CampaignEvent.objects.filter(campaign=campaign1).order_by("-id").first()
        self.assertEqual(event1.event_type, CampaignEvent.TYPE_MESSAGE)
        self.assertEqual(event1.relative_to, registration)
        self.assertEqual(event1.offset, 15)
        self.assertEqual(event1.unit, "W")
        self.assertEqual(event1.delivery_hour, -1)
        self.assertEqual(event1.translations, {"eng": {"text": "You are @fields.age"}})
        self.assertEqual(event1.base_language, "eng")
        self.assertEqual(event1.status, "S")
        self.assertEqual(event1.fire_version, 1)
        self.assertIsNone(event1.flow)

        # try to create a message event with an empty message
        self.assertPost(
            endpoint_url,
            self.editor,
            {
                "campaign": str(campaign1.uuid),
                "relative_to": "registration",
                "offset": 15,
                "unit": "weeks",
                "delivery_hour": -1,
                "message": "",
            },
            errors={("message", "eng"): "This field may not be blank."},
        )

        self.assertPost(
            endpoint_url,
            self.editor,
            {
                "campaign": str(campaign1.uuid),
                "relative_to": "created_on",
                "offset": 15,
                "unit": "days",
                "delivery_hour": -1,
                "message": "Nice unit of work @fields.code",
            },
            status=201,
        )

        event1 = CampaignEvent.objects.filter(campaign=campaign1).order_by("-id").first()
        self.assertEqual(event1.event_type, CampaignEvent.TYPE_MESSAGE)
        self.assertEqual(event1.relative_to, field_created_on)
        self.assertEqual(event1.offset, 15)
        self.assertEqual(event1.unit, "D")
        self.assertEqual(event1.delivery_hour, -1)
        self.assertEqual(event1.translations, {"eng": {"text": "Nice unit of work @fields.code"}})
        self.assertIsNone(event1.flow)

        # create a flow event
        self.assertPost(
            endpoint_url,
            self.editor,
            {
                "campaign": str(campaign1.uuid),
                "relative_to": "registration",
                "offset": 15,
                "unit": "weeks",
                "delivery_hour": -1,
                "flow": str(flow.uuid),
            },
            status=201,
        )

        event2 = CampaignEvent.objects.filter(campaign=campaign1).order_by("-id").first()
        self.assertEqual(event2.event_type, CampaignEvent.TYPE_FLOW)
        self.assertEqual(event2.relative_to, registration)
        self.assertEqual(event2.offset, 15)
        self.assertEqual(event2.unit, "W")
        self.assertEqual(event2.delivery_hour, -1)
        self.assertEqual(event2.translations, None)
        self.assertEqual(event2.base_language, None)
        self.assertEqual(event2.flow, flow)

        # make sure we called mailroom to schedule this event
        self.assertEqual(call(self.org, event2), mr_mocks.calls["campaign_schedule"][-1])

        # can't update an event which is being scheduled
        self.assertPost(
            endpoint_url + f"?uuid={event1.uuid}",
            self.editor,
            {
                "campaign": str(campaign1.uuid),
                "relative_to": "created_on",
                "offset": 15,
                "unit": "days",
                "delivery_hour": -1,
                "flow": str(flow.uuid),
            },
            errors={"non_field_errors": "Cannot modify events which are currently being scheduled."},
        )

        CampaignEvent.objects.filter(campaign=campaign1).update(status=CampaignEvent.STATUS_READY)
        event1.refresh_from_db()
        modified_on = event1.modified_on

        # update the message event to be a flow event (don't change scheduling)
        self.assertPost(
            endpoint_url + f"?uuid={event1.uuid}",
            self.editor,
            {
                "campaign": str(campaign1.uuid),
                "relative_to": "created_on",
                "offset": 15,
                "unit": "days",
                "delivery_hour": -1,
                "flow": str(flow.uuid),
            },
        )

        event1.refresh_from_db()
        self.assertEqual(event1.event_type, CampaignEvent.TYPE_FLOW)
        self.assertIsNone(event1.translations)
        self.assertEqual(event1.flow, flow)
        self.assertEqual(event1.status, "R")  # unchanged
        self.assertEqual(event1.fire_version, 1)  # unchanged
        self.assertGreater(event1.modified_on, modified_on)

        # and update the flow event to be a message event (do change scheduling)
        self.assertPost(
            endpoint_url + f"?uuid={event2.uuid}",
            self.editor,
            {
                "campaign": str(campaign1.uuid),
                "relative_to": "registration",
                "offset": 10,
                "unit": "weeks",
                "delivery_hour": -1,
                "message": {"eng": "OK @(format_urn(urns.tel))", "fra": "D'accord"},
            },
        )

        event2.refresh_from_db()
        self.assertEqual(event2.event_type, CampaignEvent.TYPE_MESSAGE)
        self.assertEqual(
            event2.translations, {"eng": {"text": "OK @(format_urn(urns.tel))"}, "fra": {"text": "D'accord"}}
        )
        self.assertEqual(event2.status, "S")
        self.assertEqual(event2.fire_version, 2)  # bumped

        CampaignEvent.objects.filter(campaign=campaign1).update(status=CampaignEvent.STATUS_READY)

        # and update update it's message again
        self.assertPost(
            endpoint_url + f"?uuid={event2.uuid}",
            self.editor,
            {
                "campaign": str(campaign1.uuid),
                "relative_to": "registration",
                "offset": 15,
                "unit": "weeks",
                "delivery_hour": -1,
                "message": {"eng": "OK", "fra": "D'accord", "kin": "Sawa"},
            },
        )

        event2 = CampaignEvent.objects.filter(campaign=campaign1).order_by("-id").first()
        self.assertEqual(event2.event_type, CampaignEvent.TYPE_MESSAGE)
        self.assertEqual(
            event2.translations, {"eng": {"text": "OK"}, "fra": {"text": "D'accord"}, "kin": {"text": "Sawa"}}
        )

        # try to change an existing event's campaign
        self.assertPost(
            endpoint_url + f"?uuid={event1.uuid}",
            self.editor,
            {
                "campaign": str(campaign2.uuid),
                "relative_to": "registration",
                "offset": 15,
                "unit": "weeks",
                "delivery_hour": -1,
                "message": {"eng": "OK", "fra": "D'accord", "kin": "Sawa"},
            },
            errors={"campaign": "Cannot change campaign for existing events"},
        )

        # try with an invalid UUID for event
        self.assertPost(
            endpoint_url + "?uuid=1234",
            self.editor,
            {
                "campaign": str(campaign1.uuid),
                "relative_to": "registration",
                "offset": 15,
                "unit": "weeks",
                "delivery_hour": -1,
                "message": {"eng": "OK", "fra": "D'accord", "kin": "Sawa"},
            },
            errors={None: "Param 'uuid': 1234 is not a valid UUID."},
        )

        # try an empty delete request
        self.assertDelete(
            endpoint_url, self.editor, errors={None: "URL must contain one of the following parameters: uuid"}
        )

        # try an invalid uuid delete request
        self.assertDelete(
            endpoint_url + "?uuid=1234", self.editor, errors={None: "Param 'uuid': 1234 is not a valid UUID."}
        )

        # delete an event by UUID
        self.assertDelete(endpoint_url + f"?uuid={event1.uuid}", self.editor)

        self.assertFalse(CampaignEvent.objects.filter(id=event1.id, is_active=True).exists())

        # can't make changes to events on archived campaigns
        campaign1.archive(self.admin)

        self.assertPost(
            endpoint_url + f"?uuid={event2.uuid}",
            self.editor,
            {
                "campaign": str(campaign1.uuid),
                "relative_to": "registration",
                "offset": 15,
                "unit": "weeks",
                "delivery_hour": -1,
                "message": {"eng": "OK", "fra": "D'accord", "kin": "Sawa"},
            },
            errors={"campaign": f"No such object: {campaign1.uuid}"},
        )
