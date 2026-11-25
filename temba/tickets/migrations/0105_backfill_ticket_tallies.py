from django.db import connection, migrations

# Copies each workspace's ticket daily counts into tallies, for days up to and including the first day mailroom tallied
# anything but response times, as that day's tallies only count from partway through it. That's today for a workspace
# which mailroom hasn't tallied for yet. Response times are excluded from finding that day, as they're tallied on the
# day a ticket was opened, which can be long before.
# Daily counts are by the workspace's local day and tallies by UTC day, so each local day's count becomes that date's
# tally. Each tally is only ever raised, so re-runs are noops. An increment still buffered in Valkey when its day is
# raised gets added again when flushed, but that's only the few seconds before each flush.
BACKFILL_SQL = r"""
WITH org AS (
    SELECT id FROM orgs_org WHERE id = %(org_id)s AND is_active FOR KEY SHARE
), cutoff AS (
    SELECT COALESCE(min(substring(scope FROM '@(.+)$')::date), %(today)s) AS day
      FROM orgs_orgtally
     WHERE org_id = %(org_id)s AND scope >= 'tickets/' AND scope < 'tickets0' AND scope !~ '^tickets/resptime:'
), counted AS (
    SELECT c.day, m.scope, sum(c.count) AS total
      FROM orgs_dailycount c
CROSS JOIN LATERAL unnest(CASE
               WHEN c.scope LIKE 'tickets:opened:%%' THEN
                    ARRAY['tickets/opened:' || split_part(c.scope, ':', 3)]
               WHEN c.scope LIKE 'tickets:assigned:%%' THEN
                    ARRAY['tickets/assigned:' || split_part(c.scope, ':', 4)]
               WHEN c.scope LIKE 'msgs:ticketreplies:%%' THEN
                    ARRAY['tickets/teamreplies:' || split_part(c.scope, ':', 3),
                          'tickets/userreplies:' || split_part(c.scope, ':', 4)]
               WHEN c.scope ~ '^ticketresptime:(.+:)?(total|count)$' THEN
                    ARRAY['tickets/resptime:' || substring(c.scope FROM '[^:]+$')]
           END) AS m(scope)
     WHERE c.org_id = %(org_id)s AND c.day <= (SELECT day FROM cutoff)
       AND (c.scope LIKE 'tickets:%%' OR c.scope LIKE 'msgs:ticketreplies:%%' OR c.scope LIKE 'ticketresptime:%%')
  GROUP BY 1, 2
)
INSERT INTO orgs_orgtally AS t (org_id, scope, count, expires_on)
     SELECT o.id, c.scope || '@' || to_char(c.day, 'YYYY-MM-DD'), c.total, NULL
       FROM counted c
       JOIN org o ON TRUE
      WHERE c.total > 0
   ORDER BY 2
ON CONFLICT (org_id, scope) DO UPDATE SET count = excluded.count WHERE excluded.count > t.count"""


def backfill_ticket_tallies(apps, schema_editor):  # pragma: no cover
    Org = apps.get_model("orgs", "Org")

    with connection.cursor() as cursor:
        cursor.execute("SELECT (NOW() AT TIME ZONE 'UTC')::date")
        today = cursor.fetchone()[0]

    org_ids = list(Org.objects.filter(is_active=True).order_by("id").values_list("id", flat=True))
    num_written = 0

    for i, org_id in enumerate(org_ids):
        with connection.cursor() as cursor:
            cursor.execute(BACKFILL_SQL, {"org_id": org_id, "today": today})
            num_written += cursor.rowcount

        if (i + 1) % 1000 == 0:
            print(f" > backfilled ticket tallies for {i + 1}/{len(org_ids)} orgs")

    if num_written:
        print(f"Wrote {num_written} ticket tallies")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_ticket_tallies(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("orgs", "0210_backfill_org_status_fields"),
        ("tickets", "0104_drop_team_is_active"),
    ]

    operations = [
        migrations.RunPython(backfill_ticket_tallies, migrations.RunPython.noop),
    ]
