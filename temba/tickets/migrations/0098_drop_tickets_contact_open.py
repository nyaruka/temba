from django.db import migrations


class Migration(migrations.Migration):
    # a plain index drop would block writes to the tickets table while it waits for its lock, so it's dropped concurrently
    atomic = False

    dependencies = [
        ("tickets", "0097_ticket_tickets_contact_single_active"),
    ]

    operations = [
        migrations.RunSQL(
            sql='DROP INDEX CONCURRENTLY IF EXISTS "tickets_contact_open"',
            state_operations=[migrations.RemoveIndex(model_name="ticket", name="tickets_contact_open")],
        ),
    ]
