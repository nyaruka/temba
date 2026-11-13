from datetime import datetime, time, timedelta, timezone as tz

from django.db import connection, migrations

# must match mailroom's retention of channel tallies, org call tallies being kept forever
CHANNEL_RETENTION_DAYS = 400

# Counts each org's calls, and of those within retention each active channel's, by direction and the day they were
# created, as mailroom does when it creates them. Each day's tally is only ever raised, so re-runs are noops and
# tallies of calls which have since been deleted are kept. Today is included as the writers started partway through a
# day. An increment still buffered in Valkey when its day is raised gets added again when flushed, but that's only the
# few seconds before each flush.
BACKFILL_ORG_SQL = r"""
WITH org AS (
    SELECT id FROM orgs_org WHERE id = %(org_id)s AND is_active FOR KEY SHARE
), calls AS (
    SELECT CASE direction WHEN 'I' THEN 'in' ELSE 'out' END AS dir, (created_on AT TIME ZONE 'UTC')::date AS day,
           count(*) AS total
      FROM ivr_call
     WHERE org_id = %(org_id)s
  GROUP BY 1, 2
)
INSERT INTO orgs_orgtally AS t (org_id, scope, count, expires_on)
     SELECT o.id, 'calls/' || c.dir || '@' || to_char(c.day, 'YYYY-MM-DD'), c.total, NULL
       FROM calls c
       JOIN org o ON TRUE
   ORDER BY 2
ON CONFLICT (org_id, scope) DO UPDATE SET count = excluded.count WHERE excluded.count > t.count"""

BACKFILL_CHANNEL_SQL = r"""
WITH channels AS (
    SELECT id FROM channels_channel WHERE org_id = %(org_id)s AND is_active FOR KEY SHARE
), calls AS (
    SELECT channel_id, CASE direction WHEN 'I' THEN 'in' ELSE 'out' END AS dir,
           (created_on AT TIME ZONE 'UTC')::date AS day, count(*) AS total
      FROM ivr_call
     WHERE org_id = %(org_id)s AND created_on >= %(since)s
  GROUP BY 1, 2, 3
)
INSERT INTO channels_channeltally AS t (channel_id, scope, count, expires_on)
     SELECT c.channel_id, 'calls:' || c.dir || '@' || to_char(c.day, 'YYYY-MM-DD'), c.total, c.day + %(retention_days)s
       FROM calls c
       JOIN channels ch ON ch.id = c.channel_id
   ORDER BY 1, 2
ON CONFLICT (channel_id, scope) DO UPDATE SET count = excluded.count WHERE excluded.count > t.count"""


def backfill_call_tallies(apps, schema_editor):
    Org = apps.get_model("orgs", "Org")

    with connection.cursor() as cursor:
        cursor.execute("SELECT (NOW() AT TIME ZONE 'UTC')::date")
        today = cursor.fetchone()[0]

    params = {
        "since": datetime.combine(today - timedelta(days=CHANNEL_RETENTION_DAYS), time(0), tzinfo=tz.utc),
        "retention_days": CHANNEL_RETENTION_DAYS,
    }

    org_ids = list(Org.objects.filter(is_active=True).order_by("id").values_list("id", flat=True))
    num_written = 0

    for i, org_id in enumerate(org_ids):
        with connection.cursor() as cursor:
            cursor.execute(BACKFILL_ORG_SQL, {"org_id": org_id})
            num_written += cursor.rowcount
            cursor.execute(BACKFILL_CHANNEL_SQL, {**params, "org_id": org_id})
            num_written += cursor.rowcount

        if (i + 1) % 1000 == 0:  # pragma: no cover
            print(f" > backfilled call tallies for {i + 1}/{len(org_ids)} orgs")

    if num_written:
        print(f"Wrote {num_written} call tallies")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_call_tallies(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("channels", "0227_backfill_failed_tallies"),
        ("ivr", "0043_remove_call_calls_org_created_on"),
        ("orgs", "0204_backfill_new_contact_tallies"),
    ]

    operations = [
        migrations.RunPython(backfill_call_tallies, migrations.RunPython.noop),
    ]
