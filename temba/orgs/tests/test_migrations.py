from datetime import datetime, time, timedelta, timezone as tz
from importlib import import_module
from unittest.mock import patch

from django.db import connection
from django.utils import timezone

from temba.contacts.models import Contact
from temba.notifications.models import Incident
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

        # restricted by code that wrote the new fields, which are left alone
        self.org5 = Org.objects.create(name="Org 5", timezone="UTC", created_by=self.admin, modified_by=self.admin)
        restrict(self.org5, "L")
        OldOrg.objects.filter(id=self.org5.id).update(status_reason="L", status_changed_on=self.t2)

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
        assert_org(self.org5, "L", self.t2)


class RestrictWithoutSuspensionTest(MigrationTest):
    app = "orgs"
    migrate_from = "0213_drop_dailycount"
    migrate_to = "0214_restrict_without_suspension"

    def setUpBeforeMigration(self, apps):
        self.changed_on = datetime(2026, 11, 1, 12, 0, 0, tzinfo=tz.utc)
        self.suspends_on = datetime(2026, 12, 1, 12, 0, 0, tzinfo=tz.utc)

        def restrict(org, reason):
            Org.objects.filter(id=org.id).update(
                status="R", status_reason=reason, status_changed_on=self.changed_on, suspends_on=self.suspends_on
            )

        restrict(self.org, "S")
        restrict(self.org2, "B")

    def test_migration(self):
        self.org.refresh_from_db()
        self.org2.refresh_from_db()

        self.assertEqual(("R", "S", None), (self.org.status, self.org.status_reason, self.org.suspends_on))
        self.assertEqual(
            ("R", "B", self.suspends_on), (self.org2.status, self.org2.status_reason, self.org2.suspends_on)
        )


class FlaggedStatusReasonTest(MigrationTest):
    app = "orgs"
    migrate_from = "0214_restrict_without_suspension"
    migrate_to = "0215_flagged_status_reason"

    def setUpBeforeMigration(self, apps):
        OldOrg = apps.get_model("orgs", "Org")

        self.t1 = datetime(2026, 11, 1, 12, 0, 0, tzinfo=tz.utc)
        self.t2 = datetime(2026, 11, 2, 12, 0, 0, tzinfo=tz.utc)
        self.suspends_on = datetime(2026, 12, 1, 12, 0, 0, tzinfo=tz.utc)

        def create(name, **kwargs):
            return OldOrg.objects.create(
                name=name, timezone="UTC", created_by_id=self.admin.id, modified_by_id=self.admin.id, **kwargs
            )

        def set_status(org, status, reason, suspends_on=None):
            OldOrg.objects.filter(id=org.id).update(
                status=status, status_reason=reason, status_changed_on=self.t1, suspends_on=suspends_on
            )

        def incident(org, incident_type, started_on):
            return Incident.objects.create(org_id=org.id, incident_type=incident_type, scope="", started_on=started_on)

        # flagged with an ongoing incident, and a child which wasn't flagged itself
        OldOrg.objects.filter(id=self.org.id).update(is_flagged=True)
        self.org_incident = incident(self.org, "org:flagged", self.t1)
        self.child1 = create("Child 1", parent_id=self.org.id)

        # not flagged itself but has a flagged child
        self.child2 = create("Child 2", parent_id=self.org2.id, is_flagged=True)
        self.child2_incident = incident(self.child2, "org:flagged", self.t2)

        # flagged while restricted for billing, which the flag replaces
        self.org3 = create("Org 3", is_flagged=True)
        set_status(self.org3, "R", "B", self.suspends_on)
        self.org3_restricted = incident(self.org3, "org:restricted", self.t1)
        self.org3_flagged = incident(self.org3, "org:flagged", self.t2)

        # flagged while restricted by staff, which stays
        self.org4 = create("Org 4", is_flagged=True)
        set_status(self.org4, "R", "S")
        self.org4_flagged = incident(self.org4, "org:flagged", self.t2)

        # flagged while suspended, which stays
        self.org5 = create("Org 5", is_flagged=True)
        set_status(self.org5, "S", "B")

        # neither flagged nor restricted
        self.org6 = create("Org 6")

    def test_migration(self):
        def assert_org(org, status, reason=None, suspends_on=None, changed_on=None):
            org = Org.objects.get(id=org.id)
            self.assertEqual(status, org.status)
            self.assertEqual(reason, org.status_reason)
            self.assertEqual(suspends_on, org.suspends_on)
            if changed_on:
                self.assertEqual(changed_on, org.status_changed_on)

        def assert_ended(incident, ended: bool):
            incident.refresh_from_db()
            self.assertEqual(ended, incident.ended_on is not None)

        assert_org(self.org, "R", "F", changed_on=self.t1)
        assert_org(self.child1, "R", "F", changed_on=self.t1)
        assert_org(self.org2, "R", "F", changed_on=self.t2)
        assert_org(self.child2, "R", "F", changed_on=self.t2)
        assert_org(self.org3, "R", "F")
        assert_org(self.org4, "R", "S")
        assert_org(self.org5, "S", "B")
        assert_org(self.org6, "A")

        assert_ended(self.org_incident, False)
        assert_ended(self.child2_incident, False)
        self.assertEqual(self.org2.id, self.child2_incident.org_id)
        assert_ended(self.org3_restricted, True)
        assert_ended(self.org3_flagged, False)
        assert_ended(self.org4_flagged, True)


class PerWorkspaceStatusTest(MigrationTest):
    app = "orgs"
    migrate_from = "0215_flagged_status_reason"
    migrate_to = "0216_per_workspace_status"

    def setUpBeforeMigration(self, apps):
        OldOrg = apps.get_model("orgs", "Org")

        self.t1 = datetime(2026, 11, 1, 12, 0, 0, tzinfo=tz.utc)
        self.t2 = datetime(2026, 11, 2, 12, 0, 0, tzinfo=tz.utc)
        self.suspends_on = datetime(2026, 12, 1, 12, 0, 0, tzinfo=tz.utc)

        def create(name, status, reason, *, parent=None, is_flagged=False, suspends_on=None):
            org = OldOrg.objects.create(
                name=name,
                timezone="UTC",
                parent_id=parent.id if parent else None,
                status=status,
                status_reason=reason,
                status_changed_on=self.t1,
                suspends_on=suspends_on,
                created_by_id=self.admin.id,
                modified_by_id=self.admin.id,
            )
            with connection.cursor() as cursor:
                cursor.execute("UPDATE orgs_org SET is_flagged = %s WHERE id = %s", [is_flagged, org.id])
            return org

        def incident(org, started_on, ended_on=None):
            return Incident.objects.create(
                org_id=org.id, incident_type="org:restricted", scope="", started_on=started_on, ended_on=ended_on
            )

        # flagged by 0215 only because of its flagged children, one of whose incidents it took
        self.root1 = create("Root 1", "R", "F")
        self.root1_incident = incident(self.root1, self.t1)
        self.child1a = create("Child 1A", "R", "F", parent=self.root1, is_flagged=True)
        self.child1a_incident = incident(self.child1a, self.t2, ended_on=self.t2)
        self.child1b = create("Child 1B", "R", "F", parent=self.root1, is_flagged=True)
        self.child1c = create("Child 1C", "R", "F", parent=self.root1)

        # flagged itself, so it stays flagged, but its child doesn't
        self.root2 = create("Root 2", "R", "F", is_flagged=True)
        self.root2_incident = incident(self.root2, self.t1)
        self.child2 = create("Child 2", "R", "F", parent=self.root2)

        # flagged since 0215, by itself or a child which can't be told apart, so it stays flagged
        self.root3 = create("Root 3", "R", "F")
        self.child3 = create("Child 3", "R", "F", parent=self.root3)

        # restricted for billing, which its child shares again
        self.root4 = create("Root 4", "R", "B", suspends_on=self.suspends_on)
        self.child4 = create("Child 4", "R", "F", parent=self.root4)

        # suspended by staff, which is left alone
        self.root5 = create("Root 5", "S", "S")
        self.child5 = create("Child 5", "S", "S", parent=self.root5)

    def test_migration(self):
        def assert_org(org, status, reason=None, suspends_on=None):
            org = Org.objects.get(id=org.id)
            self.assertEqual((status, reason, suspends_on), (org.status, org.status_reason, org.suspends_on))

        def assert_incident(incident, org, ended: bool):
            incident.refresh_from_db()
            self.assertEqual(org.id, incident.org_id)
            self.assertEqual(ended, incident.ended_on is not None)

        assert_org(self.root1, "A")
        assert_org(self.child1a, "R", "F")
        assert_org(self.child1b, "R", "F")
        assert_org(self.child1c, "A")
        assert_incident(self.child1a_incident, self.child1a, ended=False)
        assert_incident(self.root1_incident, self.child1b, ended=False)

        assert_org(self.root2, "R", "F")
        assert_org(self.child2, "A")
        assert_incident(self.root2_incident, self.root2, ended=False)

        assert_org(self.root3, "R", "F")
        assert_org(self.child3, "A")

        assert_org(self.root4, "R", "B", self.suspends_on)
        assert_org(self.child4, "R", "B", self.suspends_on)

        assert_org(self.root5, "S", "S")
        assert_org(self.child5, "S", "S")


class ParentStatusReasonTest(MigrationTest):
    app = "orgs"
    migrate_from = "0216_per_workspace_status"
    migrate_to = "0217_parent_status_reason"

    def setUpBeforeMigration(self, apps):
        OldOrg = apps.get_model("orgs", "Org")

        def create(name, status, reason, *, parent=None):
            return OldOrg.objects.create(
                name=name,
                timezone="UTC",
                parent_id=parent.id if parent else None,
                status=status,
                status_reason=reason,
                status_changed_on=timezone.now(),
                created_by_id=self.admin.id,
                modified_by_id=self.admin.id,
            )

        self.root1 = create("Root 1", "R", "B")
        self.child1a = create("Child 1A", "R", "B", parent=self.root1)
        self.child1b = create("Child 1B", "R", "F", parent=self.root1)
        self.root2 = create("Root 2", "S", "L")
        self.child2 = create("Child 2", "S", "L", parent=self.root2)
        self.root3 = create("Root 3", "S", "S")
        self.child3 = create("Child 3", "S", "S", parent=self.root3)

    def test_migration(self):
        def assert_org(org, status, reason):
            org = Org.objects.get(id=org.id)
            self.assertEqual((status, reason), (org.status, org.status_reason))

        assert_org(self.root1, "R", "B")
        assert_org(self.child1a, "R", "P")
        assert_org(self.child1b, "R", "F")
        assert_org(self.root2, "S", "L")
        assert_org(self.child2, "S", "P")
        assert_org(self.root3, "S", "S")
        assert_org(self.child3, "S", "S")
