from django.db import connection, migrations
from django.db.models import Max

BATCH_SIZE = 100  # channels

# must match mailroom's retention of channel tallies, which it counts from their first write
RETENTION_DAYS = 400

# today is left alone as its tallies are already being written alongside its counts, whereas earlier days only have
# counts, so their totals replace any tallies written for them
SQL = """
INSERT INTO orgs_tally AS t (org_id, scope, count, expires_on)
     SELECT c.org_id, 'channels/' || cc.channel_id || '/' || cc.scope || '@' || to_char(cc.day, 'YYYY-MM-DD'),
            SUM(cc.count), cc.day + %(retention)s
       FROM channels_channelcount cc
       JOIN channels_channel c ON c.id = cc.channel_id
       JOIN orgs_org o ON o.id = c.org_id AND o.is_active
      WHERE cc.channel_id > %(from_id)s AND cc.channel_id <= %(to_id)s
        AND cc.day < %(today)s AND cc.day + %(retention)s > %(today)s
   GROUP BY c.org_id, cc.channel_id, cc.scope, cc.day
     HAVING SUM(cc.count) > 0
   ORDER BY 1, 2
ON CONFLICT (org_id, scope) DO UPDATE SET count = excluded.count, expires_on = excluded.expires_on"""


def backfill_channel_tallies(apps, schema_editor):
    Channel = apps.get_model("channels", "Channel")

    with connection.cursor() as cursor:
        cursor.execute("SELECT (NOW() AT TIME ZONE 'UTC')::date")
        today = cursor.fetchone()[0]

    max_id = Channel.objects.aggregate(max_id=Max("id"))["max_id"] or 0
    num_written = 0

    for from_id in range(0, max_id, BATCH_SIZE):
        with connection.cursor() as cursor:
            cursor.execute(
                SQL, {"retention": RETENTION_DAYS, "today": today, "from_id": from_id, "to_id": from_id + BATCH_SIZE}
            )
            num_written += cursor.rowcount

    if num_written:
        print(f"Wrote {num_written} channel tallies")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_channel_tallies(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("channels", "0220_remove_address_country_help_text"),
        ("orgs", "0198_tallyflush"),
    ]

    operations = [
        migrations.RunPython(backfill_channel_tallies, migrations.RunPython.noop),
    ]
