from datetime import timedelta

from django.utils import timezone

from temba.flows.models import FlowRevision
from temba.flows.tasks import trim_flow_revisions
from temba.tests import TembaTest


class FlowRevisionTest(TembaTest):
    def test_validate_legacy_definition(self):
        def validate(flow_def: dict, expected_error: str):
            with self.assertRaises(ValueError) as cm:
                FlowRevision.validate_legacy_definition(flow_def)
            self.assertEqual(expected_error, str(cm.exception))

        validate({"flow_type": "U", "nodes": []}, "unsupported flow type")
        validate(self.load_json("test_flows/legacy/invalid/not_fully_localized.json"), "non-localized flow definition")

        # base_language of null, but spec version 8
        validate(self.load_json("test_flows/legacy/invalid/no_base_language_v8.json"), "non-localized flow definition")

        # base_language of 'eng' but non localized actions
        validate(
            self.load_json("test_flows/legacy/invalid/non_localized_with_language.json"),
            "non-localized flow definition",
        )

        validate(
            self.load_json("test_flows/legacy/invalid/non_localized_ruleset.json"), "non-localized flow definition"
        )

    def test_trim_revisions(self):
        start = timezone.now()

        flow1 = self.create_flow("Flow 1")
        flow2 = self.create_flow("Flow 2")

        # a small flow stays untouched
        FlowRevision.objects.create(
            flow=flow2,
            definition=dict(),
            revision=99,
            created_on=timezone.now() - timedelta(days=7),
            created_by=self.admin,
        )

        # build flow1 well past the cap
        revision = FlowRevision.MAX_REVISIONS + 50
        created = timezone.now()
        for _ in range(FlowRevision.MAX_REVISIONS + 50):
            revision -= 1
            created = created - timedelta(minutes=1)
            FlowRevision.objects.create(
                flow=flow1, definition=dict(), revision=revision, created_by=self.admin, created_on=created
            )

        # +1 from the original revision created by create_flow
        self.assertEqual(FlowRevision.MAX_REVISIONS + 51, FlowRevision.objects.filter(flow=flow1).count())
        self.assertEqual(51, FlowRevision.trim(start))
        self.assertEqual(FlowRevision.MAX_REVISIONS, FlowRevision.objects.filter(flow=flow1).count())

        # the small flow is unchanged
        self.assertEqual(2, FlowRevision.objects.filter(flow=flow2).count())
        self.assertEqual(0, FlowRevision.trim_for_flow(flow2.id))
        self.assertEqual(2, FlowRevision.objects.filter(flow=flow2).count())

        # task is idempotent
        trim_flow_revisions()
        self.assertEqual(FlowRevision.MAX_REVISIONS, FlowRevision.objects.filter(flow=flow1).count())
        self.assertEqual(2, FlowRevision.objects.filter(flow=flow2).count())

        trim_flow_revisions()
        self.assertEqual(FlowRevision.MAX_REVISIONS, FlowRevision.objects.filter(flow=flow1).count())
        self.assertEqual(2, FlowRevision.objects.filter(flow=flow2).count())
