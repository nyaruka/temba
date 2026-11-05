from datetime import date

from temba.tests import MigrationTest


class BackfillOrgTalliesTest(MigrationTest):
    app = "orgs"
    migrate_from = "0199_orgtally"
    migrate_to = "0200_backfill_org_tallies"

    def setUpBeforeMigration(self, apps):
        self.org.tallies.create(scope="foo/1", count=5)
        self.org.tallies.create(scope="foo/2@2026-11-02", count=3, expires_on=date(2027, 11, 2))
        self.org.tallies.create(scope="foo/3", count=4)
        self.org2.tallies.create(scope="foo/1", count=7)

        # already written by a flush with a higher count, or with a lower one
        self.org.org_tallies.create(scope="foo/1", count=6)
        self.org.org_tallies.create(scope="foo/3", count=2)
        self.org.org_tallies.create(scope="foo/2@2026-11-02", count=1, expires_on=date(2028, 1, 1))

    def test_migration(self):
        self.assertEqual(
            {("foo/1", 6, None), ("foo/2@2026-11-02", 3, date(2027, 11, 2)), ("foo/3", 4, None)},
            set(self.org.org_tallies.values_list("scope", "count", "expires_on")),
        )
        self.assertEqual({("foo/1", 7, None)}, set(self.org2.org_tallies.values_list("scope", "count", "expires_on")))
