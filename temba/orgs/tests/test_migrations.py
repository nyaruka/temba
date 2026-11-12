from datetime import datetime, time, timedelta, timezone as tz
from importlib import import_module
from unittest.mock import patch

from django.utils import timezone

from temba.contacts.models import Contact
from temba.tests import MigrationTest


class BackfillNewContactTalliesTest(MigrationTest):
    app = "orgs"
    migrate_from = "0203_org_is_internal"
    migrate_to = "0204_backfill_new_contact_tallies"

    def setUpBeforeMigration(self, apps):
        self.today = timezone.now().date()

        def day(days_ago: int):
            return self.today - timedelta(days=days_ago)

        def contact(org, days_ago: int, *, is_active=True):
            c = self.create_contact("Bob", org=org)
            created_on = datetime.combine(day(days_ago), time(12), tzinfo=tz.utc)
            Contact.objects.filter(id=c.id).update(created_on=created_on, is_active=is_active)

        def tally(org, scope: str, days_ago: int, count: int):
            org.org_tallies.create(scope=f"contacts/new:{scope}@{day(days_ago)}", count=count)

        self.day = day

        # no tallies, including a deleted contact
        contact(self.org, 10)
        contact(self.org, 10, is_active=False)

        # partly tallied by other scopes
        for _ in range(4):
            contact(self.org, 4)
        tally(self.org, "inbound", 4, 1)
        tally(self.org, "ui", 4, 1)

        # already tallied as other with more than remain
        contact(self.org, 3)
        tally(self.org, "other", 3, 5)

        # fully tallied by other scopes
        contact(self.org, 2)
        contact(self.org, 2)
        tally(self.org, "inbound", 2, 2)

        # oldest day still retained, one too old, and ones too recent as their tallies may still be in Valkey
        contact(self.org, 400)
        contact(self.org, 401)
        contact(self.org, 1)
        contact(self.org, 0)

        # inactive org
        contact(self.org2, 4)
        self.org2.is_active = False
        self.org2.save(update_fields=("is_active",))

        # unrelated tally
        self.org.org_tallies.create(scope=f"msgs/text:in@{day(4)}", count=7)

    def assertState(self):
        def expected(days_ago: int, count: int, expires=True):
            d = self.day(days_ago)
            return f"contacts/new:other@{d}", (count, d + timedelta(days=400) if expires else None)

        self.assertEqual(
            dict(
                [
                    expected(10, 2),
                    expected(4, 2),
                    expected(3, 5, expires=False),
                    expected(400, 1),
                ]
            ),
            {
                t.scope: (t.count, t.expires_on)
                for t in self.org.org_tallies.filter(scope__startswith="contacts/new:other@")
            },
        )
        self.assertEqual(4, self.org.org_tallies.exclude(scope__startswith="contacts/new:other@").count())
        self.assertFalse(self.org2.org_tallies.exists())

    def test_migration(self):
        self.assertState()

        # running again is a noop
        migration = import_module("temba.orgs.migrations.0204_backfill_new_contact_tallies")
        with patch("builtins.print") as mock_print:
            migration.backfill_new_contact_tallies(self.apps, None)

        mock_print.assert_not_called()
        self.assertState()

        # but raises tallies which are behind
        self.org.org_tallies.filter(scope=f"contacts/new:other@{self.day(4)}").update(count=1)
        migration.backfill_new_contact_tallies(self.apps, None)

        self.assertState()
