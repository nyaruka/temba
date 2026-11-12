from datetime import datetime, time, timedelta, timezone as tz

from django.db import connection, migrations

# must match mailroom's retention of new contact tallies
RETENTION_DAYS = 400

# Contacts created on each day which aren't counted by another contacts/new scope are counted as other, as that's all
# we can tell about how a contact came to exist before mailroom tallied them. Each day's tally is only ever raised, so
# re-runs are noops and tallies of contacts which have since been deleted are kept.
BACKFILL_SQL = r"""
WITH org AS (
    SELECT id FROM orgs_org WHERE id = %(org_id)s AND is_active FOR KEY SHARE
), created AS (
    SELECT (created_on AT TIME ZONE 'UTC')::date AS day, count(*) AS total
      FROM contacts_contact
     WHERE org_id = %(org_id)s AND created_on >= %(since)s AND created_on < %(until)s
  GROUP BY 1
), tallied AS (
    SELECT substring(scope FROM '@(.+)$')::date AS day, sum(count) AS total
      FROM orgs_orgtally
     WHERE org_id = %(org_id)s AND scope >= 'contacts/new:' AND scope < 'contacts/new;'
       AND scope !~ '^contacts/new:other@'
  GROUP BY 1
)
INSERT INTO orgs_orgtally AS t (org_id, scope, count, expires_on)
     SELECT o.id, 'contacts/new:other@' || to_char(c.day, 'YYYY-MM-DD'), c.total - COALESCE(d.total, 0),
            c.day + %(retention_days)s
       FROM created c
       JOIN org o ON TRUE
  LEFT JOIN tallied d ON d.day = c.day
      WHERE c.total > COALESCE(d.total, 0)
   ORDER BY 2
ON CONFLICT (org_id, scope) DO UPDATE SET count = excluded.count WHERE excluded.count > t.count"""


def backfill_new_contact_tallies(apps, schema_editor):
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
            print(f" > backfilled new contact tallies for {i + 1}/{len(org_ids)} orgs")

    if num_written:
        print(f"Wrote {num_written} new contact tallies")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_new_contact_tallies(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("contacts", "0228_drop_contact_ticket_count"),
        ("orgs", "0203_org_is_internal"),
    ]

    operations = [
        migrations.RunPython(backfill_new_contact_tallies, migrations.RunPython.noop),
    ]
