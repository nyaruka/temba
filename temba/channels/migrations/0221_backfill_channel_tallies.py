from django.db import connection, migrations
from django.db.models import Max

CHANNEL_BATCH_SIZE = 100
ORG_BATCH_SIZE = 10

# must match mailroom's retention of channel tallies, which it counts from their first write
RETENTION_DAYS = 400

# today is left alone as its tallies are already being written alongside its counts, whereas earlier days only have
# counts, so their totals replace any tallies written for them
CHANNELS_SQL = """
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

MSGS_SQL = """
INSERT INTO orgs_tally AS t (org_id, scope, count)
     SELECT c.org_id, 'msgs/' || cc.scope || '@' || to_char(cc.day, 'YYYY-MM-DD'), SUM(cc.count)
       FROM channels_channelcount cc
       JOIN channels_channel c ON c.id = cc.channel_id
       JOIN orgs_org o ON o.id = c.org_id AND o.is_active
      WHERE c.org_id > %(from_id)s AND c.org_id <= %(to_id)s AND cc.day < %(today)s
   GROUP BY c.org_id, cc.scope, cc.day
     HAVING SUM(cc.count) > 0
   ORDER BY 1, 2
ON CONFLICT (org_id, scope) DO UPDATE SET count = excluded.count"""


def backfill_channel_tallies(apps, schema_editor):
    Channel = apps.get_model("channels", "Channel")
    Org = apps.get_model("orgs", "Org")

    with connection.cursor() as cursor:
        cursor.execute("SELECT (NOW() AT TIME ZONE 'UTC')::date")
        today = cursor.fetchone()[0]

    def backfill(sql, max_id, batch_size, **params) -> int:
        num_written = 0
        for from_id in range(0, max_id, batch_size):
            with connection.cursor() as cursor:
                cursor.execute(sql, {"today": today, "from_id": from_id, "to_id": from_id + batch_size, **params})
                num_written += cursor.rowcount
        return num_written

    max_channel_id = Channel.objects.aggregate(max_id=Max("id"))["max_id"] or 0
    num_channels = backfill(CHANNELS_SQL, max_channel_id, CHANNEL_BATCH_SIZE, retention=RETENTION_DAYS)

    max_org_id = Org.objects.aggregate(max_id=Max("id"))["max_id"] or 0
    num_msgs = backfill(MSGS_SQL, max_org_id, ORG_BATCH_SIZE)

    if num_channels or num_msgs:
        print(f"Wrote {num_channels} channel tallies and {num_msgs} msgs tallies")


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
