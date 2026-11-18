from unittest.mock import ANY, patch

from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from temba.flows.models import FlowActivityCount, FlowRun
from temba.flows.tasks import squash_flow_counts
from temba.tests import TembaTest
from temba.utils.models.counts import get_merge_squashed_sql
from temba.utils.uuid import uuid4


class FlowActivityCountTest(TembaTest):
    def test_no_trigger_counts(self):
        flow = self.create_flow("Test 1")
        contact = self.create_contact("Bob", phone="+1234567890")

        def create_run(status, node_uuid):
            return FlowRun.objects.create(
                uuid=uuid4(),
                org=self.org,
                flow=flow,
                contact=contact,
                status=status,
                session_uuid="082cb7a8-a8fc-468d-b0a4-06f5a5179e2b",
                created_on=timezone.now(),
                modified_on=timezone.now(),
                exited_on=timezone.now() if status not in ("A", "W") else None,
                current_node_uuid=node_uuid,
            )

        run1 = create_run(FlowRun.STATUS_ACTIVE, "ebb534e1-e2e0-40e9-8652-d195e87d832b")
        create_run(FlowRun.STATUS_WAITING, "ebb534e1-e2e0-40e9-8652-d195e87d832b")
        run3 = create_run(FlowRun.STATUS_WAITING, "bbb71aab-e026-442e-9971-6bc4f48941fb")
        create_run(FlowRun.STATUS_INTERRUPTED, "bbb71aab-e026-442e-9971-6bc4f48941fb")

        run1.status = FlowRun.STATUS_EXPIRED
        run1.exited_on = timezone.now()
        run1.save(update_fields=("status", "exited_on"))

        run3.current_node_uuid = "85b0c928-4bd9-4a2e-84b2-164802c32486"
        run3.save(update_fields=("current_node_uuid",))

        FlowRun.objects.all().delete()

        # runs by status and at each node are counted by flow tallies which mailroom writes
        self.assertFalse(FlowActivityCount.objects.exists())

    def test_squashing(self):
        def squashed(flow) -> dict:
            self.assertEqual(0, flow.counts.filter(is_squashed=False).count())
            return {c.scope: (c.id, c.count) for c in flow.counts.filter(is_squashed=True)}

        flow1 = self.create_flow("Test 1")
        flow1.counts.create(scope="foo:1", count=1)
        flow1.counts.create(scope="foo:1", count=2)
        flow1.counts.create(scope="foo:2", count=4)
        flow1.counts.create(scope="foo:3", count=-6)  # negative counts supported
        flow1.counts.create(scope="foo:3", count=-1)

        flow2 = self.create_flow("Test 2")
        flow2.counts.create(scope="foo:1", count=7)
        flow2.counts.create(scope="foo:1", count=3)
        flow2.counts.create(scope="foo:2", count=8)  # unsquashed that sum to zero
        flow2.counts.create(scope="foo:2", count=-8)
        flow2.counts.create(scope="foo:3", count=5)

        self.assertEqual(0, flow1.counts.filter(scope="foo:4").sum())  # zero if no such scope exists

        self.assertEqual(6, FlowActivityCount.squash())

        # each set now has a single squashed row, unless it sums to zero
        flow1_rows = squashed(flow1)
        flow2_rows = squashed(flow2)
        self.assertEqual({"foo:1": 3, "foo:2": 4, "foo:3": -7}, {k: v[1] for k, v in flow1_rows.items()})
        self.assertEqual({"foo:1": 10, "foo:3": 5}, {k: v[1] for k, v in flow2_rows.items()})

        # nothing to squash
        self.assertEqual(0, FlowActivityCount.squash())
        self.assertEqual(flow1_rows, squashed(flow1))

        flow1.counts.create(scope="foo:1", count=-3)  # squashed total goes to zero
        flow1.counts.create(scope="foo:2", count=-5)  # squashed total goes negative
        flow1.counts.create(scope="foo:3", count=3)
        flow1.counts.create(scope="foo:3", count=-3)  # unsquashed sum to zero
        flow1.counts.create(scope="foo:4", count=2)  # new set
        flow2.counts.create(scope="foo:2", count=6)  # set which previously squashed to zero

        squash_flow_counts()

        # existing squashed rows are updated in place, or deleted if they reach zero
        self.assertEqual(
            {"foo:2": (flow1_rows["foo:2"][0], -1), "foo:3": flow1_rows["foo:3"], "foo:4": (ANY, 2)},
            squashed(flow1),
        )
        self.assertEqual(
            {"foo:1": flow2_rows["foo:1"], "foo:2": (ANY, 6), "foo:3": flow2_rows["foo:3"]}, squashed(flow2)
        )
        self.assertEqual({"foo:2": -1, "foo:3": -7, "foo:4": 2}, flow1.counts.scope_totals())

        # a set whose squashed row was deleted gets a new one
        flow1.counts.create(scope="foo:1", count=4)

        squash_flow_counts()

        self.assertEqual(
            {"foo:1": 4, "foo:2": -1, "foo:3": -7, "foo:4": 2}, {k: v[1] for k, v in squashed(flow1).items()}
        )

        # squashed rows must be unique per set
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                flow1.counts.create(scope="foo:1", count=1, is_squashed=True)

        # sets are squashed up to a maximum number per call
        for i in range(5):
            flow2.counts.create(scope=f"bar:{i}", count=i + 1)
            flow2.counts.create(scope=f"bar:{i}", count=1)

        with patch.object(FlowActivityCount, "squash_max_distinct", 3):
            self.assertEqual(3, FlowActivityCount.squash())
            self.assertEqual(2, FlowActivityCount.squash())
            self.assertEqual(0, FlowActivityCount.squash())

        self.assertEqual(
            {"bar:0": 2, "bar:1": 3, "bar:2": 4, "bar:3": 5, "bar:4": 6},
            {k: v[1] for k, v in squashed(flow2).items() if k.startswith("bar:")},
        )

        # squashing a set that matches no rows doesn't insert anything
        with connection.cursor() as cursor:
            cursor.execute(*FlowActivityCount.get_squash_query({"flow_id": flow1.id, "scope": "foo:9"}))

        self.assertFalse(flow1.counts.filter(scope="foo:9").exists())

    def test_merge_squashed(self):
        flow1 = self.create_flow("Test 1")
        flow2 = self.create_flow("Test 2")

        with connection.cursor() as cursor:
            # duplicate squashed rows predate the unique index
            cursor.execute("DROP INDEX flowactivitycount_squashed")

            flow1.counts.create(scope="foo:1", count=3, is_squashed=True)
            flow1.counts.create(scope="foo:1", count=-1, is_squashed=True)
            flow1.counts.create(scope="foo:1", count=4, is_squashed=True)
            flow1.counts.create(scope="foo:1", count=2)  # unsquashed rows are left alone
            flow1.counts.create(scope="foo:2", count=5, is_squashed=True)
            flow1.counts.create(scope="foo:2", count=-5, is_squashed=True)
            foo3 = flow1.counts.create(scope="foo:3", count=6, is_squashed=True)
            flow2.counts.create(scope="foo:1", count=7, is_squashed=True)
            flow2.counts.create(scope="foo:1", count=1, is_squashed=True)

            cursor.execute(get_merge_squashed_sql("flows_flowactivitycount", ("flow_id", "scope")))

        self.assertEqual(
            [("foo:1", 2, False), ("foo:1", 6, True), ("foo:3", 6, True)],  # foo:2 merged to zero so dropped
            list(flow1.counts.order_by("scope", "is_squashed").values_list("scope", "count", "is_squashed")),
        )
        self.assertEqual([("foo:1", 8, True)], list(flow2.counts.values_list("scope", "count", "is_squashed")))
        self.assertTrue(flow1.counts.filter(id=foo3.id).exists())  # sets without duplicates are untouched
