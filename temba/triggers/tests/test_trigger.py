from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.test import override_settings
from django.utils import timezone

from temba.channels.models import Channel
from temba.contacts.models import ContactGroup
from temba.flows.models import Flow
from temba.schedules.models import Schedule
from temba.tests import TembaTest
from temba.triggers.models import Trigger
from temba.triggers.types import KeywordTriggerType
from temba.triggers.views import Folder


class TriggerTest(TembaTest):
    def test_model(self):
        flow = self.create_flow("Test Flow")
        group1 = self.create_group("Testers", contacts=[])
        group2 = self.create_group("Developers", contacts=[])
        keyword1 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            keywords=["join"],
            match_type=Trigger.MATCH_ONLY_WORD,
            groups=[group1],
        )
        keyword2 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            keywords=["join"],
            match_type=Trigger.MATCH_ONLY_WORD,
            groups=[group1],
            exclude_groups=[group2],
        )
        catchall1 = Trigger.create(self.org, self.admin, Trigger.TYPE_CATCH_ALL, flow)
        catchall2 = Trigger.create(self.org, self.admin, Trigger.TYPE_CATCH_ALL, flow, channel=self.channel)
        schedule1 = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_SCHEDULE,
            flow,
            schedule=Schedule.create(self.org, timezone.now(), Schedule.REPEAT_DAILY),
        )

        self.assertEqual("Keyword[join] → Test Flow", keyword1.name)
        self.assertEqual(f'<Trigger: id={keyword1.id} type=K flow="Test Flow">', repr(keyword1))
        self.assertEqual(2, keyword1.priority)
        self.assertEqual(3, keyword2.priority)

        self.assertEqual("Catch All → Test Flow", catchall1.name)
        self.assertEqual(f'<Trigger: id={catchall1.id} type=C flow="Test Flow">', repr(catchall1))
        self.assertEqual(0, catchall1.priority)
        self.assertEqual(4, catchall2.priority)

        self.assertEqual("Schedule → Test Flow", schedule1.name)

        self.assertEqual(Folder.TICKETS, Folder.from_slug("tickets"))
        self.assertIsNone(Folder.from_slug("xx"))

        keyword1.archive(self.editor)
        schedule1.archive(self.editor)

        keyword1.refresh_from_db()
        schedule1.refresh_from_db()

        self.assertTrue(keyword1.is_archived)
        self.assertTrue(schedule1.is_archived)
        self.assertTrue(schedule1.schedule.is_paused)

        keyword1.restore(self.editor)
        schedule1.restore(self.editor)

        keyword1.refresh_from_db()
        schedule1.refresh_from_db()

        self.assertFalse(keyword1.is_archived)
        self.assertFalse(schedule1.is_archived)
        self.assertFalse(schedule1.schedule.is_paused)

    def test_archive_conflicts(self):
        flow = self.create_flow("Test")
        group1 = self.create_group("Group 1", contacts=[])
        group2 = self.create_group("Group 1", contacts=[])
        channel1 = self.create_channel("FB", "FB Channel 1", "12345")
        channel2 = self.create_channel("FB", "FB Channel 2", "23456")

        def create_trigger(trigger_type, **kwargs):
            return Trigger.create(self.org, self.admin, trigger_type, flow, **kwargs)

        def assert_conflict_resolution(archived: list, unchanged: list):
            for trigger in archived:
                trigger.refresh_from_db()
                self.assertTrue(trigger.is_archived)

            for trigger in unchanged:
                trigger.refresh_from_db()
                self.assertFalse(trigger.is_archived)

            # keyword triggers conflict if keyword and groups match
            trigger1 = create_trigger(Trigger.TYPE_KEYWORD, keywords=["join"], match_type="O")
            trigger2 = create_trigger(Trigger.TYPE_KEYWORD, keywords=["join"], match_type="S")
            trigger3 = create_trigger(Trigger.TYPE_KEYWORD, keywords=["start"])
            create_trigger(Trigger.TYPE_KEYWORD, keywords=["join"])

            assert_conflict_resolution(archived=[trigger1, trigger2], unchanged=[trigger3])

            trigger1 = create_trigger(Trigger.TYPE_KEYWORD, groups=(group1,), keywords=["join"])
            trigger2 = create_trigger(Trigger.TYPE_KEYWORD, groups=(group2,), keywords=["join"])
            create_trigger(Trigger.TYPE_KEYWORD, groups=(group1,), keywords=["join"])

            assert_conflict_resolution(archived=[trigger1], unchanged=[trigger2])

            # incoming call triggers conflict if groups match
            trigger1 = create_trigger(Trigger.TYPE_INBOUND_CALL, groups=(group1,))
            trigger2 = create_trigger(Trigger.TYPE_INBOUND_CALL, groups=(group2,))
            create_trigger(Trigger.TYPE_INBOUND_CALL, groups=(group1,))

            assert_conflict_resolution(archived=[trigger1], unchanged=[trigger2])

            # missed call triggers always conflict
            trigger1 = create_trigger(Trigger.TYPE_MISSED_CALL)
            trigger2 = create_trigger(Trigger.TYPE_MISSED_CALL)

            assert_conflict_resolution(archived=[trigger1], unchanged=[trigger2])

            # new conversation triggers conflict if channels match
            trigger1 = create_trigger(Trigger.TYPE_REFERRAL, channel=channel1)
            trigger2 = create_trigger(Trigger.TYPE_REFERRAL, channel=channel2)
            create_trigger(Trigger.TYPE_REFERRAL, channel=channel1)

            assert_conflict_resolution(archived=[trigger1], unchanged=[trigger2])

            # referral triggers conflict if referral ids match
            trigger1 = create_trigger(Trigger.TYPE_REFERRAL, referrer_id="12345")
            trigger2 = create_trigger(Trigger.TYPE_REFERRAL, referrer_id="23456")
            create_trigger(Trigger.TYPE_REFERRAL, referrer_id="12345")

            assert_conflict_resolution(archived=[trigger1], unchanged=[trigger2])

    def _export_trigger(self, trigger: Trigger) -> dict:
        components = self.org.resolve_dependencies([trigger.flow], [], include_triggers=True)
        return self.org.export_definitions("http://rapidpro.io", components)

    def _import_trigger(self, trigger_def: dict, version=13):
        self.org.import_app(
            {
                "version": str(version),
                "site": "https://app.rapidpro.com",
                "flows": [],
                "triggers": [trigger_def],
            },
            self.admin,
        )

    def assert_import_error(self, trigger_def: dict, error: str):
        with self.assertRaisesMessage(ValidationError, expected_message=error):
            self._import_trigger(trigger_def)

    def assert_export_import(self, trigger: Trigger, expected_def: dict):
        # export trigger and check def
        export_def = self._export_trigger(trigger)
        self.assertEqual(expected_def, export_def["triggers"][0])

        original_groups = set(trigger.groups.all())
        original_exclude_groups = set(trigger.exclude_groups.all())
        original_contacts = set(trigger.contacts.all())

        # do import to clean workspace
        Trigger.objects.all().delete()
        self.org.import_app(export_def, self.admin)
        # should have a single identical trigger
        imported = Trigger.objects.get(
            org=trigger.org,
            trigger_type=trigger.trigger_type,
            flow=trigger.flow,
            keywords=trigger.keywords,
            match_type=trigger.match_type,
            channel=trigger.channel,
            referrer_id=trigger.referrer_id,
        )

        self.assertEqual(original_groups, set(imported.groups.all()))
        self.assertEqual(original_exclude_groups, set(imported.exclude_groups.all()))
        self.assertEqual(original_contacts, set(imported.contacts.all()))

        # which can be exported and should have the same definition
        export_def = self._export_trigger(imported)
        self.assertEqual(expected_def, export_def["triggers"][0])

        # and re-importing that shouldn't create a new trigger
        self.org.import_app(export_def, self.admin)
        self.assertEqual(1, Trigger.objects.count())

    @patch("temba.channels.types.facebook.type.FacebookType.deactivate_trigger")
    @patch("temba.channels.types.facebook.type.FacebookType.activate_trigger")
    def test_export_import(self, mock_activate_trigger, mock_deactivate_trigger):
        mock_activate_trigger.return_value = None
        mock_deactivate_trigger.return_value = None

        # tweak our current channel to be facebook so we can create a channel-based trigger
        Channel.objects.filter(id=self.channel.id).update(
            channel_type="FBA", config={Channel.CONFIG_AUTH_TOKEN: "1234"}
        )
        flow = self.create_flow("Test")

        doctors = self.create_group("Doctors", contacts=[])
        farmers = self.create_group("Farmers", contacts=[])
        testers = self.create_group("Testers", contacts=[])

        # create a trigger on this flow for the new conversation actions but only on some groups
        trigger = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_NEW_CONVERSATION,
            flow,
            groups=[doctors, farmers],
            exclude_groups=[testers],
            channel=self.channel,
        )

        export = self._export_trigger(trigger)

        # remove our trigger
        Trigger.objects.all().delete()

        # and reimport them.. trigger should be recreated
        self.org.import_app(export, self.admin)

        trigger = Trigger.objects.get()
        self.assertEqual(Trigger.TYPE_NEW_CONVERSATION, trigger.trigger_type)
        self.assertEqual(flow, trigger.flow)
        self.assertEqual(self.channel, trigger.channel)
        self.assertEqual({doctors, farmers}, set(trigger.groups.all()))
        self.assertEqual({testers}, set(trigger.exclude_groups.all()))

        # reimporting again over the top of that shouldn't change the trigger or create any others
        self.org.import_app(export, self.admin)

        trigger = Trigger.objects.get()
        self.assertEqual(Trigger.TYPE_NEW_CONVERSATION, trigger.trigger_type)
        self.assertEqual(flow, trigger.flow)
        self.assertEqual(self.channel, trigger.channel)
        self.assertEqual({doctors, farmers}, set(trigger.groups.all()))
        self.assertEqual({testers}, set(trigger.exclude_groups.all()))

        trigger.archive(self.admin)

        # reimporting again over the top of an archived exact match should restore it
        self.org.import_app(export, self.admin)

        trigger = Trigger.objects.get()
        self.assertFalse(trigger.is_archived)

        trigger.flow = self.create_flow("Another Flow")
        trigger.save(update_fields=("flow",))

        # reimporting again now that our trigger points to a different flow, should archive it and create a new one
        self.org.import_app(export, self.admin)

        trigger.refresh_from_db()
        self.assertTrue(trigger.is_archived)

        trigger2 = Trigger.objects.exclude(id=trigger.id).get()
        self.assertEqual(Trigger.TYPE_NEW_CONVERSATION, trigger2.trigger_type)
        self.assertEqual(flow, trigger2.flow)

        # also if a trigger differs by exclusion groups it will be replaced
        trigger2.exclude_groups.clear()

        self.org.import_app(export, self.admin)

        trigger2.refresh_from_db()
        self.assertTrue(trigger.is_archived)

        trigger3 = Trigger.objects.exclude(id__in=(trigger.id, trigger2.id)).get()
        self.assertEqual(Trigger.TYPE_NEW_CONVERSATION, trigger3.trigger_type)
        self.assertEqual({testers}, set(trigger3.exclude_groups.all()))

        # we ignore scheduled triggers in imports as they're missing their schedules
        self._import_trigger(
            {
                "trigger_type": "S",
                "flow": {"uuid": "8907acb0-4f32-41c2-887d-b5d2ffcc2da9", "name": "Reminder"},
                "groups": [],
            }
        )

        self.assertEqual(3, Trigger.objects.count())  # no new triggers imported

        # we also ignore opt-in and opt-out triggers in imports as those types have been removed
        self._import_trigger({"trigger_type": "I", "flow": {"uuid": str(flow.uuid), "name": "Test"}, "groups": []})
        self._import_trigger({"trigger_type": "O", "flow": {"uuid": str(flow.uuid), "name": "Test"}, "groups": []})

        self.assertEqual(3, Trigger.objects.count())  # no new triggers imported

    def test_import_invalid(self):
        flow = self.create_flow("Test")
        flow_ref = {"uuid": str(flow.uuid), "name": "Test Flow"}

        # invalid type
        self.assert_import_error(
            {"trigger_type": "Z", "flow": flow_ref, "groups": []},
            "Z is not a valid trigger type",
        )

        # no flow
        self.assert_import_error({"trigger_type": "M", "keywords": ["test"], "groups": []}, "Field 'flow' is required.")

        # keyword with no keywords
        self.assert_import_error(
            {
                "trigger_type": "K",
                "flow": flow_ref,
                "groups": [],
            },
            "Field 'keywords' is required.",
        )
        self.assert_import_error(
            {
                "trigger_type": "K",
                "flow": flow_ref,
                "groups": [],
                "keywords": [],
            },
            "Field 'keywords' is required.",
        )

        # keyword with invalid keyword
        self.assert_import_error(
            {"trigger_type": "K", "flow": flow_ref, "groups": [], "keywords": ["12345678901234567"]},
            "12345678901234567 is not a valid keyword",
        )

        # fields which don't apply to the trigger type are ignored
        self._import_trigger({"trigger_type": "C", "keywords": ["this is ignored"], "flow": flow_ref, "groups": []})

        trigger = Trigger.objects.get(trigger_type="C")
        self.assertIsNone(trigger.keywords)

        # triggers with flows of types not allowed for the trigger type are skipped
        self._import_trigger({"trigger_type": "T", "flow": flow_ref, "groups": [{"uuid": "", "name": "Unused"}]})
        self.assertFalse(Trigger.objects.filter(trigger_type="T").exists())
        self.assertFalse(ContactGroup.objects.filter(org=self.org, name="Unused").exists())

        background = self.create_flow("Background", flow_type=Flow.TYPE_BACKGROUND)
        background_ref = {"uuid": str(background.uuid), "name": "Background"}

        self._import_trigger({"trigger_type": "K", "flow": background_ref, "groups": [], "keywords": ["bg"]})
        self.assertFalse(Trigger.objects.filter(trigger_type="K").exists())

        self._import_trigger({"trigger_type": "T", "flow": background_ref, "groups": []})
        self.assertEqual(background, Trigger.objects.get(trigger_type="T").flow)

    @override_settings(ORG_LIMIT_DEFAULTS={"triggers": 2})
    def test_org_limit(self):
        flow = self.create_flow("Test")

        self.assertFalse(Trigger.is_limit_reached(self.org))

        trigger1 = Trigger.create(self.org, self.admin, Trigger.TYPE_CATCH_ALL, flow)
        Trigger.create(self.org, self.admin, Trigger.TYPE_INBOUND_CALL, flow)

        self.assertTrue(Trigger.is_limit_reached(self.org))

        # limits are per org
        self.assertFalse(Trigger.is_limit_reached(self.org2))

        # archived triggers don't fire so they don't count
        trigger1.archive(self.admin)
        self.assertFalse(Trigger.is_limit_reached(self.org))

        # and neither do released ones
        trigger1.restore(self.admin)
        self.assertTrue(Trigger.is_limit_reached(self.org))

        trigger1.release(self.admin)
        self.assertFalse(Trigger.is_limit_reached(self.org))

    @override_settings(ORG_LIMIT_DEFAULTS={"triggers": 1})
    def test_restore_limit(self):
        flow = self.create_flow("Test")

        trigger1 = Trigger.create(self.org, self.admin, Trigger.TYPE_CATCH_ALL, flow, is_archived=True)
        trigger2 = Trigger.create(self.org, self.admin, Trigger.TYPE_INBOUND_CALL, flow, is_archived=True)

        self.assertFalse(Trigger.is_limit_reached(self.org))

        # restoring both would exceed the limit, so we restore what fits and error on the rest
        with self.assertRaises(ValidationError):
            Trigger.apply_action_restore(self.admin, self.org.triggers.filter(id__in=[trigger1.id, trigger2.id]))

        # exactly one was restored, the other was blocked by the limit
        self.assertEqual(1, self.org.triggers.filter(is_archived=False).count())
        self.assertEqual(1, self.org.triggers.filter(is_archived=True).count())
        self.assertTrue(Trigger.is_limit_reached(self.org))

    @override_settings(ORG_LIMIT_DEFAULTS={"triggers": 1})
    def test_import_limit(self):
        flow = self.create_flow("Test")
        flow_ref = {"uuid": str(flow.uuid), "name": "Test"}

        def unarchived_count():
            return Trigger.objects.filter(org=self.org, is_active=True, is_archived=False).count()

        self._import_trigger({"trigger_type": "C", "flow": flow_ref, "groups": []})
        catchall = Trigger.objects.get(trigger_type="C")
        self.assertEqual(1, unarchived_count())

        # at the limit, so a new trigger isn't created
        self._import_trigger({"trigger_type": "V", "flow": flow_ref, "groups": []})
        self.assertEqual(1, unarchived_count())
        self.assertFalse(Trigger.objects.filter(trigger_type="V").exists())

        # but an import which matches an existing trigger is still allowed
        self._import_trigger({"trigger_type": "C", "flow": flow_ref, "groups": []})
        self.assertEqual([catchall], list(Trigger.objects.filter(trigger_type="C")))

        # archiving frees up room again
        catchall.archive(self.admin)
        self._import_trigger({"trigger_type": "V", "flow": flow_ref, "groups": []})
        self.assertEqual(1, unarchived_count())

        # and a matching import can restore an archived trigger even tho that puts us over the limit
        self._import_trigger({"trigger_type": "C", "flow": flow_ref, "groups": []})
        catchall.refresh_from_db()
        self.assertFalse(catchall.is_archived)
        self.assertEqual(2, unarchived_count())

    def test_export_import_keyword(self):
        flow = self.create_flow("Test")
        doctors = self.create_group("Doctors", contacts=[])
        farmers = self.create_group("Farmers", contacts=[])
        testers = self.create_group("Testers", contacts=[])
        trigger = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_KEYWORD,
            flow,
            channel=self.channel,
            groups=[doctors, farmers],
            exclude_groups=[testers],
            keywords=["join"],
            match_type=Trigger.MATCH_FIRST_WORD,
        )

        self.assert_export_import(
            trigger,
            {
                "trigger_type": "K",
                "flow": {"uuid": str(flow.uuid), "name": "Test"},
                "channel": {"uuid": str(self.channel.uuid), "name": "Test Channel"},
                "groups": [
                    {"uuid": str(doctors.uuid), "name": "Doctors"},
                    {"uuid": str(farmers.uuid), "name": "Farmers"},
                ],
                "exclude_groups": [{"uuid": str(testers.uuid), "name": "Testers"}],
                "keywords": ["join"],
                "match_type": "F",
            },
        )

        # single keyword field supported
        self._import_trigger(
            {
                "trigger_type": "K",
                "flow": {"uuid": str(flow.uuid), "name": "Test"},
                "keyword": "test",
                "groups": [],
            }
        )
        self.assertEqual(1, Trigger.objects.filter(keywords=["test"]).count())

        # channel as just UUID supported
        self._import_trigger(
            {
                "trigger_type": "K",
                "flow": {"uuid": str(flow.uuid), "name": "Test"},
                "channel": str(self.channel.uuid),
                "keywords": ["test"],
                "groups": [],
            }
        )
        self.assertEqual(1, Trigger.objects.filter(keywords=["test"], channel=self.channel).count())

    def test_export_import_inbound_call(self):
        flow = self.create_flow("Test")
        trigger = Trigger.create(self.org, self.admin, Trigger.TYPE_INBOUND_CALL, flow)

        self.assert_export_import(
            trigger,
            {
                "trigger_type": "V",
                "flow": {"uuid": str(flow.uuid), "name": "Test"},
                "channel": None,
                "groups": [],
                "exclude_groups": [],
            },
        )

    def test_export_import_inbound_call_with_channel(self):
        flow = self.create_flow("Test")
        trigger = Trigger.create(self.org, self.admin, Trigger.TYPE_INBOUND_CALL, flow, channel=self.channel)

        self.assert_export_import(
            trigger,
            {
                "trigger_type": "V",
                "flow": {"uuid": str(flow.uuid), "name": "Test"},
                "channel": {"uuid": str(self.channel.uuid), "name": "Test Channel"},
                "groups": [],
                "exclude_groups": [],
            },
        )

    def test_export_import_missed_call(self):
        flow = self.create_flow("Test")
        trigger = Trigger.create(self.org, self.admin, Trigger.TYPE_MISSED_CALL, flow)

        self.assert_export_import(
            trigger,
            {
                "trigger_type": "M",
                "flow": {"uuid": str(flow.uuid), "name": "Test"},
                "groups": [],
                "exclude_groups": [],
            },
        )

    @patch("temba.channels.types.facebook_legacy.FacebookLegacyType.activate_trigger")
    def test_export_import_new_conversation(self, mock_activate_trigger):
        flow = self.create_flow("Test")
        channel = self.create_channel("FB", "Facebook", "1234")
        trigger = Trigger.create(self.org, self.admin, Trigger.TYPE_NEW_CONVERSATION, flow, channel=channel)

        self.assert_export_import(
            trigger,
            {
                "trigger_type": "N",
                "flow": {"uuid": str(flow.uuid), "name": "Test"},
                "channel": {"uuid": str(channel.uuid), "name": "Facebook"},
                "groups": [],
                "exclude_groups": [],
            },
        )

    def test_export_import_referral(self):
        flow = self.create_flow("Test")
        channel = self.create_channel("FB", "Facebook", "1234")
        trigger = Trigger.create(self.org, self.admin, Trigger.TYPE_REFERRAL, flow, channel=channel)

        self.assert_export_import(
            trigger,
            {
                "trigger_type": "R",
                "flow": {"uuid": str(flow.uuid), "name": "Test"},
                "channel": {"uuid": str(channel.uuid), "name": "Facebook"},
                "groups": [],
                "exclude_groups": [],
            },
        )

    def test_is_valid_keyword(self):
        self.assertFalse(KeywordTriggerType.is_valid_keyword(""))
        self.assertFalse(KeywordTriggerType.is_valid_keyword(" x "))
        self.assertFalse(KeywordTriggerType.is_valid_keyword("a b"))
        self.assertFalse(KeywordTriggerType.is_valid_keyword("thisistoolongokplease"))
        self.assertFalse(KeywordTriggerType.is_valid_keyword("🎺🦆"))
        self.assertFalse(KeywordTriggerType.is_valid_keyword("👋👋"))
        self.assertFalse(KeywordTriggerType.is_valid_keyword("👋🏾"))  # is actually 👋 + 🏾

        self.assertTrue(KeywordTriggerType.is_valid_keyword("a"))
        self.assertTrue(KeywordTriggerType.is_valid_keyword("7"))
        self.assertTrue(KeywordTriggerType.is_valid_keyword("heyjoinnowplease"))
        self.assertTrue(KeywordTriggerType.is_valid_keyword("١٠٠"))
        self.assertTrue(KeywordTriggerType.is_valid_keyword("मिलाए"))
        self.assertTrue(KeywordTriggerType.is_valid_keyword("👋"))

    @patch("temba.channels.types.facebook_legacy.FacebookLegacyType.deactivate_trigger")
    def test_release(self, mock_deactivate_trigger):
        channel = self.create_channel("FB", "Facebook", "234567")
        flow = self.create_flow("Test")
        group = self.create_group("Trigger Group", [])
        trigger = Trigger.create(
            self.org,
            self.admin,
            Trigger.TYPE_SCHEDULE,
            flow,
            channel=channel,
            groups=[group],
            schedule=Schedule.create(self.org, timezone.now(), Schedule.REPEAT_MONTHLY),
        )

        trigger.release(self.admin)

        trigger.refresh_from_db()
        self.assertFalse(trigger.is_active)
        self.assertIsNone(trigger.schedule)

        self.assertEqual(0, Schedule.objects.count())

        # flow, channel and group are unaffected
        flow.refresh_from_db()
        self.assertTrue(flow.is_active)
        self.assertFalse(flow.is_archived)

        group.refresh_from_db()
        self.assertTrue(group.is_active)

        channel.refresh_from_db()
        self.assertTrue(channel.is_active)

        # now do real delete
        trigger.delete()

        self.assertEqual(Trigger.objects.count(), 0)
        self.assertEqual(Schedule.objects.count(), 0)
        self.assertEqual(ContactGroup.objects.filter(is_system=False).count(), 1)
        self.assertEqual(Flow.objects.count(), 1)
