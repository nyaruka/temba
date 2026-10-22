from django.db import connection, migrations

# tickets already past their workspace's limit are closed at random times over this period rather than all at once
OVERDUE_SPREAD_HOURS = 6

SQL = """
INSERT INTO contacts_contactfire (org_id, contact_id, fire_type, scope, fire_on)
     SELECT t.org_id, t.contact_id, 'K', t.uuid::text, GREATEST(
                t.last_activity_on + make_interval(days => %(idle_days)s) + INTERVAL '1 hour',
                NOW() + random() * make_interval(hours => %(spread_hours)s)
            )
       FROM tickets_ticket t
      WHERE t.org_id = %(org_id)s AND t.status = 'O'
ON CONFLICT DO NOTHING"""


def backfill_ticket_close_fires(apps, schema_editor):  # pragma: no cover
    Org = apps.get_model("orgs", "Org")

    num_created = 0

    # tickets with activity since mailroom started scheduling these already have one, which is left as it is
    for org in Org.objects.filter(is_active=True, max_ticket_idle_days__gt=0).only("id", "max_ticket_idle_days"):
        with connection.cursor() as cursor:
            cursor.execute(
                SQL, {"org_id": org.id, "idle_days": org.max_ticket_idle_days, "spread_hours": OVERDUE_SPREAD_HOURS}
            )
            num_created += cursor.rowcount

    if num_created:
        print(f"Created close fires for {num_created} open tickets")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_ticket_close_fires(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("contacts", "0224_contactfire_ticket_close"),
        ("orgs", "0195_org_max_ticket_idle_days"),
        ("tickets", "0094_ticket_tickets_open_last_activity"),
    ]

    operations = [
        migrations.RunPython(backfill_ticket_close_fires, migrations.RunPython.noop),
    ]
