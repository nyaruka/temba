from importlib import import_module

from django_valkey import get_valkey_connection

from django.apps import apps

from temba.flows.models import Flow, FlowActivityCount
from temba.tests import MigrationTest, cleanup


class BackfillStatusTalliesTest(MigrationTest):
    app = "flows"
    migrate_from = "0423_drop_flowlabel_is_active"
    migrate_to = "0424_backfill_status_tallies"

    def setUpBeforeMigration(self, apps):
        self.flow1 = self.create_flow("Flow 1")
        self.flow2 = self.create_flow("Flow 2")

        def count(flow, status, count, is_squashed=False):
            FlowActivityCount.objects.create(flow=flow, scope=f"status:{status}", count=count, is_squashed=is_squashed)

        count(self.flow1, "W", 3, is_squashed=True)
        count(self.flow1, "W", 1)
        count(self.flow1, "C", 2)
        count(self.flow1, "A", 1)
        count(self.flow1, "A", -1)
        count(self.flow2, "W", 5)

        # tallies written since mailroom started writing them, which can be behind (some still buffered in Valkey), or
        # below zero, or left on a status which the counts say has no runs
        self.flow1.tallies.create(scope="status:W", count=1)
        self.flow1.tallies.create(scope="status:C", count=-1)
        self.flow1.tallies.create(scope="status:A", count=-2)
        self.flow1.tallies.create(scope="status:X", count=5)
        self.flow1.tallies.create(scope="segment:abc", count=7)
        self.flow2.tallies.create(scope="status:C", count=3)
        get_valkey_connection().hset("{tallies}:live", mapping={f"F{self.flow1.id}|status:W": 1})

        Flow.objects.filter(id=self.flow2.id).update(is_active=False)

    @cleanup(valkey=True)
    def test_migration(self):
        def assert_tallies():
            self.assertEqual(
                {
                    ("status:W", 3),  # 4 counted, of which 1 is still in Valkey
                    ("status:C", 2),
                    ("segment:abc", 7),
                },
                set(self.flow1.tallies.values_list("scope", "count")),
            )
            self.assertEqual({("status:C", 3)}, set(self.flow2.tallies.values_list("scope", "count")))

        assert_tallies()

        # running again is a no-op
        migration = import_module("temba.flows.migrations.0424_backfill_status_tallies")
        migration.backfill_status_tallies(apps, None)
        assert_tallies()

        # unless a tally has drifted from its count since
        self.flow1.tallies.filter(scope="status:C").update(count=1)
        self.flow1.tallies.create(scope="status:F", count=2)
        migration.backfill_status_tallies(apps, None)
        assert_tallies()
