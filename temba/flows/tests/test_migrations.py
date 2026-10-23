from temba.tests import MigrationTest


class DeleteMsgsInDowCountsTest(MigrationTest):
    app = "flows"
    migrate_from = "0413_rename_reserved_flows"
    migrate_to = "0414_delete_msgsin_dow_counts"

    def setUpBeforeMigration(self, apps):
        self.flow1 = self.create_flow("Flow 1")
        self.flow1.counts.create(scope="msgsin:dow:1", count=3)
        self.flow1.counts.create(scope="msgsin:dow:1", count=2, is_squashed=True)
        self.flow1.counts.create(scope="msgsin:date:2026-10-19", count=5)
        self.flow1.counts.create(scope="msgsin:hour:9", count=5)

        self.flow2 = self.create_flow("Flow 2", org=self.org2)
        self.flow2.counts.create(scope="msgsin:dow:7", count=1)
        self.flow2.counts.create(scope="status:A", count=1)

    def test_migration(self):
        self.assertEqual({"msgsin:date:2026-10-19": 5, "msgsin:hour:9": 5}, self.flow1.counts.scope_totals())
        self.assertEqual({"status:A": 1}, self.flow2.counts.scope_totals())
