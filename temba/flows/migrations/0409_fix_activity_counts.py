from django.db import connection as default_connection, migrations

# runs could previously be deleted (e.g. by contact deletion) whilst still active or waiting, without their status and
# node counts being decremented. Each statement compares counts to actual runs and inserts corrective count rows.
#
# Each statement is self-consistent because it sees a single snapshot of both tables - so a run that changes state
# whilst it runs is either counted and corrected for, or seen by neither side. That holds as long as writers update a
# run and write its count delta in the same transaction, which is true of the triggers added in 0407 and of the flow
# engine's own writes.
#
# Flows are processed in batches rather than all at once so that no single statement runs long enough to hold back
# vacuuming across the database, and so an interrupted run can be resumed rather than rolled back. The batches rely
# on the temporary index added in 0408.

BATCH_SIZE = 100

SQL_FIX_STATUS_COUNTS = """
WITH counted AS (
    SELECT flow_id, scope, sum(count) AS total
    FROM flows_flowactivitycount
    WHERE flow_id = ANY(%(flow_ids)s) AND scope IN ('status:A', 'status:W')
    GROUP BY flow_id, scope
),
actual AS (
    SELECT flow_id, 'status:' || status AS scope, count(*) AS total
    FROM flows_flowrun
    WHERE flow_id = ANY(%(flow_ids)s) AND status IN ('A', 'W')
    GROUP BY flow_id, status
)
INSERT INTO flows_flowactivitycount(flow_id, scope, count, is_squashed)
SELECT COALESCE(c.flow_id, a.flow_id), COALESCE(c.scope, a.scope), COALESCE(a.total, 0) - COALESCE(c.total, 0), FALSE
FROM counted c
FULL JOIN actual a ON a.flow_id = c.flow_id AND a.scope = c.scope
WHERE COALESCE(c.total, 0) != COALESCE(a.total, 0)
"""

# note the doubled %% in the LIKE pattern - these statements are passed parameters, so a literal % has to be escaped
SQL_FIX_NODE_COUNTS = """
WITH counted AS (
    SELECT flow_id, scope, sum(count) AS total
    FROM flows_flowactivitycount
    WHERE flow_id = ANY(%(flow_ids)s) AND scope LIKE 'node:%%'
    GROUP BY flow_id, scope
),
actual AS (
    SELECT flow_id, 'node:' || current_node_uuid::text AS scope, count(*) AS total
    FROM flows_flowrun
    WHERE flow_id = ANY(%(flow_ids)s) AND status IN ('A', 'W') AND current_node_uuid IS NOT NULL
    GROUP BY flow_id, current_node_uuid
)
INSERT INTO flows_flowactivitycount(flow_id, scope, count, is_squashed)
SELECT COALESCE(c.flow_id, a.flow_id), COALESCE(c.scope, a.scope), COALESCE(a.total, 0) - COALESCE(c.total, 0), FALSE
FROM counted c
FULL JOIN actual a ON a.flow_id = c.flow_id AND a.scope = c.scope
WHERE COALESCE(c.total, 0) != COALESCE(a.total, 0)
"""


def fix_activity_counts(apps, schema_editor):  # pragma: no cover
    Flow = apps.get_model("flows", "Flow")

    # schema_editor is None when this is run out of band via apply_manual
    conn = schema_editor.connection if schema_editor else default_connection

    flow_ids_qs = Flow.objects.values_list("id", flat=True).order_by("id")

    last_flow_id = 0
    num_flows = 0
    num_status_rows = 0
    num_node_rows = 0

    while True:
        # page the ids rather than iterating a server side cursor, which would be held open across our writes
        flow_ids = list(flow_ids_qs.filter(id__gt=last_flow_id)[:BATCH_SIZE])
        if not flow_ids:
            break

        with conn.cursor() as cursor:
            cursor.execute(SQL_FIX_STATUS_COUNTS, {"flow_ids": flow_ids})
            num_status_rows += cursor.rowcount

            cursor.execute(SQL_FIX_NODE_COUNTS, {"flow_ids": flow_ids})
            num_node_rows += cursor.rowcount

        num_flows += len(flow_ids)
        last_flow_id = flow_ids[-1]

        print(f"Checked {num_flows} flows, wrote {num_status_rows} status and {num_node_rows} node corrective rows")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    fix_activity_counts(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("flows", "0408_flowrun_active_index"),
    ]

    operations = [
        migrations.RunPython(fix_activity_counts, migrations.RunPython.noop),
    ]
