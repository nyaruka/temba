from django.db import connection

from temba.tests import MigrationTest


class ChannelTpsNotNullTest(MigrationTest):
    app = "channels"
    migrate_from = "0225_fold_legacy_channel_tallies"
    migrate_to = "0226_channel_tps_not_null"

    def setUpBeforeMigration(self, apps):
        self.no_tps = self.create_channel("EX", "No TPS", "1234", schemes=["tel"])
        self.zero_tps = self.create_channel("EX", "Zero TPS", "2345", schemes=["tel"])
        self.own_tps = self.create_channel("EX", "Own TPS", "3456", schemes=["tel"])

        with connection.cursor() as cursor:
            cursor.execute("UPDATE channels_channel SET tps = NULL WHERE id = %s", [self.no_tps.id])
            cursor.execute("UPDATE channels_channel SET tps = 0 WHERE id = %s", [self.zero_tps.id])
            cursor.execute("UPDATE channels_channel SET tps = 45 WHERE id = %s", [self.own_tps.id])

    def test_migration(self):
        for ch in (self.no_tps, self.zero_tps, self.own_tps):
            ch.refresh_from_db()

        self.assertEqual(10, self.no_tps.tps)
        self.assertEqual(10, self.zero_tps.tps)
        self.assertEqual(45, self.own_tps.tps)
