from django.db import connection, migrations, transaction
from django.db.models import Max

FLOW_BATCH_SIZE = 100

UUID_RE = "[0-9a-fA-F-]{36}"

# Folds old format "segment:<exit_uuid>:<node_uuid>" tallies into the compact "segment:<base64url(exit+node)>" format.
# Adding exactly the deleted amounts onto the new keys means that a mailroom flush landing mid-migration, in either
# format, is never lost or double counted.
FOLD_SQL = rf"""
WITH old AS (
    DELETE FROM flows_flowtally
     WHERE flow_id > %(from_id)s AND flow_id <= %(to_id)s AND scope ~ '^segment:{UUID_RE}:{UUID_RE}$'
 RETURNING flow_id, split_part(scope, ':', 2) AS exit_uuid, split_part(scope, ':', 3) AS node_uuid, count
)
INSERT INTO flows_flowtally AS t (flow_id, scope, count)
     SELECT flow_id,
            'segment:' || rtrim(translate(encode(
                decode(replace(exit_uuid, '-', ''), 'hex') || decode(replace(node_uuid, '-', ''), 'hex'), 'base64'
            ), '+/', '-_'), '='),
            SUM(count)
       FROM old
   GROUP BY 1, 2
   ORDER BY 1, 2
ON CONFLICT (flow_id, scope) DO UPDATE SET count = t.count + excluded.count"""

# mailroom drops rows whose total reaches zero, so a missing row means zero
DELETE_ZEROS_SQL = r"""
DELETE FROM flows_flowtally
 WHERE flow_id > %(from_id)s AND flow_id <= %(to_id)s AND scope LIKE 'segment:%%' AND count = 0"""


def compact_segment_tallies(apps, schema_editor):
    Flow = apps.get_model("flows", "Flow")

    max_id = Flow.objects.aggregate(max_id=Max("id"))["max_id"] or 0
    num_folded = 0

    for from_id in range(0, max_id, FLOW_BATCH_SIZE):
        params = {"from_id": from_id, "to_id": from_id + FLOW_BATCH_SIZE}

        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(FOLD_SQL, params)
            num_folded += cursor.rowcount
            cursor.execute(DELETE_ZEROS_SQL, params)

    if num_folded:
        print(f"Folded segment tallies into {num_folded} compact scopes")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    compact_segment_tallies(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("flows", "0418_backfill_flow_tallies"),
    ]

    operations = [
        migrations.RunPython(compact_segment_tallies, migrations.RunPython.noop),
    ]
