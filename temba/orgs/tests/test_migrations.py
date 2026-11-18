from datetime import datetime, time, timedelta, timezone as tz
from importlib import import_module
from unittest.mock import patch

from django.utils import timezone

from temba.contacts.models import Contact
from temba.orgs.models import Org
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

        # oldest day still retained and one too old
        contact(self.org, 400)
        contact(self.org, 401)

        # days the writer started partway through
        contact(self.org, 1)
        contact(self.org, 0)
        contact(self.org, 0)
        tally(self.org, "inbound", 0, 1)

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
                    expected(1, 1),
                    expected(0, 1),
                ]
            ),
            {
                t.scope: (t.count, t.expires_on)
                for t in self.org.org_tallies.filter(scope__startswith="contacts/new:other@")
            },
        )
        self.assertEqual(5, self.org.org_tallies.exclude(scope__startswith="contacts/new:other@").count())
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


class SwitchOrgStatusFieldsTest(MigrationTest):
    app = "orgs"
    migrate_from = "0210_backfill_org_status_fields"
    migrate_to = "0211_switch_org_status_fields"

    def setUpBeforeMigration(self, apps):
        OldOrg = apps.get_model("orgs", "Org")

        self.t1 = datetime(2026, 11, 1, 12, 0, 0, tzinfo=tz.utc)
        self.t2 = datetime(2026, 11, 2, 12, 0, 0, tzinfo=tz.utc)
        self.t3 = datetime(2026, 11, 3, 12, 0, 0, tzinfo=tz.utc)
        suspends_on = datetime(2026, 12, 1, 12, 0, 0, tzinfo=tz.utc)

        def restrict(org, reason):
            OldOrg.objects.filter(id=org.id).update(
                status="R", restricted_reason=reason, suspends_on=suspends_on, modified_on=self.t3
            )

        # restricted by code that didn't write the new fields, with an ongoing incident and an earlier one which ended
        restrict(self.org, "B")
        self.org.incidents.create(
            incident_type="org:restricted",
            scope="",
            started_on=self.t1 - timedelta(days=30),
            ended_on=self.t1 - timedelta(days=20),
        )
        self.org.incidents.create(incident_type="org:restricted", scope="", started_on=self.t1)

        # a child of a restricted org has its parent's incident
        self.child = Org.objects.create(
            name="Child", timezone="UTC", parent=self.org, created_by=self.admin, modified_by=self.admin
        )
        restrict(self.child, "B")

        # restricted with no incident
        self.org3 = Org.objects.create(name="Org 3", timezone="UTC", created_by=self.admin, modified_by=self.admin)
        restrict(self.org3, "S")

        # suspended, keeping the reason it had while restricted
        OldOrg.objects.filter(id=self.org2.id).update(status="S", status_reason="B", suspended_on=self.t2)

        # reactivated, leaving the reason it had while restricted
        self.org4 = Org.objects.create(name="Org 4", timezone="UTC", created_by=self.admin, modified_by=self.admin)
        OldOrg.objects.filter(id=self.org4.id).update(status_reason="L", status_changed_on=self.t1)

    def test_migration(self):
        def assert_org(org, reason, changed_on):
            org.refresh_from_db()
            self.assertEqual(reason, org.status_reason)
            self.assertEqual(changed_on, org.status_changed_on)

        assert_org(self.org, "B", self.t1)
        assert_org(self.child, "B", self.t1)
        assert_org(self.org3, "S", self.t3)
        assert_org(self.org2, "B", self.t2)
        assert_org(self.org4, None, self.t1)
