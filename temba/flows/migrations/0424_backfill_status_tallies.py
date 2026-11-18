from django.db import connection, migrations
from django.db.models import Max

FLOW_BATCH_SIZE = 100

COUNTS_SQL = """
SELECT c.flow_id, c.scope, SUM(c.count)::bigint
  FROM flows_flowactivitycount c
  JOIN flows_flow f ON f.id = c.flow_id AND f.is_active
 WHERE c.flow_id > %(from_id)s AND c.flow_id <= %(to_id)s AND c.scope LIKE 'status:%%'
GROUP BY c.flow_id, c.scope"""

TALLIED_SQL = """
SELECT t.flow_id, t.scope
  FROM flows_flowtally t
  JOIN flows_flow f ON f.id = t.flow_id AND f.is_active
 WHERE t.flow_id > %(from_id)s AND t.flow_id <= %(to_id)s AND t.scope LIKE 'status:%%'"""

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


def backfill_status_tallies(apps, schema_editor):
    from temba.flows.models import FlowTally  # for its reads of totals buffered in Valkey

    Flow = apps.get_model("flows", "Flow")

    max_id = Flow.objects.aggregate(max_id=Max("id"))["max_id"] or 0
    num_written = 0

    for from_id in range(0, max_id, FLOW_BATCH_SIZE):
        params = {"from_id": from_id, "to_id": from_id + FLOW_BATCH_SIZE}
        counts_by_flow = {}

        with connection.cursor() as cursor:
            # status scopes are the same strings in both tables
            cursor.execute(COUNTS_SQL, params)
            for flow_id, scope, count in cursor.fetchall():
                counts_by_flow.setdefault(flow_id, {})[scope] = count

            # a status with a tally but no count needs bringing back to zero too
            cursor.execute(TALLIED_SQL, params)
            for flow_id, scope in cursor.fetchall():
                counts_by_flow.setdefault(flow_id, {}).setdefault(scope, 0)

        # runs which were already active or waiting before mailroom tallied statuses are taken off those statuses as
        # they exit, so a tally can be anything until it's made to match its count. Making it match rather than only
        # raising it means this can be re-run to repair drift for as long as the counts are still written. There are
        # few statuses, so reading the whole batch's totals at once costs little over reading each flow's own.
        scopes = list({s for counts in counts_by_flow.values() for s in counts})
        totals = FlowTally._get_totals(list(counts_by_flow.keys()), scopes)
        rows = ([], [], [])

        for flow_id, counts in counts_by_flow.items():
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
        print(f"Wrote {num_written} status tallies")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_status_tallies(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("flows", "0423_drop_flowlabel_is_active"),
    ]

    operations = [
        migrations.RunPython(backfill_status_tallies, migrations.RunPython.noop),
    ]
