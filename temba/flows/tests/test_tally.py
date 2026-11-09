from django_valkey import get_valkey_connection

from django.db import connection

from temba.flows.models import FlowTally
from temba.orgs.models import TallyFlush
from temba.tests import TembaTest, cleanup


def field(flow, scope: str) -> str:
    return f"F{flow.id}|{scope}"


class FlowTallyTest(TembaTest):
    @cleanup(valkey=True)
    def test_get_totals(self):
        r = get_valkey_connection()
        flow1 = self.create_flow("Flow 1")
        flow2 = self.create_flow("Flow 2")

        flow1.tallies.create(scope="segment:a:b", count=2)
        flow1.tallies.create(scope="result:color:red", count=3)
        flow2.tallies.create(scope="segment:a:b", count=5)

        # org tallies with the same id aren't flow tallies
        r.hset("{tallies}:live", mapping={f"{flow1.id}|segment:a:b": 100, f"O{flow1.id}|segment:a:b": 100})

        self.assertEqual({"segment:a:b": 2}, FlowTally.get_totals(flow1, ["segment:a:b", "segment:a:c"]))
        self.assertEqual({}, FlowTally.get_totals(flow1, []))
        self.assertEqual({}, FlowTally.get_totals_by_flow([], ["segment:a:b"]))

        r.hset(
            "{tallies}:live",
            mapping={field(flow1, "segment:a:b"): 1, field(flow1, "segment:a:c"): 4, field(flow2, "segment:a:b"): 10},
        )
        r.hset("{tallies}:flushing", mapping={field(flow1, "result:color:red"): -3})
        r.hset("{tallies}:batch", mapping={field(flow1, "segment:a:b"): 20})
        r.set("{tallies}:batch_id", 8)
        TallyFlush.objects.create(name="tallies", last_batch=7)

        # batch 8 hasn't been committed so is included, and a total that's gone down to zero is omitted
        self.assertEqual(
            {"segment:a:b": 23, "segment:a:c": 4},
            FlowTally.get_totals(flow1, ["segment:a:b", "segment:a:c", "result:color:red", "segment:a:b"]),
        )
        self.assertEqual(
            {(flow1.id, "segment:a:b"): 23, (flow2.id, "segment:a:b"): 15},
            FlowTally.get_totals_by_flow([flow1, flow2, flow1], ["segment:a:b"]),
        )

        # batch 8 has been committed but not yet deleted, so is only counted in the rows
        TallyFlush.objects.filter(name="tallies").update(last_batch=8)
        flow1.tallies.filter(scope="segment:a:b").update(count=22)

        self.assertEqual({"segment:a:b": 23}, FlowTally.get_totals(flow1, ["segment:a:b"]))

    @cleanup(valkey=True)
    def test_get_prefix_totals(self):
        r = get_valkey_connection()
        flow1 = self.create_flow("Flow 1")
        flow2 = self.create_flow("Flow 2")

        flow1.tallies.create(scope="segment:a:b", count=2)
        flow1.tallies.create(scope="segment:b:c", count=3)
        flow1.tallies.create(scope="result:color:red", count=4)
        flow2.tallies.create(scope="segment:a:b", count=5)

        r.hset(
            "{tallies}:live",
            mapping={
                field(flow1, "segment:a:b"): 1,
                field(flow1, "segment:c:d"): 6,  # not flushed yet
                field(flow1, "segment:d:e"): 7,  # not flushed yet
                field(flow1, "segment:b:c"): -3,
            },
        )

        # buffered counts are added to flushed scopes, but scopes only in Valkey are only found if given
        self.assertEqual({"segment:a:b": 3}, FlowTally.get_prefix_totals(flow1, "segment:"))
        self.assertEqual(
            {"segment:a:b": 3, "segment:c:d": 6},
            FlowTally.get_prefix_totals(flow1, "segment:", ["segment:c:d", "segment:a:b"]),
        )
        self.assertEqual({"result:color:red": 4}, FlowTally.get_prefix_totals(flow1, "result:"))
        self.assertEqual({}, FlowTally.get_prefix_totals(flow1, "status:"))

        with self.assertRaises(AssertionError):
            FlowTally.get_prefix_totals(flow1, "segment:", ["result:color:red"])

    def test_upsert(self):
        # check the primary key can be the target of the upserts used for flushing
        flow = self.create_flow("Test")
        sql = """
        INSERT INTO flows_flowtally AS t (flow_id, scope, count, expires_on)
        SELECT %s, unnest(%s::text[]), unnest(%s::bigint[]), unnest(%s::date[])
        ON CONFLICT (flow_id, scope) DO UPDATE SET count = t.count + excluded.count
        """
        with connection.cursor() as cursor:
            cursor.execute(sql, (flow.id, ["segment:a:b", "result:color:red"], [2, 3], [None, None]))
            cursor.execute(sql, (flow.id, ["segment:a:b", "result:color:red"], [4, -1], [None, None]))

        self.assertEqual(6, flow.tallies.get(scope="segment:a:b").count)
        self.assertEqual(2, flow.tallies.get(scope="result:color:red").count)
