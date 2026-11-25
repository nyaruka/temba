from django.urls import reverse

from temba.campaigns.models import Campaign, CampaignEvent
from temba.campaigns.views import CampaignEventCRUDL, CampaignEventForm
from temba.contacts.models import ContactField
from temba.flows.models import Flow
from temba.msgs.models import Msg
from temba.templates.models import TemplateTranslation
from temba.tests import CRUDLTestMixin, TembaTest, mock_mailroom
from temba.utils import json
from temba.utils.compose import compose_serialize
from temba.utils.views.mixins import TEMBA_MENU_SELECTION


def _compose(translations):
    return json.dumps(compose_serialize(translations))


class CampaignEventCRUDLTest(TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        self.create_field("registered", "Registered", value_type="D")

        self.campaign1 = self.create_campaign(self.org, "Welcomes")
        self.other_org_campaign = self.create_campaign(self.org2, "Welcomes")

    def create_campaign(self, org, name):
        user = org.get_admins().first()
        group = self.create_group("Reporters", contacts=[], org=org)
        registered = self.org.fields.get(key="registered")
        campaign = Campaign.create(org, user, name, group)
        flow = self.create_flow(f"{name} Flow", org=org)
        background_flow = self.create_flow(f"{name} Background Flow", org=org, flow_type=Flow.TYPE_BACKGROUND)
        CampaignEvent.create_flow_event(
            org, user, campaign, registered, offset=1, unit="W", flow=flow, delivery_hour="13"
        )
        CampaignEvent.create_flow_event(
            org, user, campaign, registered, offset=2, unit="W", flow=flow, delivery_hour="13"
        )
        CampaignEvent.create_flow_event(
            org, user, campaign, registered, offset=2, unit="W", flow=background_flow, delivery_hour="13"
        )
        return campaign

    def test_read(self):
        event = self.campaign1.events.order_by("id").first()
        read_url = reverse("campaigns.campaignevent_read", args=[event.campaign.uuid, event.uuid])

        self.assertRequestDisallowed(read_url, [None, self.agent, self.admin2])
        response = self.assertReadFetch(read_url, [self.editor, self.admin], context_object=event)

        self.assertContains(response, "Welcomes")
        self.assertContains(response, "1 week after")
        self.assertContains(response, "Registered")
        self.assertEqual("/campaign/active/", response.headers.get(TEMBA_MENU_SELECTION))
        self.assertContentMenu(read_url, self.admin, ["Edit", "Delete"])

        # can't edit an event whilst it's being scheduled
        event.status = CampaignEvent.STATUS_SCHEDULING
        event.save(update_fields=("status",))

        self.assertContentMenu(read_url, self.admin, ["Delete"])

        event.status = CampaignEvent.STATUS_READY
        event.save(update_fields=("status",))

        event.campaign.is_archived = True
        event.campaign.save()

        # archived campaigns should focus the archived menu
        response = self.assertReadFetch(read_url, [self.editor], context_object=event)
        self.assertEqual("/campaign/archived/", response.headers.get(TEMBA_MENU_SELECTION))

        # can't edit the events of an archived campaign
        self.assertContentMenu(read_url, self.admin, ["Delete"])

        # can't view a deleted event
        event.is_active = False
        event.save(update_fields=("is_active",))

        response = self.requestView(read_url, self.editor)
        self.assertEqual(404, response.status_code)

    @mock_mailroom
    def test_create(self, mr_mocks):
        farmer1 = self.create_contact("Rob Jasper", phone="+250788111111")
        farmer2 = self.create_contact("Mike Gordon", phone="+250788222222", language="kin")
        self.create_contact("Trey Anastasio", phone="+250788333333")
        farmers = self.create_group("Farmers", [farmer1, farmer2])

        # create a contact field for our planting date
        planting_date = self.create_field("planting_date", "Planting Date", ContactField.TYPE_DATETIME)

        # update the planting date for our contacts
        self.set_contact_field(farmer1, "planting_date", "1/10/2020")

        # create a campaign for our farmers group
        campaign = Campaign.create(self.org, self.admin, "Planting Reminders", farmers)

        create_url = reverse("campaigns.campaignevent_create", args=[campaign.id])

        # update org to use a single flow language
        self.org.set_flow_languages(self.admin, ["eng"])

        form_fields = [
            "event_type",
            "relative_to",
            "offset",
            "unit",
            "delivery_hour",
            "direction",
            "flow_to_start",
            "flow_start_mode",
            "message_start_mode",
            "compose",
        ]

        self.assertRequestDisallowed(create_url, [None, self.agent])

        response = self.assertCreateFetch(create_url, [self.editor, self.admin], form_fields=form_fields)
        self.assertEqual(3, len(response.context["form"].fields["message_start_mode"].choices))

        # try to submit with missing fields
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "event_type": "M",
                "compose": _compose({"eng": {"text": "This is my message"}}),
                "direction": "A",
                "offset": 1,
                "unit": "W",
                "delivery_hour": 13,
            },
            form_errors={"message_start_mode": "This field is required."},
        )
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "event_type": "F",
                "direction": "A",
                "offset": 1,
                "unit": "W",
                "delivery_hour": 13,
                "compose": _compose({}),
            },
            form_errors={"flow_start_mode": "This field is required.", "flow_to_start": "This field is required."},
        )

        # try to create a message event that's too long
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "relative_to": planting_date.id,
                "event_type": "M",
                "compose": _compose({"eng": {"text": "x" * 4097}}),
                "direction": "A",
                "offset": 1,
                "unit": "W",
                "flow_to_start": "",
                "delivery_hour": 13,
                "message_start_mode": "I",
            },
            form_errors={"compose": "Maximum allowed text is 4096 characters."},
        )

        # can create an event with just a eng translation
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "relative_to": planting_date.id,
                "event_type": "M",
                "compose": _compose({"eng": {"text": "This is my message"}}),
                "direction": "A",
                "offset": 1,
                "unit": "W",
                "flow_to_start": "",
                "delivery_hour": 13,
                "message_start_mode": "I",
            },
            new_obj_query=CampaignEvent.objects.filter(campaign=campaign, event_type="M", fire_version=1, status="S"),
        )

        event1 = CampaignEvent.objects.get(campaign=campaign)
        self.assertEqual(
            {"eng": {"text": "This is my message", "attachments": []}},
            event1.translations,
        )

        # add another language to our org
        self.org.set_flow_languages(self.admin, ["eng", "kin"])

        self.assertCreateFetch(create_url, [self.admin], form_fields=form_fields)

        # have to submit translation for primary language
        response = self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "relative_to": planting_date.id,
                "event_type": "M",
                "compose": _compose({"kin": {"text": "muraho"}}),
                "direction": "B",
                "offset": 2,
                "unit": "W",
                "flow_to_start": "",
                "delivery_hour": 13,
                "message_start_mode": "I",
            },
            form_errors={"compose": "This field is required."},
        )

        response = self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "relative_to": planting_date.id,
                "event_type": "M",
                "compose": _compose(
                    {
                        "eng": {"text": "hello", "quick_replies": [{"text": "Yes"}, {"text": "No"}]},
                        "kin": {"text": "muraho"},
                    }
                ),
                "direction": "B",
                "offset": 2,
                "unit": "W",
                "flow_to_start": "",
                "delivery_hour": 13,
                "message_start_mode": "I",
            },
            new_obj_query=CampaignEvent.objects.filter(campaign=campaign, event_type="M", offset=-2),
        )

        # should be redirected back to our campaign read page
        self.assertRedirect(response, reverse("campaigns.campaign_read", args=[campaign.uuid]))

        # also create a flow event for a regular flow
        flow1 = self.create_flow("Event Flow 1")
        response = self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "relative_to": planting_date.id,
                "event_type": "F",
                "direction": "B",
                "offset": 2,
                "unit": "D",
                "flow_to_start": flow1.id,
                "delivery_hour": 13,
                "flow_start_mode": "I",
            },
            new_obj_query=CampaignEvent.objects.filter(campaign=campaign, event_type="F", flow=flow1, start_mode="I"),
        )

        # and a flow event for a background flow
        flow2 = self.create_flow("Event Flow 2", flow_type=Flow.TYPE_BACKGROUND)
        response = self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "relative_to": planting_date.id,
                "event_type": "F",
                "direction": "B",
                "offset": 2,
                "unit": "D",
                "flow_to_start": flow2.id,
                "delivery_hour": 13,
                "flow_start_mode": "I",
            },
            new_obj_query=CampaignEvent.objects.filter(campaign=campaign, event_type="F", flow=flow2, start_mode="P"),
        )

        event = CampaignEvent.objects.get(campaign=campaign, event_type="M", offset=-2)
        self.assertEqual(-2, event.offset)
        self.assertEqual(13, event.delivery_hour)
        self.assertEqual("W", event.unit)
        self.assertEqual("M", event.event_type)
        self.assertEqual("I", event.start_mode)
        self.assertEqual("S", event.status)
        self.assertIsNone(event.flow)
        self.assertEqual(
            {
                "eng": {
                    "text": "hello",
                    "attachments": [],
                    "quick_replies": [{"text": "Yes"}, {"text": "No"}],
                },
                "kin": {"text": "muraho", "attachments": []},
            },
            event.translations,
        )
        self.assertEqual("eng", event.base_language)

        event.status = CampaignEvent.STATUS_READY
        event.save(update_fields=("status",))

        update_url = reverse("campaigns.campaignevent_update", args=[event.uuid])

        # update the event to be passive
        response = self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "relative_to": planting_date.id,
                "event_type": "M",
                "compose": _compose({"eng": {"text": "hello"}, "kin": {"text": "muraho"}}),
                "direction": "B",
                "offset": 3,
                "unit": "W",
                "flow_to_start": "",
                "delivery_hour": 13,
                "message_start_mode": "P",
            },
        )

        self.assertEqual(response.status_code, 302)
        event = CampaignEvent.objects.get(is_active=True, offset=-3)

        self.assertEqual(-3, event.offset)
        self.assertEqual(13, event.delivery_hour)
        self.assertEqual("W", event.unit)
        self.assertEqual("M", event.event_type)
        self.assertEqual("P", event.start_mode)
        self.assertEqual("S", event.status)

        event.status = CampaignEvent.STATUS_READY
        event.save(update_fields=("status",))

        update_url = reverse("campaigns.campaignevent_update", args=[event.uuid])

        # and add another language to org
        self.org.set_flow_languages(self.admin, ["eng", "kin", "spa"])

        response = self.client.get(update_url)

        compose_initial = response.context["form"].fields["compose"].initial
        self.assertEqual("hello", compose_initial["eng"]["text"])
        self.assertEqual("muraho", compose_initial["kin"]["text"])
        self.assertNotIn("spa", compose_initial)
        self.assertEqual(2, len(response.context["form"].fields["flow_start_mode"].choices))

        # 'Created On' system field must be selectable in the form
        contact_fields = [field.key for field in response.context["form"].fields["relative_to"].queryset]
        self.assertEqual(contact_fields, ["created_on", "last_seen_on", "planting_date", "registered"])

        # translation in new language is optional
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "relative_to": planting_date.id,
                "event_type": "M",
                "compose": _compose(
                    {"eng": {"text": "Required"}, "kin": {"text": "@fields.planting_date"}, "spa": {"text": ""}}
                ),
                "direction": "B",
                "offset": 1,
                "unit": "W",
                "flow_to_start": "",
                "delivery_hour": 13,
                "message_start_mode": "I",
            },
        )

        event.refresh_from_db()

        # we should retain our base language
        self.assertEqual("eng", event.base_language)

        # empty translation should be dropped from the dict
        self.assertNotIn("spa", event.translations)

        # update org languages to something not including the flow's base language
        self.org.set_flow_languages(self.admin, ["por", "kin"])

        event.status = CampaignEvent.STATUS_READY
        event.save(update_fields=("status",))

        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])

        # should still work since compose carries its own language list
        response = self.assertUpdateFetch(update_url, [self.editor, self.admin], form_fields=form_fields)

        compose_initial = response.context["form"].fields["compose"].initial
        self.assertEqual("@fields.planting_date", compose_initial["kin"]["text"])
        self.assertEqual("Required", compose_initial["eng"]["text"])

    @mock_mailroom
    def test_update(self, mr_mocks):
        event1, event2, event3 = self.campaign1.events.order_by("id")
        registered = self.org.fields.get(key="registered")
        accepted = self.create_field("accepted", "Accepted", value_type="D")
        flow = self.org.flows.get(name="Welcomes Flow")

        update_url = reverse("campaigns.campaignevent_update", args=[event1.uuid])

        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])
        self.assertUpdateFetch(
            update_url,
            [self.editor, self.admin],
            form_fields={
                "event_type": "F",
                "relative_to": registered.id,
                "offset": 1,
                "unit": "W",
                "delivery_hour": 13,
                "direction": "A",
                "flow_to_start": flow,
                "flow_start_mode": "I",
                "message_start_mode": None,
                "compose": {},
            },
        )

        # update the first event to a message event
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "event_type": "M",
                "relative_to": accepted.id,
                "compose": _compose({"eng": {"text": "Hi there"}}),
                "direction": "B",
                "offset": 2,
                "unit": "D",
                "flow_to_start": "",
                "delivery_hour": 11,
                "message_start_mode": "I",
            },
        )

        event1.refresh_from_db()
        self.assertEqual(event1.event_type, "M")
        self.assertEqual(event1.relative_to, accepted)
        self.assertEqual(event1.offset, -2)
        self.assertEqual(event1.unit, "D")
        self.assertEqual(event1.delivery_hour, 11)
        self.assertEqual(event1.start_mode, "I")
        self.assertEqual(event1.translations, {"eng": {"text": "Hi there", "attachments": []}})
        self.assertEqual(event1.status, "S")
        self.assertEqual(event1.fire_version, 1)  # bumped

        # can't update an event whilst it's being scheduled
        self.assertRequestDisallowed(update_url, [self.admin])

        event1.status = CampaignEvent.STATUS_READY
        event1.save(update_fields=("status",))

        # if we only update message content, fire version isn't bumped
        response = self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "event_type": "M",
                "relative_to": accepted.id,
                "compose": _compose({"eng": {"text": "Hi there friends"}}),
                "direction": "B",
                "offset": 2,
                "unit": "D",
                "flow_to_start": "",
                "delivery_hour": 11,
                "message_start_mode": "I",
            },
        )
        self.assertEqual(302, response.status_code)

        event1.refresh_from_db()
        self.assertEqual(event1.translations, {"eng": {"text": "Hi there friends", "attachments": []}})
        self.assertEqual(event1.status, "R")  # unchanged
        self.assertEqual(event1.fire_version, 1)  # unchanged

        # event based on background flow should show a warning for it's info text
        event3.status = CampaignEvent.STATUS_READY
        event3.save(update_fields=("status",))

        update_url = reverse("campaigns.campaignevent_update", args=[event3.uuid])
        response = self.requestView(update_url, self.admin)
        self.assertEqual(
            CampaignEventCRUDL.BACKGROUND_WARNING,
            response.context["form"].fields["flow_to_start"].widget.attrs["info_text"],
        )

    @mock_mailroom
    def test_read_with_translations(self, mr_mocks):
        """The read view renders message content and a translation summary."""
        self.org.set_flow_languages(self.admin, ["eng", "kin", "spa", "fra"])

        event = CampaignEvent.create_message_event(
            self.org,
            self.admin,
            self.campaign1,
            self.org.fields.get(key="registered"),
            offset=3,
            unit="D",
            translations={
                "eng": {"text": "Hi there", "attachments": [], "quick_replies": [{"text": "Yes"}, {"text": "No"}]},
                "kin": {"text": "Muraho", "attachments": []},
            },
            base_language="eng",
            delivery_hour=9,
        )

        read_url = reverse("campaigns.campaignevent_read", args=[event.campaign.uuid, event.uuid])
        response = self.requestView(read_url, self.admin)

        # quick replies should be shown
        self.assertContains(response, "Yes")
        self.assertContains(response, "No")

        # single non-base translation, no comma
        self.assertContains(response, "Translation provided in <b>Kinyarwanda</b>")

        # now add a second translation - should use "and" (alphabetical by language name)
        event.translations["spa"] = {"text": "Hola", "attachments": []}
        event.save(update_fields=("translations",))
        response = self.requestView(read_url, self.admin)
        self.assertContains(response, "Translations provided in <b>Kinyarwanda</b> and <b>Spanish</b>")

        # three translations - oxford comma, alphabetical
        event.translations["fra"] = {"text": "Bonjour", "attachments": []}
        event.save(update_fields=("translations",))
        response = self.requestView(read_url, self.admin)
        self.assertContains(response, "Translations provided in <b>French</b>, <b>Kinyarwanda</b>, and <b>Spanish</b>")

        # translations for languages no longer configured on the org should be omitted
        self.org.set_flow_languages(self.admin, ["eng", "kin", "spa"])
        response = self.requestView(read_url, self.admin)
        self.assertContains(response, "Translations provided in <b>Kinyarwanda</b> and <b>Spanish</b>")
        self.assertNotContains(response, "<b>French</b>")

    @mock_mailroom
    def test_create_with_template(self, mr_mocks):
        """Creating a message event with a WhatsApp template persists template + variables."""
        planting_date = self.create_field("planting_date", "Planting Date", ContactField.TYPE_DATETIME)
        campaign = Campaign.create(self.org, self.admin, "With Template", self.create_group("G", []))
        create_url = reverse("campaigns.campaignevent_create", args=[campaign.id])

        template = self.create_template(
            "Hello World",
            [
                TemplateTranslation(
                    channel=self.channel,
                    locale="eng-US",
                    status=TemplateTranslation.STATUS_APPROVED,
                    external_id="1003",
                    external_locale="en_US",
                    namespace="",
                    components=[
                        {"name": "header", "type": "header/media", "variables": {"1": 0}},
                        {"name": "body", "type": "body/text", "content": "Hello {{1}}", "variables": {"1": 1}},
                    ],
                    variables=[{"type": "image"}, {"type": "text"}],
                )
            ],
        )
        trans = template.translations.all().first()

        # missing required attachment variable should error
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "relative_to": planting_date.id,
                "event_type": "M",
                "compose": _compose(
                    {
                        "eng": {
                            "text": "Hello",
                            "template": str(template.uuid),
                            "variables": ["", "World"],
                            "locale": trans.locale,
                        }
                    }
                ),
                "direction": "A",
                "offset": 1,
                "unit": "D",
                "flow_to_start": "",
                "delivery_hour": -1,
                "message_start_mode": "I",
            },
            form_errors={"compose": "The attachment for the WhatsApp template is required."},
        )

        # with the attachment it saves
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "relative_to": planting_date.id,
                "event_type": "M",
                "compose": _compose(
                    {
                        "eng": {
                            "text": "Hello",
                            "template": str(template.uuid),
                            "variables": ["image/jpeg:http://domain/meow.jpg", "World"],
                            "locale": trans.locale,
                        }
                    }
                ),
                "direction": "A",
                "offset": 1,
                "unit": "D",
                "flow_to_start": "",
                "delivery_hour": -1,
                "message_start_mode": "I",
            },
            new_obj_query=CampaignEvent.objects.filter(campaign=campaign, template=template),
        )

        event = CampaignEvent.objects.get(campaign=campaign)
        self.assertEqual(template, event.template)
        self.assertEqual(["image/jpeg:http://domain/meow.jpg", "World"], event.template_variables)

        # editing the event should expose the template + variables back through the compose initial
        event.status = CampaignEvent.STATUS_READY
        event.save(update_fields=("status",))
        update_url = reverse("campaigns.campaignevent_update", args=[event.uuid])
        response = self.requestView(update_url, self.admin)
        initial = response.context["form"].fields["compose"].initial
        self.assertEqual(str(template.uuid), initial["eng"]["template"])
        self.assertEqual(["image/jpeg:http://domain/meow.jpg", "World"], initial["eng"]["variables"])

    @mock_mailroom
    def test_too_many_attachments(self, mr_mocks):
        planting_date = self.create_field("planting_date", "Planting Date", ContactField.TYPE_DATETIME)
        campaign = Campaign.create(self.org, self.admin, "Attachments", self.create_group("Ga", []))
        create_url = reverse("campaigns.campaignevent_create", args=[campaign.id])

        # build the compose payload directly (what the widget would send) to avoid going through
        # compose_serialize which expects DB-format attachment strings
        attachments = [{"content_type": "image/jpeg", "url": f"http://example.com/x{i}.jpg"} for i in range(12)]
        compose = json.dumps({"eng": {"text": "Hi", "attachments": attachments}})
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "relative_to": planting_date.id,
                "event_type": "M",
                "compose": compose,
                "direction": "A",
                "offset": 1,
                "unit": "D",
                "flow_to_start": "",
                "delivery_hour": -1,
                "message_start_mode": "I",
            },
            form_errors={"compose": f"Maximum allowed attachments is {Msg.MAX_ATTACHMENTS} files."},
        )

    @mock_mailroom
    def test_update_form_language_edge_cases(self, mr_mocks):
        """Form init should handle events whose base language or translations don't match current org languages."""
        event = CampaignEvent.create_message_event(
            self.org,
            self.admin,
            self.campaign1,
            self.org.fields.get(key="registered"),
            offset=3,
            unit="D",
            translations={
                "eng": {"text": "Hello"},
                "kin": {"text": "Muraho"},
                "spa": {"text": "Hola"},
            },
            base_language="eng",
            delivery_hour=9,
        )
        update_url = reverse("campaigns.campaignevent_update", args=[event.uuid])

        # primary/base=eng is not in org langs; spa isn't either. Base language is prepended, spa is stripped.
        self.org.set_flow_languages(self.admin, ["por", "kin"])
        response = self.requestView(update_url, self.admin)
        initial = response.context["form"].fields["compose"].initial
        self.assertIn("eng", initial)
        self.assertIn("kin", initial)
        self.assertNotIn("spa", initial)
        langs = json.loads(response.context["form"].fields["compose"].widget.attrs["languages"])
        self.assertEqual([lang["iso"] for lang in langs][0], "eng")

        # base=eng is not in org langs, but org's primary IS in compose — base is appended to the end
        event.translations = {"eng": {"text": "Hi"}, "por": {"text": "Olá"}}
        event.base_language = "eng"
        event.save(update_fields=("translations", "base_language"))
        self.org.set_flow_languages(self.admin, ["por", "kin"])
        response = self.requestView(update_url, self.admin)
        langs = json.loads(response.context["form"].fields["compose"].widget.attrs["languages"])
        iso_order = [lang["iso"] for lang in langs]
        self.assertEqual(iso_order, ["por", "kin", "eng"])

        # base=eng is in org langs but isn't primary (por is), and por isn't in compose — base moves to the front
        self.org.set_flow_languages(self.admin, ["por", "eng"])
        event.translations = {"eng": {"text": "Hi"}, "kin": {"text": "Muraho"}}
        event.save(update_fields=("translations",))
        response = self.requestView(update_url, self.admin)
        langs = json.loads(response.context["form"].fields["compose"].widget.attrs["languages"])
        iso_order = [lang["iso"] for lang in langs]
        self.assertEqual(iso_order[0], "eng")

    @mock_mailroom
    def test_form_flow_queryset_default(self, mr_mocks):
        # the class-level queryset for flow_to_start must not leak flows across orgs - it should be empty by
        # default and only populated when the form is instantiated with an org
        self.assertEqual(0, CampaignEventForm.base_fields["flow_to_start"].queryset.count())

        # but when instantiated with an org, the field should be scoped to that org's flows
        form = CampaignEventForm(self.org)
        flow_qs = form.fields["flow_to_start"].queryset
        self.assertTrue(all(f.org_id == self.org.id for f in flow_qs))

    def test_delete(self):
        event = CampaignEvent.create_message_event(
            self.org,
            self.admin,
            self.campaign1,
            self.org.fields.get(key="registered"),
            offset=3,
            unit="D",
            translations={"eng": {"text": "Hello"}},
            base_language="eng",
            delivery_hour=9,
        )

        delete_url = reverse("campaigns.campaignevent_delete", args=[event.uuid])

        # delete the event
        response = self.assertDeleteSubmit(delete_url, self.admin, object_deactivated=event)
        self.assertRedirect(response, reverse("campaigns.campaign_read", args=[event.campaign.uuid]))
