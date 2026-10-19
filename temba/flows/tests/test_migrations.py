from temba.flows.models import Flow
from temba.tests import MigrationTest


class RenameReservedFlowsTest(MigrationTest):
    app = "flows"
    migrate_from = "0412_audit_fields_cleanup"
    migrate_to = "0413_rename_reserved_flows"

    def setUpBeforeMigration(self, apps):
        self.flow1 = self.create_flow("Flow 1")
        self.flow2 = self.create_flow("Ticket 2")
        self.flow3 = self.create_flow("Tickets")
        self.flow4 = self.create_flow("Flow 4", org=self.org2)
        self.flow5 = self.create_flow("Flow 5", org=self.org2)

        # bypass name validation to give flows reserved names
        Flow.objects.filter(id=self.flow1.id).update(name="Ticket")
        Flow.objects.filter(id=self.flow4.id).update(name="TICKET")
        Flow.objects.filter(id=self.flow5.id).update(name="ticket 2", is_active=False)

    def test_migration(self):
        def assert_name(flow, expected):
            flow.refresh_from_db()
            self.assertEqual(expected, flow.name)

        assert_name(self.flow1, "Ticket 3")
        assert_name(self.flow2, "Ticket 2")
        assert_name(self.flow3, "Tickets")
        assert_name(self.flow4, "TICKET 3")  # name taken by deleted flow is skipped
        assert_name(self.flow5, "ticket 2")
