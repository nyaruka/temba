from datetime import datetime, timezone as tzone
from unittest.mock import patch

from django.contrib.auth.models import Group
from django.urls import reverse

from temba.channels.models import Channel
from temba.contacts.omnibox import omnibox_serialize
from temba.flows.models import Flow
from temba.schedules.models import Schedule
from temba.tests import CRUDLTestMixin, TembaTest
from temba.tests.mailroom import mock_mailroom
from temba.triggers.models import Trigger
from temba.utils.views.mixins import TEMBA_MENU_SELECTION


class TriggerCRUDLTest(TembaTest, CRUDLTestMixin):
    def test_menu(self):
        menu_url = reverse("triggers.trigger_menu")

        self.assertRequestDisallowed(menu_url, [None, self.agent])
        self.assertPageMenu(menu_url, self.editor, ["Active (0)", "Archived (0)", "New Trigger"])

        # create a trigger with no groups
        create_url = reverse("triggers.trigger_create_keyword")
        flow = self.create_flow("My Flow", flow_type=Flow.TYPE_MESSAGE)
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"keywords": ["start"], "flow": flow.id, "match_type": "F"},
            new_obj_query=Trigger.objects.filter(keywords=["start"], flow=flow),
            success_status=200,
        )

        # our keyword trigger should force a messages section
        self.assertPageMenu(menu_url, self.editor, ["Active (1)", "Archived (0)", "New Trigger", "Messages (1)"])

        # have an archived keyword trigger
        trigger = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            groups=[],
            exclude_groups=[],
            keywords=["join"],
            match_type=Trigger.MATCH_ONLY_WORD,
        )

        self.assertPageMenu(menu_url, self.editor, ["Active (2)", "Archived (0)", "New Trigger", "Messages (2)"])

        trigger.archive(self.admin)

        # the archived trigger not counted
        self.assertPageMenu(menu_url, self.editor, ["Active (1)", "Archived (1)", "New Trigger", "Messages (1)"])

    @mock_mailroom
    def test_create(self, mr_mocks):
        create_url = reverse("triggers.trigger_create")
        create_new_convo_url = reverse("triggers.trigger_create_new_conversation")
        create_inbound_call_url = reverse("triggers.trigger_create_inbound_call")
        create_missed_call_url = reverse("triggers.trigger_create_missed_call")
        create_opt_in_url = reverse("triggers.trigger_create_opt_in")

        self.assertLoginRedirect(self.client.get(create_url))

        self.login(self.agent)
        self.assertLoginRedirect(self.client.get(create_url))

        self.login(self.admin)
        response = self.client.get(create_url)

        self.assertNotContains(response, create_opt_in_url)

        # call triggers can be made without a call channel
        self.assertContains(response, create_inbound_call_url)
        self.assertContains(response, create_missed_call_url)

        # but a new conversation trigger can't be created with a suitable channel
        self.assertNotContains(response, create_new_convo_url)

        # create a facebook channel and delete our Android channel
        self.create_channel("FB", "Facebook Channel", "1234567")
        self.channel.release(self.admin)

        response = self.client.get(create_url)
        self.assertContains(response, create_new_convo_url)
        self.assertNotContains(response, create_missed_call_url)

        # opt-in triggers should not appear in the new trigger chooser
        Group.objects.get(name="Beta").user_set.add(self.editor)
        self.login(self.editor, choose_org=self.org)
        response = self.client.get(create_url)

        self.assertNotContains(response, create_opt_in_url)

    def test_create_keyword(self):
        create_url = reverse("triggers.trigger_create_keyword")
        open_tickets = self.org.groups.get(name="Open Tickets")
        flow1 = self.create_flow("Flow 1", flow_type=Flow.TYPE_MESSAGE)
        flow2 = self.create_flow("Flow 2", flow_type=Flow.TYPE_VOICE)

        # flows that shouldn't appear as options
        self.create_flow("Background", flow_type=Flow.TYPE_BACKGROUND)
        self.create_flow("System", is_system=True)

        group1 = self.create_group("Group 1", contacts=[])
        group2 = self.create_group("Group 2", contacts=[])

        self.assertRequestDisallowed(create_url, [None, self.agent])
        response = self.assertCreateFetch(
            create_url,
            [self.editor, self.admin],
            form_fields=["keywords", "match_type", "flow", "channel", "groups", "exclude_groups"],
        )

        # flow options should show messaging and voice flows
        self.assertEqual([flow1, flow2], list(response.context["form"].fields["flow"].queryset))

        # group options are any group
        self.assertEqual([group1, group2, open_tickets], list(response.context["form"].fields["groups"].queryset))
        self.assertEqual(
            [group1, group2, open_tickets], list(response.context["form"].fields["exclude_groups"].queryset)
        )

        # try a keyword with spaces
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"keywords": ["with spaces"], "flow": flow1.id, "match_type": "F"},
            form_errors={
                "keywords": "Must be a single word containing only letters and numbers, or a single emoji character."
            },
        )

        # try a keyword with special characters
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"keywords": ["keyw!o^rd__"], "flow": flow1.id, "match_type": "F"},
            form_errors={
                "keywords": "Must be a single word containing only letters and numbers, or a single emoji character."
            },
        )

        # try with group as both inclusion and exclusion
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "keywords": ["start"],
                "flow": flow1.id,
                "match_type": "F",
                "groups": [group1.id, group2.id],
                "exclude_groups": [group1.id],
            },
            form_errors={"__all__": "Can't include and exclude the same group."},
        )

        # create a trigger with no groups
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"keywords": ["start", "begin"], "flow": flow1.id, "match_type": "F"},
            new_obj_query=Trigger.objects.filter(keywords=["start", "begin"], flow=flow1),
            success_status=200,
        )

        # creating triggers with non-ASCII keywords
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"keywords": ["١٠٠", "मिलाए"], "flow": flow1.id, "match_type": "F"},
            new_obj_query=Trigger.objects.filter(keywords=["١٠٠", "मिलाए"], flow=flow1),
            success_status=200,
        )

        # try a duplicate keyword
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"keywords": ["start"], "flow": flow2.id, "match_type": "F"},
            form_errors={"__all__": "There already exists a trigger of this type with these options."},
        )

        # works if we specify a group
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"keywords": ["start"], "flow": flow2.id, "match_type": "F", "groups": group1.id},
            new_obj_query=Trigger.objects.filter(keywords=["start"], flow=flow2, groups=group1),
            success_status=200,
        )

        # or a channel
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"keywords": ["start"], "flow": flow2.id, "match_type": "F", "channel": self.channel.id},
            new_obj_query=Trigger.objects.filter(keywords=["start"], flow=flow2, channel=self.channel),
            success_status=200,
        )

        # groups between triggers can't overlap
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"keywords": ["start"], "flow": flow2.id, "match_type": "F", "groups": [group1.id, group2.id]},
            form_errors={"__all__": "There already exists a trigger of this type with these options."},
        )

    def test_create_schedule(self):
        create_url = reverse("triggers.trigger_create_schedule")
        group1 = self.create_group("Group 1", contacts=[])
        group2 = self.create_group("Group 2", contacts=[])
        contact1 = self.create_contact("Jim", phone="+250788987654")

        flow1 = self.create_flow("Flow 1", flow_type=Flow.TYPE_MESSAGE)
        flow2 = self.create_flow("Flow 2", flow_type=Flow.TYPE_BACKGROUND)
        flow3 = self.create_flow("Flow 3", flow_type=Flow.TYPE_VOICE)

        # flows that shouldn't appear as options
        self.create_flow("Flow 4", flow_type=Flow.TYPE_SURVEY)
        self.create_flow("Flow 5", is_system=True)

        self.assertRequestDisallowed(create_url, [None, self.agent])
        response = self.assertCreateFetch(
            create_url,
            [self.editor, self.admin],
            form_fields=[
                "start_datetime",
                "repeat_period",
                "repeat_days_of_week",
                "flow",
                "groups",
                "contacts",
                "exclude_groups",
            ],
        )

        # check we allow messaging, voice and background flows
        self.assertEqual([flow1, flow2, flow3], list(response.context["form"].fields["flow"].queryset))

        # try to create trigger with an empty form
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {},
            form_errors={
                "__all__": "Must provide at least one group or contact to include.",
                "start_datetime": "This field is required.",
                "repeat_period": "This field is required.",
                "flow": "This field is required.",
            },
        )

        # try to create a weekly repeating schedule without specifying the days of the week
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"start_datetime": "2021-06-24 12:00", "repeat_period": "W", "flow": flow1.id, "groups": [group1.id]},
            form_errors={"repeat_days_of_week": "Must specify at least one day of the week."},
        )

        # try to create a weekly repeating schedule with an invalid day of the week (UI doesn't actually allow this)
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "start_datetime": "2021-06-24 12:00",
                "repeat_period": "W",
                "repeat_days_of_week": ["X"],
                "flow": flow1.id,
                "groups": [group1.id],
            },
            form_errors={"repeat_days_of_week": "Select a valid choice. X is not one of the available choices."},
        )

        # still shouldn't have created anything
        self.assertEqual(0, Trigger.objects.count())
        self.assertEqual(0, Schedule.objects.count())

        # now create a valid trigger
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "start_datetime": "2021-06-24 12:00",
                "repeat_period": "W",
                "repeat_days_of_week": ["M", "F"],
                "flow": flow1.id,
                "groups": [group1.id],
                "contacts": omnibox_serialize(self.org, [], [contact1], encode=True),
                "exclude_groups": [group2.id],
            },
            new_obj_query=Trigger.objects.filter(trigger_type="S", flow=flow1),
            success_status=200,
        )

        trigger = Trigger.objects.get()
        self.assertIsNotNone(trigger.schedule)
        self.assertEqual("W", trigger.schedule.repeat_period)
        self.assertEqual("MF", trigger.schedule.repeat_days_of_week)
        self.assertEqual({group1}, set(trigger.groups.all()))
        self.assertEqual({group2}, set(trigger.exclude_groups.all()))
        self.assertEqual({contact1}, set(trigger.contacts.all()))

        # there is no conflict detection for scheduled triggers so can create the same trigger again
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {
                "start_datetime": "2021-06-24 12:00",
                "repeat_period": "W",
                "repeat_days_of_week": ["M", "F"],
                "flow": flow1.id,
                "groups": [group1.id],
                "contacts": omnibox_serialize(self.org, [], [contact1], encode=True),
                "exclude_groups": [group2.id],
            },
            new_obj_query=Trigger.objects.filter(trigger_type="S", flow=flow1).exclude(id=trigger.id),
            success_status=200,
        )

    def test_create_inbound_call(self):
        channel1 = self.create_channel("NX", "Vonage", "78598", "AC")
        channel2 = self.create_channel("T", "Twilio", "34636", "SRAC")

        # channels that shouldn't appear as options
        self.create_channel("T", "Twilio", "45674", "SR")

        flow1 = self.create_flow("Flow 1", flow_type=Flow.TYPE_VOICE)
        flow2 = self.create_flow("Flow 2", flow_type=Flow.TYPE_VOICE)
        flow3 = self.create_flow("Flow 3", flow_type=Flow.TYPE_MESSAGE)
        flow4 = self.create_flow("Flow 4", flow_type=Flow.TYPE_BACKGROUND)
        group1 = self.create_group("Group 1", contacts=[])
        group2 = self.create_group("Group 2", contacts=[])

        # flows that shouldn't appear as options
        self.create_flow("Flow 5", is_system=True)
        self.create_flow("Flow 6", org=self.org2)

        create_url = reverse("triggers.trigger_create_inbound_call")

        self.assertRequestDisallowed(create_url, [None, self.agent])
        response = self.assertCreateFetch(
            create_url,
            [self.editor, self.admin],
            form_fields=["action", "voice_flow", "msg_flow", "channel", "groups", "exclude_groups"],
        )

        # check which flows appear in which fields
        self.assertEqual([flow1, flow2], list(response.context["form"].fields["voice_flow"].queryset))
        self.assertEqual([flow3, flow4], list(response.context["form"].fields["msg_flow"].queryset))

        # check which channels are allowed
        self.assertEqual([channel2, channel1], list(response.context["form"].fields["channel"].queryset))

        # which flow field is required depends on the action selected
        self.assertCreateSubmit(
            create_url, self.admin, {"action": "answer"}, form_errors={"voice_flow": "This field is required."}
        )
        self.assertCreateSubmit(
            create_url, self.admin, {"action": "hangup"}, form_errors={"msg_flow": "This field is required."}
        )

        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"action": "answer", "voice_flow": flow1.id, "groups": group1.id},
            new_obj_query=Trigger.objects.filter(flow=flow1, trigger_type=Trigger.TYPE_INBOUND_CALL),
            success_status=200,
        )

        # can't create another inbound call trigger for same group
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"action": "answer", "voice_flow": flow2.id, "groups": group1.id},
            form_errors={"__all__": "There already exists a trigger of this type with these options."},
        )

        # even if it's for a different type of flow
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"action": "hangup", "msg_flow": flow3.id, "groups": group1.id},
            form_errors={"__all__": "There already exists a trigger of this type with these options."},
        )

        # but can for different group
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"action": "answer", "voice_flow": flow2.id, "groups": group2.id},
            new_obj_query=Trigger.objects.filter(flow=flow2, trigger_type=Trigger.TYPE_INBOUND_CALL),
            success_status=200,
        )

    def test_create_missed_call(self):
        # make our channel support ivr
        self.channel.role += Channel.ROLE_CALL + Channel.ROLE_ANSWER
        self.channel.save()

        flow1 = self.create_flow("Flow 1", flow_type=Flow.TYPE_MESSAGE)
        flow2 = self.create_flow("Flow 2", flow_type=Flow.TYPE_BACKGROUND)

        # flows that shouldn't appear as options
        self.create_flow("Flow 3", flow_type=Flow.TYPE_VOICE)
        self.create_flow("Flow 4", is_system=True)
        self.create_flow("Flow 5", org=self.org2)

        create_url = reverse("triggers.trigger_create_missed_call")

        self.assertRequestDisallowed(create_url, [None, self.agent])
        response = self.assertCreateFetch(
            create_url, [self.editor, self.admin], form_fields=["flow", "groups", "exclude_groups"]
        )

        # flow options should be messaging and voice flows
        self.assertEqual([flow1, flow2], list(response.context["form"].fields["flow"].queryset))

        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow1.id},
            new_obj_query=Trigger.objects.filter(flow=flow1, trigger_type=Trigger.TYPE_MISSED_CALL),
            success_status=200,
        )

        # we can't create another...
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow2.id},
            form_errors={"__all__": "There already exists a trigger of this type with these options."},
        )

    @patch("temba.channels.types.facebook_legacy.FacebookLegacyType.activate_trigger")
    @patch("temba.channels.types.viber.ViberType.activate_trigger")
    def test_create_new_conversation(self, mock_vp_activate, mock_fb_activate):
        create_url = reverse("triggers.trigger_create_new_conversation")
        flow1 = self.create_flow("Flow 1", flow_type=Flow.TYPE_MESSAGE)
        flow2 = self.create_flow("Flow 2", flow_type=Flow.TYPE_MESSAGE)

        # flows that shouldn't appear as options
        self.create_flow("Flow 3", flow_type=Flow.TYPE_VOICE)
        self.create_flow("Flow 4", flow_type=Flow.TYPE_BACKGROUND)
        self.create_flow("Flow 5", is_system=True)

        channel1 = self.create_channel("FB", "Facebook Channel", "1234567")
        channel2 = self.create_channel("VP", "Viber Channel", "1234567")
        self.create_channel("A", "Android Channel", "+1234")

        self.assertRequestDisallowed(create_url, [None, self.agent])
        response = self.assertCreateFetch(
            create_url, [self.editor, self.admin], form_fields=["flow", "channel", "groups", "exclude_groups"]
        )

        # flow options should show messaging and voice flows
        self.assertEqual([flow1, flow2], list(response.context["form"].fields["flow"].queryset))

        # channel options should only be channels that support conversations
        self.assertEqual([channel1, channel2], list(response.context["form"].fields["channel"].queryset))

        # go create it
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"channel": channel1.id, "flow": flow1.id},
            new_obj_query=Trigger.objects.filter(
                trigger_type=Trigger.TYPE_NEW_CONVERSATION, is_active=True, is_archived=False, channel=channel1
            ),
            success_status=200,
        )
        self.assertEqual(mock_fb_activate.call_count, 1)

        # try to create another one, fails as we already have a trigger for that channel
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"channel": channel1.id, "flow": flow1.id},
            form_errors={"__all__": "There already exists a trigger of this type with these options."},
        )

        # but can create a different trigger for a different channel
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"channel": channel2.id, "flow": flow1.id},
            new_obj_query=Trigger.objects.filter(
                trigger_type=Trigger.TYPE_NEW_CONVERSATION, is_active=True, is_archived=False, channel=channel2
            ),
            success_status=200,
        )
        self.assertEqual(mock_vp_activate.call_count, 1)

    @patch("temba.channels.types.facebook_legacy.FacebookLegacyType.activate_trigger")
    def test_create_referral(self, mock_fb_activate):
        create_url = reverse("triggers.trigger_create_referral")
        flow1 = self.create_flow("Flow 1", flow_type=Flow.TYPE_MESSAGE)
        flow2 = self.create_flow("Flow 2", flow_type=Flow.TYPE_MESSAGE)

        # flows that shouldn't appear as options
        self.create_flow("Flow 3", flow_type=Flow.TYPE_VOICE)
        self.create_flow("Flow 4", flow_type=Flow.TYPE_BACKGROUND)
        self.create_flow("Flow 5", is_system=True)

        channel1 = self.create_channel("FB", "Facebook 1", "1234567")
        channel2 = self.create_channel("FB", "Facebook 2", "2345678")
        self.create_channel("A", "Android Channel", "+1234")

        self.assertRequestDisallowed(create_url, [None, self.agent])
        response = self.assertCreateFetch(
            create_url,
            [self.editor, self.admin],
            form_fields=["referrer_id", "flow", "channel", "groups", "exclude_groups"],
        )

        # flow options should show messaging and voice flows
        self.assertEqual([flow1, flow2], list(response.context["form"].fields["flow"].queryset))

        # channel options should only be channels that support referrals
        self.assertEqual([channel1, channel2], list(response.context["form"].fields["channel"].queryset))

        # go create it
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"channel": channel1.id, "flow": flow1.id, "referrer_id": "234567"},
            new_obj_query=Trigger.objects.filter(
                trigger_type=Trigger.TYPE_REFERRAL, channel=channel1, referrer_id="234567"
            ),
            success_status=200,
        )
        self.assertEqual(mock_fb_activate.call_count, 1)

        # try to create another one, fails as we already have a trigger for that channel and referrer
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"channel": channel1.id, "flow": flow1.id, "referrer_id": "234567"},
            form_errors={"__all__": "There already exists a trigger of this type with these options."},
        )

        # but can create a different trigger for a different referrer
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"channel": channel1.id, "flow": flow1.id, "referrer_id": "345678"},
            new_obj_query=Trigger.objects.filter(
                trigger_type=Trigger.TYPE_REFERRAL, channel=channel1, referrer_id="345678"
            ),
            success_status=200,
        )

        # or blank referrer
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"channel": channel2.id, "flow": flow1.id, "referrer_id": ""},
            new_obj_query=Trigger.objects.filter(trigger_type=Trigger.TYPE_REFERRAL, channel=channel2, referrer_id=""),
            success_status=200,
        )

        # or channel
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"channel": channel2.id, "flow": flow1.id, "referrer_id": "234567"},
            new_obj_query=Trigger.objects.filter(
                trigger_type=Trigger.TYPE_REFERRAL, channel=channel2, referrer_id="234567"
            ),
            success_status=200,
        )

    def test_create_catchall(self):
        create_url = reverse("triggers.trigger_create_catchall")
        open_tickets = self.org.groups.get(name="Open Tickets")
        flow1 = self.create_flow("Flow 1", flow_type=Flow.TYPE_MESSAGE)
        flow2 = self.create_flow("Flow 2", flow_type=Flow.TYPE_VOICE)

        # flows that shouldn't appear as options
        self.create_flow("Background", flow_type=Flow.TYPE_BACKGROUND)
        self.create_flow("System", is_system=True)

        group1 = self.create_group("Group 1", contacts=[])
        group2 = self.create_group("Group 2", contacts=[])

        self.assertRequestDisallowed(create_url, [None, self.agent])
        response = self.assertCreateFetch(
            create_url, [self.editor, self.admin], form_fields=["flow", "channel", "groups", "exclude_groups"]
        )

        # flow options should show messaging and voice flows
        self.assertEqual([flow1, flow2], list(response.context["form"].fields["flow"].queryset))

        # group options are any group
        self.assertEqual([group1, group2, open_tickets], list(response.context["form"].fields["groups"].queryset))

        # create a trigger with no groups
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow1.id},
            new_obj_query=Trigger.objects.filter(trigger_type=Trigger.TYPE_CATCH_ALL, flow=flow1),
            success_status=200,
        )

        # try a duplicate catch all with no groups
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow2.id},
            form_errors={"__all__": "There already exists a trigger of this type with these options."},
        )

        # works if we specify a group
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow2.id, "groups": group1.id},
            new_obj_query=Trigger.objects.filter(trigger_type=Trigger.TYPE_CATCH_ALL, flow=flow2),
            success_status=200,
        )

        # or a channel
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow2.id, "channel": self.channel.id},
            new_obj_query=Trigger.objects.filter(trigger_type=Trigger.TYPE_CATCH_ALL, flow=flow2, channel=self.channel),
            success_status=200,
        )

        # groups between triggers can't overlap
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow2.id, "groups": [group1.id, group2.id]},
            form_errors={"__all__": "There already exists a trigger of this type with these options."},
        )

    def test_create_closed_ticket(self):
        flow1 = self.create_flow("Flow 1", flow_type=Flow.TYPE_MESSAGE)
        flow2 = self.create_flow("Flow 2", flow_type=Flow.TYPE_VOICE)
        flow3 = self.create_flow("Flow 3", flow_type=Flow.TYPE_BACKGROUND)

        # flows that shouldn't appear as options
        self.create_flow("Flow 4", is_system=True)
        self.create_flow("Flow 5", org=self.org2)

        create_url = reverse("triggers.trigger_create_closed_ticket")

        self.assertRequestDisallowed(create_url, [None, self.agent])
        response = self.assertCreateFetch(
            create_url, [self.editor, self.admin], form_fields=["flow", "groups", "exclude_groups"]
        )

        # flow options should be messaging, voice and background flows
        self.assertEqual([flow1, flow2, flow3], list(response.context["form"].fields["flow"].queryset))

        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow1.id},
            new_obj_query=Trigger.objects.filter(flow=flow1, trigger_type=Trigger.TYPE_CLOSED_TICKET),
            success_status=200,
        )

        # we can't create another...
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow2.id},
            form_errors={"__all__": "There already exists a trigger of this type with these options."},
        )

    def test_create_opt_in(self):
        flow1 = self.create_flow("Flow 1", flow_type=Flow.TYPE_MESSAGE)
        flow2 = self.create_flow("Flow 2", flow_type=Flow.TYPE_BACKGROUND)
        group1 = self.create_group("Group 1", contacts=[])

        channel1 = self.create_channel("FB", "Facebook 1", "1234567")
        channel2 = self.create_channel("FB", "Facebook 2", "2345678")

        # flows that shouldn't appear as options
        self.create_flow("Flow 3", flow_type=Flow.TYPE_VOICE)
        self.create_flow("Flow 4", is_system=True)
        self.create_flow("Flow 5", org=self.org2)

        create_url = reverse("triggers.trigger_create_opt_in")

        self.assertRequestDisallowed(create_url, [None, self.agent])
        response = self.assertCreateFetch(
            create_url, [self.editor, self.admin], form_fields=["flow", "channel", "groups", "exclude_groups"]
        )

        # flow options should be messaging and background flows
        self.assertEqual([flow1, flow2], list(response.context["form"].fields["flow"].queryset))

        # channel options should only be channels that support optins
        self.assertEqual([channel1, channel2], list(response.context["form"].fields["channel"].queryset))

        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow1.id},
            new_obj_query=Trigger.objects.filter(flow=flow1, trigger_type=Trigger.TYPE_OPT_IN),
            success_status=200,
        )

        # we can't create another
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow2.id},
            form_errors={"__all__": "There already exists a trigger of this type with these options."},
        )

        # works if we specify a group
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow2.id, "groups": group1.id},
            new_obj_query=Trigger.objects.filter(trigger_type=Trigger.TYPE_OPT_IN, flow=flow2),
            success_status=200,
        )

        # or a channel
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow2.id, "channel": channel2.id},
            new_obj_query=Trigger.objects.filter(trigger_type=Trigger.TYPE_OPT_IN, flow=flow2, channel=channel2),
            success_status=200,
        )

    def test_create_opt_out(self):
        flow1 = self.create_flow("Flow 1", flow_type=Flow.TYPE_MESSAGE)
        flow2 = self.create_flow("Flow 2", flow_type=Flow.TYPE_BACKGROUND)
        group1 = self.create_group("Group 1", contacts=[])

        channel1 = self.create_channel("FB", "Facebook 1", "1234567")
        channel2 = self.create_channel("FB", "Facebook 2", "2345678")

        # flows that shouldn't appear as options
        self.create_flow("Flow 3", flow_type=Flow.TYPE_VOICE)
        self.create_flow("Flow 4", is_system=True)
        self.create_flow("Flow 5", org=self.org2)

        create_url = reverse("triggers.trigger_create_opt_out")

        self.assertRequestDisallowed(create_url, [None, self.agent])
        response = self.assertCreateFetch(
            create_url, [self.editor, self.admin], form_fields=["flow", "channel", "groups", "exclude_groups"]
        )

        # flow options should be messaging and background flows
        self.assertEqual([flow1, flow2], list(response.context["form"].fields["flow"].queryset))

        # channel options should only be channels that support optins
        self.assertEqual([channel1, channel2], list(response.context["form"].fields["channel"].queryset))

        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow1.id},
            new_obj_query=Trigger.objects.filter(flow=flow1, trigger_type=Trigger.TYPE_OPT_OUT),
            success_status=200,
        )

        # we can't create another...
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow2.id},
            form_errors={"__all__": "There already exists a trigger of this type with these options."},
        )

        # works if we specify a group
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow2.id, "groups": group1.id},
            new_obj_query=Trigger.objects.filter(trigger_type=Trigger.TYPE_OPT_OUT, flow=flow2),
            success_status=200,
        )

        # or a channel
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"flow": flow2.id, "channel": channel1.id},
            new_obj_query=Trigger.objects.filter(trigger_type=Trigger.TYPE_OPT_OUT, flow=flow2, channel=channel1),
            success_status=200,
        )

    def test_update_keyword(self):
        flow = self.create_flow("Test")
        group1 = self.create_group("Chat", contacts=[])
        group2 = self.create_group("Testers", contacts=[])
        group3 = self.create_group("Doctors", contacts=[])
        channel1 = self.create_channel("NX", "Nexmo", "345636", role="SRAC")
        trigger = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            groups=(group1,),
            keywords=["join", "start"],
            match_type=Trigger.MATCH_ONLY_WORD,
        )

        update_url = reverse("triggers.trigger_update", args=[trigger.id])

        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])
        self.assertUpdateFetch(
            update_url,
            [self.editor, self.admin],
            form_fields={
                "keywords": ["join", "start"],
                "match_type": "O",
                "flow": flow.id,
                "channel": None,
                "groups": [group1],
                "exclude_groups": [],
            },
        )

        # submit with valid keyword and extra group
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "keywords": ["begin", "start"],
                "flow": flow.id,
                "match_type": "O",
                "channel": channel1.id,
                "groups": [group1.id, group2.id],
                "exclude_groups": [group3.id],
            },
        )

        trigger.refresh_from_db()
        self.assertEqual(["begin", "start"], trigger.keywords)
        self.assertEqual(flow, trigger.flow)
        self.assertEqual(Trigger.MATCH_ONLY_WORD, trigger.match_type)
        self.assertEqual(channel1, trigger.channel)
        self.assertEqual({group1, group2}, set(trigger.groups.all()))
        self.assertEqual({group3}, set(trigger.exclude_groups.all()))
        self.assertEqual(7, trigger.priority)

        # error if keyword is not defined or invalid
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"keywords": "", "flow": flow.id, "match_type": "F"},
            form_errors={"keywords": "This field is required."},
            object_unchanged=trigger,
        )
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"keywords": ["two words"], "flow": flow.id, "match_type": "F"},
            form_errors={
                "keywords": "Must be a single word containing only letters and numbers, or a single emoji character."
            },
            object_unchanged=trigger,
        )

    def test_update_inbound_call(self):
        flow1 = self.create_flow("Test 1", flow_type=Flow.TYPE_VOICE)
        flow2 = self.create_flow("Test 2", flow_type=Flow.TYPE_VOICE)
        flow3 = self.create_flow("Test 3", flow_type=Flow.TYPE_MESSAGE)
        call_channel = Channel.create(
            self.org,
            self.admin,
            "US",
            "TW",
            "Twilio Call channel",
            "123456",
            role=Channel.ROLE_CALL + Channel.ROLE_ANSWER,
        )
        trigger = Trigger.create(self.org, self.admin, Trigger.TYPE_INBOUND_CALL, flow2, channel=call_channel)

        update_url = reverse("triggers.trigger_update", args=[trigger.id])

        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])
        self.assertUpdateFetch(
            update_url,
            [self.editor, self.admin],
            form_fields={
                "action": "answer",
                "voice_flow": flow2,
                "msg_flow": None,
                "channel": call_channel.id,
                "groups": [],
                "exclude_groups": [],
            },
        )

        # switch to different voice flow
        self.assertUpdateSubmit(update_url, self.admin, {"action": "answer", "voice_flow": flow1.id})

        trigger.refresh_from_db()
        self.assertEqual(flow1, trigger.flow)

        # switch to a message flow
        self.assertUpdateSubmit(update_url, self.admin, {"action": "hangup", "msg_flow": flow3.id})

        trigger.refresh_from_db()
        self.assertEqual(flow3, trigger.flow)

        # check form shows correct initial values now
        self.assertUpdateFetch(
            update_url,
            [self.admin],
            form_fields={
                "action": "hangup",
                "voice_flow": None,
                "msg_flow": flow3,
                "channel": None,
                "groups": [],
                "exclude_groups": [],
            },
        )

    def test_update_schedule(self):
        flow1 = self.create_flow("Test")
        group1 = self.create_group("Chat", contacts=[])
        group2 = self.create_group("Testers", contacts=[])
        contact1 = self.create_contact("Jim", phone="+250788987651")
        contact2 = self.create_contact("Bob", phone="+250788987652")
        tz = self.org.timezone

        schedule = Schedule.create(
            self.org,
            start_time=datetime(2021, 6, 24, 12, 0, 0, 0).replace(tzinfo=tz),
            repeat_period=Schedule.REPEAT_WEEKLY,
            repeat_days_of_week="MF",
        )
        trigger = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_SCHEDULE,
            flow1,
            groups=[group1],
            exclude_groups=[group2],
            contacts=(contact1,),
            schedule=schedule,
        )

        next_fire = trigger.schedule.calculate_next_fire(datetime(2021, 6, 23, 12, 0, 0, 0, tzone.utc))  # Wed 23rd
        self.assertEqual(datetime(2021, 6, 25, 12, 0, 0, 0).replace(tzinfo=tz), next_fire)  # Fri 25th

        update_url = reverse("triggers.trigger_update", args=[trigger.id])

        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])
        self.assertUpdateFetch(
            update_url,
            [self.editor, self.admin],
            form_fields={
                "start_datetime": schedule.next_fire,
                "repeat_period": "W",
                "repeat_days_of_week": ["M", "F"],
                "flow": flow1.id,
                "groups": [group1],
                "contacts": [{"id": str(contact1.uuid), "name": "Jim", "type": "contact", "urn": "0788 987 651"}],
                "exclude_groups": [group2],
            },
        )

        # try to update a weekly repeating schedule without specifying the days of the week
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"start_datetime": "2021-06-24 12:00", "repeat_period": "W", "flow": flow1.id, "groups": [group1.id]},
            form_errors={"repeat_days_of_week": "Must specify at least one day of the week."},
            object_unchanged=trigger,
        )

        # try to create a weekly repeating schedule with an invalid day of the week (UI doesn't actually allow this)
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "start_datetime": "2021-06-24 12:00",
                "repeat_period": "W",
                "repeat_days_of_week": ["X"],
                "flow": flow1.id,
                "groups": [group1.id],
            },
            form_errors={"repeat_days_of_week": "Select a valid choice. X is not one of the available choices."},
            object_unchanged=trigger,
        )

        # try to submit without any groups or contacts
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"start_datetime": "2021-06-24 12:00", "repeat_period": "W", "flow": flow1.id},
            form_errors={"__all__": "Must provide at least one group or contact to include."},
            object_unchanged=trigger,
        )

        # submit with valid data...
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "start_datetime": "2021-06-24T10:00Z",
                "repeat_period": "D",
                "flow": flow1.id,
                "groups": [group2.id],
                "exclude_groups": [group1.id],
                "contacts": omnibox_serialize(self.org, (), [contact2], encode=True),
            },
        )

        trigger.refresh_from_db()
        self.assertEqual("D", trigger.schedule.repeat_period)
        self.assertIsNone(trigger.schedule.repeat_days_of_week)
        self.assertEqual({group2}, set(trigger.groups.all()))
        self.assertEqual({group1}, set(trigger.exclude_groups.all()))
        self.assertEqual({contact2}, set(trigger.contacts.all()))

        next_fire = trigger.schedule.calculate_next_fire(datetime(2021, 6, 23, 12, 0, 0, 0, tzone.utc))  # Wed 23rd
        self.assertEqual(datetime(2021, 6, 24, 12, 0, 0, 0).replace(tzinfo=tz), next_fire)  # Thu 24th

    @patch("temba.channels.types.facebook_legacy.FacebookLegacyType.deactivate_trigger")
    @patch("temba.channels.types.facebook_legacy.FacebookLegacyType.activate_trigger")
    def test_list(self, mock_activate_trigger, mock_deactivate_trigger):
        list_url = reverse("triggers.trigger_list")

        flow1 = self.create_flow("Report")
        flow2 = self.create_flow("Survey")
        flow3 = self.create_flow("Test", org=self.org2)
        channel = self.create_channel("FB", "Facebook", "1234567")
        trigger1 = Trigger.create(
            self.org, self.admin, Trigger.TYPE_KEYWORD, flow1, keywords=["abc"], match_type=Trigger.MATCH_FIRST_WORD
        )
        trigger2 = Trigger.create(
            self.org, self.admin, Trigger.TYPE_KEYWORD, flow2, keywords=["test"], match_type=Trigger.MATCH_ONLY_WORD
        )
        trigger3 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow1,
            keywords=["start", "begin"],
            match_type=Trigger.MATCH_ONLY_WORD,
        )
        trigger4 = Trigger.create(self.org, self.admin, Trigger.TYPE_NEW_CONVERSATION, flow1, channel=channel)

        Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow1,
            keywords=["archived"],
            match_type=Trigger.MATCH_ONLY_WORD,
            is_archived=True,
        )
        Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow1,
            keywords=["inactive"],
            match_type=Trigger.MATCH_ONLY_WORD,
            is_active=False,
        )
        Trigger.create(
            self.org2, self.admin, Trigger.TYPE_KEYWORD, flow3, keywords=["other"], match_type=Trigger.MATCH_ONLY_WORD
        )

        self.assertRequestDisallowed(list_url, [None, self.agent])
        response = self.assertListFetch(
            list_url, [self.editor, self.admin], context_objects=[trigger4, trigger3, trigger2, trigger1]
        )
        self.assertEqual(("archive",), response.context["actions"])

        # can search by keyword
        self.assertListFetch(list_url + "?search=Start", [self.admin], context_objects=[trigger3])

        # can search by keyword
        self.assertListFetch(list_url + "?search=begin", [self.admin], context_objects=[trigger3])

        # or flow name
        self.assertListFetch(list_url + "?search=VEY", [self.admin], context_objects=[trigger2])

        # can archive it
        self.client.post(list_url, {"action": "archive", "objects": trigger3.id})

        trigger3.refresh_from_db()
        self.assertTrue(trigger3.is_archived)

        # no longer appears in list
        self.assertListFetch(list_url, [self.admin], context_objects=[trigger4, trigger2, trigger1])

        # test when archiving fails
        mock_deactivate_trigger.side_effect = ValueError("boom")

        response = self.client.post(list_url, {"action": "archive", "objects": trigger4.id})
        # TODO: Convert to temba-toast
        # self.assertEqual("An error occurred while making your changes. Please try again.", response["Temba-Toast"])

    def test_list_redirect_when_no_triggers(self):
        Trigger.objects.all().delete()

        self.login(self.admin)
        response = self.client.get(reverse("triggers.trigger_list"))
        self.assertEqual(response.status_code, 302)
        self.assertRedirect(response, reverse("triggers.trigger_create"))

    def test_archived(self):
        flow = self.create_flow("Test")
        other_org_flow = self.create_flow("Test", org=self.org2)

        # create archived triggers
        trigger1 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            keywords=["start"],
            match_type=Trigger.MATCH_ONLY_WORD,
            is_archived=True,
        )
        trigger2 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            keywords=["join"],
            match_type=Trigger.MATCH_ONLY_WORD,
            is_archived=True,
        )

        # create triggers that shouldn't appear in the archived view
        Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            keywords=["active"],
            match_type=Trigger.MATCH_ONLY_WORD,
            is_archived=False,
        )
        Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            keywords=["inactive"],
            match_type=Trigger.MATCH_ONLY_WORD,
            is_active=False,
        )
        Trigger.create(
            self.org2,
            self.admin,
            Trigger.TYPE_KEYWORD,
            other_org_flow,
            keywords=["other"],
            match_type=Trigger.MATCH_ONLY_WORD,
        )

        archived_url = reverse("triggers.trigger_archived")
        list_url = reverse("triggers.trigger_list")

        self.assertRequestDisallowed(archived_url, [None, self.agent])
        response = self.assertListFetch(archived_url, [self.editor, self.admin], context_objects=[trigger2, trigger1])
        self.assertEqual(("restore", "delete"), response.context["actions"])

        # can restore it
        self.client.post(archived_url, {"action": "restore", "objects": trigger1.id})

        response = self.client.get(archived_url)

        self.assertNotContains(response, "startkeyword")

        response = self.client.get(list_url)

        # should be back in the main trigger list
        self.assertContains(response, "start")

        # once archived we can duplicate it but with one active at a time
        trigger = Trigger.objects.get(keywords=["start"])
        trigger.is_archived = True
        trigger.save(update_fields=("is_archived",))

        response = self.client.post(
            reverse("triggers.trigger_create_keyword"), data={"keywords": ["start"], "flow": flow.id, "match_type": "F"}
        )
        self.assertEqual(Trigger.objects.filter(keywords=["start"]).count(), 2)
        self.assertEqual(1, Trigger.objects.filter(keywords=["start"], is_archived=False).count())

        other_trigger = Trigger.objects.filter(keywords=["start"], is_archived=False)[0]
        self.assertFalse(trigger.pk == other_trigger.pk)

        # try archiving it we have one archived and the other active
        response = self.client.get(archived_url)
        self.assertContains(response, "start")

        self.client.post(archived_url, {"action": "restore", "objects": trigger.id})

        response = self.client.get(archived_url)
        self.assertContains(response, "start")

        response = self.client.get(list_url)
        self.assertContains(response, "start")
        self.assertEqual(1, Trigger.objects.filter(keywords=["start"], is_archived=False).count())
        self.assertNotEqual(other_trigger, Trigger.objects.filter(keywords=["start"], is_archived=False)[0])

        self.contact = self.create_contact("Eric", phone="+250788382382")
        self.contact2 = self.create_contact("Nic", phone="+250788383383")
        group1 = self.create_group("first", [self.contact2])
        group2 = self.create_group("second", [self.contact])
        group3 = self.create_group("third", [self.contact, self.contact2])

        self.assertEqual(Trigger.objects.filter(keywords=["start"]).count(), 2)
        self.assertEqual(Trigger.objects.filter(keywords=["start"], is_archived=False).count(), 1)

        # update trigger with 2 groups
        post_data = dict(keywords=["start"], flow=flow.id, match_type="F", groups=[group1.pk, group2.pk])
        response = self.client.post(reverse("triggers.trigger_create_keyword"), data=post_data)
        self.assertEqual(Trigger.objects.filter(keywords=["start"]).count(), 3)
        self.assertEqual(Trigger.objects.filter(keywords=["start"], is_archived=False).count(), 2)

        # get error when groups overlap
        post_data = dict(keywords=["start"], flow=flow.id, match_type="F")
        post_data["groups"] = [group2.pk, group3.pk]
        response = self.client.post(reverse("triggers.trigger_create_keyword"), data=post_data)
        self.assertEqual(1, len(response.context["form"].errors))
        self.assertEqual(Trigger.objects.filter(keywords=["start"]).count(), 3)
        self.assertEqual(Trigger.objects.filter(keywords=["start"], is_archived=False).count(), 2)

        # allow new creation when groups do not overlap
        post_data = dict(keywords=["start"], flow=flow.id, match_type="F")
        post_data["groups"] = [group3.pk]
        self.client.post(reverse("triggers.trigger_create_keyword"), data=post_data)
        self.assertEqual(Trigger.objects.filter(keywords=["start"]).count(), 4)
        self.assertEqual(Trigger.objects.filter(keywords=["start"], is_archived=False).count(), 3)

        # create a few more archived triggers
        trigger3 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            keywords=["john"],
            match_type=Trigger.MATCH_ONLY_WORD,
            is_archived=True,
        )
        trigger4 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            keywords=["paul"],
            match_type=Trigger.MATCH_ONLY_WORD,
            is_archived=True,
        )
        trigger5 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            keywords=["george"],
            match_type=Trigger.MATCH_ONLY_WORD,
            is_archived=True,
        )
        trigger6 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            keywords=["ringo"],
            match_type=Trigger.MATCH_ONLY_WORD,
            is_archived=True,
        )
        # create one more active trigger
        trigger7 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            keywords=["simon"],
            match_type=Trigger.MATCH_ONLY_WORD,
            is_active=True,
        )

        # cannot bulk delete an active trigger
        self.client.post(archived_url, {"action": "delete", "objects": trigger7.id})

        response = self.client.get(archived_url)
        self.assertNotContains(response, trigger7.keywords[0])

        response = self.client.get(list_url)
        self.assertContains(response, trigger7.keywords[0])

        # cannot bulk delete a mix of active and archived triggers
        self.client.post(archived_url, {"action": "delete", "objects": [trigger3.id, trigger4.id, trigger7.id]})
        response = self.client.get(archived_url)
        self.assertContains(response, trigger3.keywords[0])
        self.assertContains(response, trigger4.keywords[0])
        self.assertContains(response, trigger5.keywords[0])
        self.assertContains(response, trigger6.keywords[0])
        self.assertNotContains(response, trigger7.keywords[0])

        response = self.client.get(list_url)
        self.assertContains(response, trigger7.keywords[0])

        # can bulk delete archived triggers
        self.client.post(archived_url, {"action": "delete", "objects": [trigger3.id, trigger4.id]})
        response = self.client.get(archived_url)
        self.assertNotContains(response, trigger3.keywords[0])
        self.assertNotContains(response, trigger4.keywords[0])
        self.assertContains(response, trigger5.keywords[0])
        self.assertContains(response, trigger6.keywords[0])

        # can bulk "delete all" archived triggers
        self.client.post(archived_url, {"action": "delete", "all": "true"})
        response = self.client.get(archived_url)
        self.assertNotContains(response, trigger3.keywords[0])
        self.assertNotContains(response, trigger4.keywords[0])
        self.assertNotContains(response, trigger5.keywords[0])
        self.assertNotContains(response, trigger6.keywords[0])
        # check that the active trigger is unaffected by the bulk "delete all"
        self.assertNotContains(response, trigger7.keywords[0])

        response = self.client.get(list_url)
        self.assertContains(response, trigger7.keywords[0])

    def test_folder(self):
        flow1 = self.create_flow("Flow 1")
        flow2 = self.create_flow("Flow 2")
        flow3 = self.create_flow("Flow 3", org=self.org2)

        trigger1 = Trigger.create(
            self.org, self.admin, Trigger.TYPE_KEYWORD, flow1, keywords=["test"], match_type=Trigger.MATCH_ONLY_WORD
        )
        trigger2 = Trigger.create(
            self.org, self.admin, Trigger.TYPE_KEYWORD, flow2, keywords=["abc"], match_type=Trigger.MATCH_ONLY_WORD
        )
        trigger3 = Trigger.create(self.org, self.admin, Trigger.TYPE_REFERRAL, flow1, referrer_id="234")
        trigger4 = Trigger.create(self.org, self.admin, Trigger.TYPE_REFERRAL, flow2, referrer_id="456")
        trigger5 = Trigger.create(self.org, self.admin, Trigger.TYPE_CATCH_ALL, flow1)
        Trigger.create(
            self.org2, self.admin, Trigger.TYPE_KEYWORD, flow3, keywords=["other"], match_type=Trigger.MATCH_ONLY_WORD
        )

        messages_url = reverse("triggers.trigger_folder", kwargs={"folder": "messages"})
        referral_url = reverse("triggers.trigger_folder", kwargs={"folder": "referral"})
        tickets_url = reverse("triggers.trigger_folder", kwargs={"folder": "tickets"})

        self.assertRequestDisallowed(messages_url, [None, self.agent])
        self.assertRequestDisallowed(referral_url, [None, self.agent])
        self.assertRequestDisallowed(tickets_url, [None, self.agent])

        response = self.assertListFetch(
            messages_url, [self.editor, self.admin], context_objects=[trigger2, trigger1, trigger5]
        )
        self.assertEqual("/trigger/messages", response.headers[TEMBA_MENU_SELECTION])
        self.assertEqual(("archive",), response.context["actions"])

        # can search by keywords
        self.assertListFetch(messages_url + "?search=TEST", [self.admin], context_objects=[trigger1])

        self.assertListFetch(referral_url, [self.admin], context_objects=[trigger4, trigger3])
        self.assertListFetch(tickets_url, [self.admin], context_objects=[])
