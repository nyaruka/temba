from datetime import date, timedelta

from django.db import connection, migrations
from django.db.models import Max

FLOW_BATCH_SIZE = 100

# must match mailroom's retention of daily msgsin tallies, which it counts from their day
MSGSIN_DATE_PREFIX = "msgsin:date:"
MSGSIN_DATE_RETENTION_DAYS = 365

COUNTS_SQL = """
SELECT c.flow_id, c.scope, SUM(c.count)
  FROM flows_flowactivitycount c
  JOIN flows_flow f ON f.id = c.flow_id AND f.is_active
 WHERE c.flow_id > %(from_id)s AND c.flow_id <= %(to_id)s
   AND (c.scope LIKE 'segment:%%' OR c.scope LIKE 'msgsin:hour:%%' OR c.scope LIKE 'msgsin:date:%%')
GROUP BY c.flow_id, c.scope
HAVING SUM(c.count) > 0"""

UPSERT_SQL = """
INSERT INTO flows_flowtally AS t (flow_id, scope, count, expires_on)
     SELECT * FROM unnest(%s::bigint[], %s::text[], %s::bigint[], %s::date[])
   ORDER BY 1, 2
ON CONFLICT (flow_id, scope) DO UPDATE SET count = t.count + excluded.count, expires_on = excluded.expires_on"""


def backfill_flow_tallies(apps, schema_editor):
    from temba.flows.models import FlowTally  # for its reads of totals buffered in Valkey

    Flow = apps.get_model("flows", "Flow")

    with connection.cursor() as cursor:
        cursor.execute("SELECT (NOW() AT TIME ZONE 'UTC')::date")
        today = cursor.fetchone()[0]

    max_id = Flow.objects.aggregate(max_id=Max("id"))["max_id"] or 0
    num_written = 0

    for from_id in range(0, max_id, FLOW_BATCH_SIZE):
        with connection.cursor() as cursor:
            cursor.execute(COUNTS_SQL, {"from_id": from_id, "to_id": from_id + FLOW_BATCH_SIZE})
            counts_by_flow = {}
            for flow_id, scope, count in cursor.fetchall():
                counts_by_flow.setdefault(flow_id, {})[scope] = count

        rows = ([], [], [], [])

        for flow_id, counts in counts_by_flow.items():
            # mailroom has been writing these tallies alongside the counts since it was upgraded, so what the tallies
            # are missing is whatever was counted before that. Mailroom also tallies some things that the counts never
            # did (e.g. incoming IVR messages) so a tally can be ahead of its count, which is left alone.
            totals = FlowTally._get_totals([flow_id], list(counts.keys()))

            for scope, count in counts.items():
                missing = count - totals.get((flow_id, scope), 0)
                if missing <= 0:
                    continue

                expires_on = None
                if scope.startswith(MSGSIN_DATE_PREFIX):
                    expires_on = date.fromisoformat(scope[len(MSGSIN_DATE_PREFIX) :]) + timedelta(
                        days=MSGSIN_DATE_RETENTION_DAYS
                    )
                    if expires_on < today:
                        continue

                for col, val in zip(rows, (flow_id, scope, missing, expires_on)):
                    col.append(val)

        if rows[0]:
            with connection.cursor() as cursor:
                # adding rather than setting means a flush of buffered amounts during the backfill isn't overwritten
                cursor.execute(UPSERT_SQL, rows)
                num_written += cursor.rowcount

    if num_written:
        print(f"Wrote {num_written} flow tallies")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_flow_tallies(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("flows", "0417_flowtally"),
    ]

    operations = [
        migrations.RunPython(backfill_flow_tallies, migrations.RunPython.noop),
    ]
