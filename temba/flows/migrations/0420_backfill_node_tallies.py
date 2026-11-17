import base64
from uuid import UUID

from django.db import connection, migrations
from django.db.models import Max

FLOW_BATCH_SIZE = 100

COUNTS_SQL = """
SELECT c.flow_id, c.scope, SUM(c.count)::bigint
  FROM flows_flowactivitycount c
  JOIN flows_flow f ON f.id = c.flow_id AND f.is_active
 WHERE c.flow_id > %(from_id)s AND c.flow_id <= %(to_id)s AND c.scope LIKE 'node:%%'
GROUP BY c.flow_id, c.scope"""

TALLIED_SQL = """
SELECT t.flow_id, t.scope
  FROM flows_flowtally t
  JOIN flows_flow f ON f.id = t.flow_id AND f.is_active
 WHERE t.flow_id > %(from_id)s AND t.flow_id <= %(to_id)s AND t.scope LIKE 'node:%%'"""

UPSERT_SQL = """
INSERT INTO flows_flowtally AS t (flow_id, scope, count, expires_on)
     SELECT u.flow_id, u.scope, u.count, NULL
       FROM unnest(%s::bigint[], %s::text[], %s::bigint[]) AS u(flow_id, scope, count)
   ORDER BY 1, 2
ON CONFLICT (flow_id, scope) DO UPDATE SET count = t.count + excluded.count"""

DELETE_ZERO_SQL = """
DELETE FROM flows_flowtally t
      USING unnest(%s::bigint[], %s::text[]) AS u(flow_id, scope)
      WHERE t.flow_id = u.flow_id AND t.scope = u.scope AND t.count = 0"""


def node_scope(node_uuid: str) -> str:  # pragma: no cover
    return "node:" + base64.urlsafe_b64encode(UUID(node_uuid).bytes).decode().rstrip("=")


def backfill_node_tallies(apps, schema_editor):  # pragma: no cover
    from temba.flows.models import FlowTally  # for its reads of totals buffered in Valkey

    Flow = apps.get_model("flows", "Flow")

    max_id = Flow.objects.aggregate(max_id=Max("id"))["max_id"] or 0
    num_written = 0

    for from_id in range(0, max_id, FLOW_BATCH_SIZE):
        params = {"from_id": from_id, "to_id": from_id + FLOW_BATCH_SIZE}
        counts_by_flow = {}

        with connection.cursor() as cursor:
            cursor.execute(COUNTS_SQL, params)
            for flow_id, scope, count in cursor.fetchall():
                counts_by_flow.setdefault(flow_id, {})[node_scope(scope.removeprefix("node:"))] = count

            # a node with a tally but no count, e.g. one which a run that was already there before mailroom tallied
            # runs has since left, needs bringing back to zero too
            cursor.execute(TALLIED_SQL, params)
            for flow_id, scope in cursor.fetchall():
                counts_by_flow.setdefault(flow_id, {}).setdefault(scope, 0)

        rows = ([], [], [])

        for flow_id, counts in counts_by_flow.items():
            # mailroom moves runs which were already at a node before it was upgraded off that node as they leave, so
            # a tally can be anything until it's made to match its count. Making it match rather than only raising it
            # means this can be re-run to repair drift for as long as the counts are still written.
            totals = FlowTally._get_totals([flow_id], list(counts.keys()))

            for scope, count in counts.items():
                diff = count - totals.get((flow_id, scope), 0)
                if diff != 0:
                    for col, val in zip(rows, (flow_id, scope, diff)):
                        col.append(val)

        if rows[0]:
            with connection.cursor() as cursor:
                # adding rather than setting means a flush of buffered amounts during the backfill isn't overwritten
                cursor.execute(UPSERT_SQL, rows)
                num_written += cursor.rowcount

                cursor.execute(DELETE_ZERO_SQL, rows[:2])

    if num_written:
        print(f"Wrote {num_written} node tallies")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_node_tallies(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("flows", "0419_compact_segment_tallies"),
    ]

    operations = [
        migrations.RunPython(backfill_node_tallies, migrations.RunPython.noop),
    ]
