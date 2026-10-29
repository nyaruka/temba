from django.db import migrations

# whether a contact has an active ticket is read from their tickets, so contact ticket counts are no longer maintained
SQL = """
DROP TRIGGER temba_ticket_on_change_trg ON tickets_ticket;
DROP FUNCTION temba_ticket_on_change();
"""

REVERSE_SQL = """
CREATE OR REPLACE FUNCTION temba_ticket_on_change() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN -- new ticket inserted
    IF NEW.status = 'O' THEN
      UPDATE contacts_contact SET ticket_count = ticket_count + 1, modified_on = NOW() WHERE id = NEW.contact_id;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN -- existing ticket updated
    IF OLD.status = 'O' AND NEW.status = 'C' THEN -- ticket closed
      UPDATE contacts_contact SET ticket_count = ticket_count - 1, modified_on = NOW() WHERE id = OLD.contact_id;
    ELSIF OLD.status = 'C' AND NEW.status = 'O' THEN -- ticket reopened
      UPDATE contacts_contact SET ticket_count = ticket_count + 1, modified_on = NOW() WHERE id = OLD.contact_id;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN -- existing ticket deleted
    IF OLD.status = 'O' THEN -- open ticket deleted
      UPDATE contacts_contact SET ticket_count = ticket_count - 1, modified_on = NOW() WHERE id = OLD.contact_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER temba_ticket_on_change_trg
  AFTER INSERT OR UPDATE OR DELETE ON tickets_ticket
  FOR EACH ROW EXECUTE PROCEDURE temba_ticket_on_change();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("tickets", "0098_drop_tickets_contact_open"),
    ]

    operations = [
        migrations.RunSQL(SQL, REVERSE_SQL),
    ]
