from temba.tests import MigrationTest


class BackfillCurrentFlowUUIDTest(MigrationTest):
    app = "contacts"
    migrate_from = "0229_contact_current_flow_uuid"
    migrate_to = "0230_backfill_contact_current_flow_uuid"

    def setUpBeforeMigration(self, apps):
        self.flow1 = self.create_flow("Flow 1")
        self.flow2 = self.create_flow("Flow 2")

        self.contact1 = self.create_contact("Ann", phone="+16055741111")  # in a flow, no uuid
        self.contact2 = self.create_contact("Bob", phone="+16055742222")  # in a flow, uuid already written
        self.contact3 = self.create_contact("Cat", phone="+16055743333")  # not in a flow

        self.contact1.current_flow = self.flow1
        self.contact1.save(update_fields=("current_flow",))

        self.contact2.current_flow = self.flow2
        self.contact2.current_flow_uuid = self.flow1.uuid  # differs from its flow so we can tell it wasn't overwritten
        self.contact2.save(update_fields=("current_flow", "current_flow_uuid"))

    def test_migration(self):
        self.contact1.refresh_from_db()
        self.contact2.refresh_from_db()
        self.contact3.refresh_from_db()

        self.assertEqual(self.flow1.uuid, self.contact1.current_flow_uuid)
        self.assertEqual(self.flow1.uuid, self.contact2.current_flow_uuid)
        self.assertIsNone(self.contact3.current_flow_uuid)
