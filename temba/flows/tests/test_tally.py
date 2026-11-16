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

    def test_segment_scopes(self):
        # vectors generated with Go's base64.RawURLEncoding so they match mailroom's encoding
        vectors = [
            (
                "42af6e19-53ef-4fd9-8232-f202a3ea022b",
                "1d4f25b2-c648-46cc-8116-be0ec6b6d34a",
                "segment:Qq9uGVPvT9mCMvICo-oCKx1PJbLGSEbMgRa-Dsa200o",
            ),
            (
                "2d7177e0-6bae-427f-9630-3823e2b8f1b2",
                "46681864-8389-4875-8b88-2f9fe241ea3f",
                "segment:LXF34GuuQn-WMDgj4rjxskZoGGSDiUh1i4gvn-JB6j8",
            ),
            (
                "00000000-0000-0000-0000-000000000000",
                "ffffffff-ffff-ffff-ffff-ffffffffffff",
                "segment:AAAAAAAAAAAAAAAAAAAAAP____________________8",
            ),
            (
                "fbfffbff-fbff-fbff-fbff-fbfffbfffbff",
                "3e3f3e3f-3e3f-3e3f-3e3f-3e3f3e3f3e3f",
                "segment:-__7__v_-__7__v_-__7_z4_Pj8-Pz4_Pj8-Pz4_Pj8",
            ),
        ]
        for exit_uuid, node_uuid, scope in vectors:
            self.assertEqual(scope, FlowTally.segment_scope(exit_uuid, node_uuid))
            self.assertEqual(f"{exit_uuid}:{node_uuid}", FlowTally.parse_segment_scope(scope))

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
