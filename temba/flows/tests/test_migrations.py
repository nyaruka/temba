from datetime import date, timedelta

from django_valkey import get_valkey_connection

from django.utils import timezone

from temba.flows.models import Flow, FlowActivityCount
from temba.tests import MigrationTest, cleanup


class BackfillFlowTalliesTest(MigrationTest):
    app = "flows"
    migrate_from = "0417_flowtally"
    migrate_to = "0418_backfill_flow_tallies"

    def setUpBeforeMigration(self, apps):
        self.today = timezone.now().date()
        self.yesterday = self.today - timedelta(days=1)
        self.expired = self.today - timedelta(days=366)

        self.flow1 = self.create_flow("Flow 1")
        self.flow2 = self.create_flow("Flow 2")
        self.flow3 = self.create_flow("Flow 3")

        def count(flow, scope, count, is_squashed=False):
            FlowActivityCount.objects.create(flow=flow, scope=scope, count=count, is_squashed=is_squashed)

        count(self.flow1, "segment:a:b", 10, is_squashed=True)
        count(self.flow1, "segment:a:b", 3)
        count(self.flow1, "segment:a:c", 4)
        count(self.flow1, "segment:c:d", 5)
        count(self.flow1, "segment:d:e", 0)
        count(self.flow1, "msgsin:hour:7", 6)
        count(self.flow1, f"msgsin:date:{self.yesterday}", 7)
        count(self.flow1, f"msgsin:date:{self.today}", 8)
        count(self.flow1, f"msgsin:date:{self.expired}", 9)
        count(self.flow1, "msgsin:dow:1", 10)
        count(self.flow1, "node:abc", 11)
        count(self.flow2, "segment:a:b", 12)
        count(self.flow3, "segment:a:b", 13)

        # tallies written since mailroom started writing them, some still buffered in Valkey, and one which is ahead
        # of its count because the counts never included it
        self.flow1.tallies.create(scope="segment:a:b", count=2)
        self.flow1.tallies.create(scope=f"msgsin:date:{self.today}", count=3)
        self.flow1.tallies.create(scope="segment:c:d", count=6)
        get_valkey_connection().hset(
            "{tallies}:live", mapping={f"F{self.flow1.id}|segment:a:b": 1, f"F{self.flow1.id}|segment:a:c": 4}
        )

        Flow.objects.filter(id=self.flow3.id).update(is_active=False)

    @cleanup(valkey=True)
    def test_migration(self):
        def expires(day: date) -> date:
            return day + timedelta(days=365)

        self.assertEqual(
            {
                ("segment:a:b", 12, None),  # 13 counted, of which 1 is still in Valkey
                ("segment:c:d", 6, None),
                ("msgsin:hour:7", 6, None),
                (f"msgsin:date:{self.yesterday}", 7, expires(self.yesterday)),
                (f"msgsin:date:{self.today}", 8, expires(self.today)),
            },
            set(self.flow1.tallies.values_list("scope", "count", "expires_on")),
        )
        self.assertEqual({("segment:a:b", 12)}, set(self.flow2.tallies.values_list("scope", "count")))
        self.assertFalse(self.flow3.tallies.exists())
