from datetime import datetime, time, timedelta, timezone as tz

from django.db import connection, migrations

# must match mailroom's retention of channel tallies
RETENTION_DAYS = 400

# Counts the messages in each channel's failed folder by the day they were created, as courier does when it fails them.
# Failures which mailroom decides, e.g. looping, aren't tallied so are excluded by their reasons. Each day's tally is
# only ever raised, so re-runs are noops and tallies of messages which have since been deleted or archived are kept.
BACKFILL_SQL = r"""
WITH channels AS (
    SELECT id FROM channels_channel WHERE org_id = %(org_id)s AND is_active FOR KEY SHARE
), failed AS (
    SELECT channel_id, (created_on AT TIME ZONE 'UTC')::date AS day, count(*) AS total
      FROM msgs_msg
     WHERE org_id = %(org_id)s AND folder = 'X' AND created_on >= %(since)s AND created_on < %(until)s
       AND channel_id IS NOT NULL AND msg_type != 'V' AND (failed_reason IS NULL OR failed_reason = 'E')
  GROUP BY 1, 2
)
INSERT INTO channels_channeltally AS t (channel_id, scope, count, expires_on)
     SELECT f.channel_id, 'text:failed@' || to_char(f.day, 'YYYY-MM-DD'), f.total, f.day + %(retention_days)s
       FROM failed f
       JOIN channels c ON c.id = f.channel_id
   ORDER BY 1, 2
ON CONFLICT (channel_id, scope) DO UPDATE SET count = excluded.count WHERE excluded.count > t.count"""


def backfill_failed_tallies(apps, schema_editor):
    Org = apps.get_model("orgs", "Org")

    with connection.cursor() as cursor:
        cursor.execute("SELECT (NOW() AT TIME ZONE 'UTC')::date")
        today = cursor.fetchone()[0]

    # recent days' tallies may still be buffered in Valkey, e.g. yesterday's just after midnight, so stop before them
    params = {
        "since": datetime.combine(today - timedelta(days=RETENTION_DAYS), time(0), tzinfo=tz.utc),
        "until": datetime.combine(today - timedelta(days=1), time(0), tzinfo=tz.utc),
        "retention_days": RETENTION_DAYS,
    }

    org_ids = list(Org.objects.filter(is_active=True).order_by("id").values_list("id", flat=True))
    num_written = 0

    for i, org_id in enumerate(org_ids):
        with connection.cursor() as cursor:
            cursor.execute(BACKFILL_SQL, {**params, "org_id": org_id})
            num_written += cursor.rowcount

        if (i + 1) % 1000 == 0:  # pragma: no cover
            print(f" > backfilled failed tallies for {i + 1}/{len(org_ids)} orgs")

    if num_written:
        print(f"Wrote {num_written} failed tallies")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_failed_tallies(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("channels", "0225_fold_legacy_channel_tallies"),
        ("msgs", "0333_update_triggers"),
    ]

    operations = [
        migrations.RunPython(backfill_failed_tallies, migrations.RunPython.noop),
    ]
