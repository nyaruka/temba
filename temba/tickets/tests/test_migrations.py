from datetime import timedelta

from django.utils import timezone

from temba.contacts.models import ContactFire
from temba.tests import MigrationTest


class BackfillTicketCloseFiresTest(MigrationTest):
    app = "tickets"
    migrate_from = "0094_ticket_tickets_open_last_activity"
    migrate_to = "0095_backfill_ticket_close_fires"

    def setUpBeforeMigration(self, apps):
        self.org.max_ticket_idle_days = 7
        self.org.save(update_fields=("max_ticket_idle_days",))
        self.org2.max_ticket_idle_days = 0
        self.org2.save(update_fields=("max_ticket_idle_days",))

        now = timezone.now()
        ann = self.create_contact("Ann", phone="+16055741111")
        bob = self.create_contact("Bob", phone="+16055742222")
        cat = self.create_contact("Cat", phone="+16055743333")
        dan = self.create_contact("Dan", phone="+16055744444")
        eve = self.create_contact("Eve", phone="+16055745555", org=self.org2)

        # active recently, idle for a long time, already scheduled, closed, and in a workspace which never closes
        self.recent = self.create_ticket(ann)
        self.recent.last_activity_on = now - timedelta(days=2)
        self.recent.save(update_fields=("last_activity_on",))

        self.overdue = self.create_ticket(bob)
        self.overdue.last_activity_on = now - timedelta(days=100)
        self.overdue.save(update_fields=("last_activity_on",))

        self.scheduled = self.create_ticket(cat)
        self.scheduled_on = now + timedelta(days=3)
        ContactFire.objects.create(
            org=self.org,
            contact=cat,
            fire_type=ContactFire.TYPE_TICKET_CLOSE,
            scope=str(self.scheduled.uuid),
            fire_on=self.scheduled_on,
        )

        self.closed = self.create_ticket(dan, closed_on=now)
        self.unlimited = self.create_ticket(eve)

    def test_migration(self):
        fires = {f.scope: f for f in ContactFire.objects.filter(fire_type=ContactFire.TYPE_TICKET_CLOSE)}
        now = timezone.now()

        self.assertEqual({str(self.recent.uuid), str(self.overdue.uuid), str(self.scheduled.uuid)}, set(fires))
        self.assertEqual(
            self.recent.last_activity_on + timedelta(days=7, hours=1), fires[str(self.recent.uuid)].fire_on
        )
        self.assertTrue(now - timedelta(minutes=1) <= fires[str(self.overdue.uuid)].fire_on <= now + timedelta(hours=6))
        self.assertEqual(self.scheduled_on, fires[str(self.scheduled.uuid)].fire_on)
        self.assertEqual(self.org.id, fires[str(self.recent.uuid)].org_id)
        self.assertEqual(self.recent.contact_id, fires[str(self.recent.uuid)].contact_id)
