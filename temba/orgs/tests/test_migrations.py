from temba.orgs.models import Tally
from temba.tests import MigrationTest


class DeleteSlashDailyTalliesTest(MigrationTest):
    app = "orgs"
    migrate_from = "0197_tallies"
    migrate_to = "0198_delete_slash_daily_tallies"

    def setUpBeforeMigration(self, apps):
        for scope in ("emails/shared/2026-11-02", "llms/builtin/calls/2026-11-02", "emails/shared@2026-11-03", "foo/1"):
            Tally.objects.create(org=self.org, scope=scope, count=3)

    def test_migration(self):
        self.assertEqual({"emails/shared@2026-11-03", "foo/1"}, set(Tally.objects.values_list("scope", flat=True)))
