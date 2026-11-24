from django.db import connection, migrations
from django.db.models import Max

# Fills in current_flow_uuid, added in 0229, for contacts already in a flow. This has to run after mailroom is writing
# both columns, otherwise contacts entering flows in the meantime would be missed.
#
# The table is walked by primary key ranges because neither column is indexed, so filtering on them alone would scan
# the whole table for every batch.

BATCH_SIZE = 10_000

SQL = """
UPDATE contacts_contact c
   SET current_flow_uuid = f.uuid
  FROM flows_flow f
 WHERE c.id > %(from_id)s AND c.id <= %(to_id)s
   AND c.current_flow_id = f.id AND c.current_flow_uuid IS NULL"""


def backfill_current_flow_uuid(apps, schema_editor):  # pragma: no cover
    Contact = apps.get_model("contacts", "Contact")

    max_id = Contact.objects.aggregate(max_id=Max("id"))["max_id"] or 0
    num_updated = 0

    for from_id in range(0, max_id, BATCH_SIZE):
        with connection.cursor() as cursor:
            cursor.execute(SQL, {"from_id": from_id, "to_id": from_id + BATCH_SIZE})
            num_updated += cursor.rowcount

    if num_updated:
        print(f"Backfilled current_flow_uuid on {num_updated} contacts")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_current_flow_uuid(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("contacts", "0229_contact_current_flow_uuid"),
    ]

    operations = [
        migrations.RunPython(backfill_current_flow_uuid, migrations.RunPython.noop),
    ]
