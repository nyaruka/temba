from django.db import connection, migrations
from django.db.models import Max

ORG_BATCH_SIZE = 10

# totals only go up, so where flushes have already written a row the larger count is the more recent one
BACKFILL_SQL = """
INSERT INTO orgs_orgtally AS t (org_id, scope, count, expires_on)
     SELECT org_id, scope, count, expires_on
       FROM orgs_tally
      WHERE org_id > %(from_id)s AND org_id <= %(to_id)s
   ORDER BY org_id, scope
ON CONFLICT (org_id, scope) DO UPDATE SET count = GREATEST(t.count, excluded.count), expires_on = excluded.expires_on"""


def backfill_org_tallies(apps, schema_editor):
    Org = apps.get_model("orgs", "Org")

    max_org_id = Org.objects.aggregate(max_id=Max("id"))["max_id"] or 0
    num_written = 0

    for from_id in range(0, max_org_id, ORG_BATCH_SIZE):
        with connection.cursor() as cursor:
            cursor.execute(BACKFILL_SQL, {"from_id": from_id, "to_id": from_id + ORG_BATCH_SIZE})
            num_written += cursor.rowcount

    if num_written:
        print(f"Wrote {num_written} org tallies")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_org_tallies(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("orgs", "0199_orgtally"),
    ]

    operations = [
        migrations.RunPython(backfill_org_tallies, migrations.RunPython.noop),
    ]
