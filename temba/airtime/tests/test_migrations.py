from datetime import datetime, timezone as tzone
from decimal import Decimal

from temba.airtime.models import AirtimeTransfer
from temba.tests import MigrationTest, cleanup
from temba.utils import dynamo


class UpdateTransferUUIDsTest(MigrationTest):
    app = "airtime"
    migrate_from = "0037_squashed"
    migrate_to = "0038_update_transfer_uuids"

    def setUpBeforeMigration(self, apps):
        contact = self.create_contact("Ann")

        self.transfer1 = AirtimeTransfer.objects.create(
            uuid="47f26cfc-f3f2-4e13-bea9-36555aaf7cea",
            org=self.org,
            status="S",
            contact=contact,
            recipient="tel:+250700000003",
            currency="RWF",
            desired_amount="1100",
            actual_amount="1000",
            created_on=datetime(2025, 8, 11, 20, 36, 41, 114764, tzinfo=tzone.utc),
        )
        self.transfer2 = AirtimeTransfer.objects.create(
            uuid="01989ad9-7c1a-7b8d-a59e-141c265730dc",
            org=self.org,
            status="F",
            sender="tel:+250700000002",
            contact=contact,
            recipient="tel:+250700000003",
            currency="USD",
            desired_amount="1100",
            actual_amount="0",
            created_on=datetime(2025, 8, 11, 20, 36, 41, 116000, tzinfo=tzone.utc),
        )

    def test_migration(self):
        self.transfer1.refresh_from_db()
        self.transfer2.refresh_from_db()

        self.assertTrue(str(self.transfer1.uuid).startswith("01989ad9-7c1a-7"))
        self.assertEqual("01989ad9-7c1a-7b8d-a59e-141c265730dc", str(self.transfer2.uuid))  # unchanged


class WriteTransferEventsTest(MigrationTest):
    app = "airtime"
    migrate_from = "0038_update_transfer_uuids"
    migrate_to = "0039_write_transfer_events"

    def setUpBeforeMigration(self, apps):
        contact = self.create_contact("Ann", uuid="40248365-230d-4a29-8dbc-c89e43dd3adf")
        deleted = self.create_contact("Deleted", uuid="1d48402f-df4c-44d8-b648-e0180f6a0dd2", is_active=False)

        self.transfer1 = AirtimeTransfer.objects.create(
            uuid="0198a01f-5b93-7763-8713-84ef3748062f",
            org=self.org,
            status="S",
            contact=contact,
            recipient="tel:+250700000003",
            currency="RWF",
            desired_amount="1100",
            actual_amount="1000",
            created_on=datetime(2025, 8, 11, 20, 36, 41, 114764, tzinfo=tzone.utc),
        )
        self.transfer2 = AirtimeTransfer.objects.create(
            uuid="0198a01f-81fd-7ed3-8206-595dc09d152f",
            org=self.org,
            status="F",
            sender="tel:+250700000002",
            contact=contact,
            recipient="tel:+250700000003",
            currency="USD",
            desired_amount="1100",
            actual_amount="0",
            created_on=datetime(2025, 8, 11, 20, 36, 41, 116000, tzinfo=tzone.utc),
        )
        self.transfer3 = AirtimeTransfer.objects.create(
            uuid="0198a01f-daf2-7acc-bd3c-6a3803e92e20",
            org=self.org,
            status="S",
            sender="tel:+250700000002",
            contact=deleted,
            recipient="tel:+250700000003",
            currency="USD",
            desired_amount="1100",
            actual_amount="1000",
            created_on=datetime(2025, 8, 11, 20, 36, 41, 116000, tzinfo=tzone.utc),
        )

    @cleanup(dynamodb=True)
    def test_migration(self):
        items = dynamo.batch_get(
            dynamo.HISTORY,
            [
                ("con#40248365-230d-4a29-8dbc-c89e43dd3adf", "evt#0198a01f-5b93-7763-8713-84ef3748062f"),
                ("con#40248365-230d-4a29-8dbc-c89e43dd3adf", "evt#0198a01f-81fd-7ed3-8206-595dc09d152f"),
                ("con#1d48402f-df4c-44d8-b648-e0180f6a0dd2", "evt#0198a01f-daf2-7acc-bd3c-6a3803e92e20"),  # not written
            ],
        )
        self.assertEqual(
            [
                {
                    "PK": "con#40248365-230d-4a29-8dbc-c89e43dd3adf",
                    "SK": "evt#0198a01f-5b93-7763-8713-84ef3748062f",
                    "OrgID": Decimal(self.org.id),
                    "Data": {
                        "type": "airtime_transferred",
                        "amount": Decimal("1000.00"),
                        "created_on": "2025-08-11T20:36:41.114764+00:00",
                        "currency": "RWF",
                        "external_id": None,
                        "recipient": "tel:+250700000003",
                        "sender": None,
                    },
                },
                {
                    "PK": "con#40248365-230d-4a29-8dbc-c89e43dd3adf",
                    "SK": "evt#0198a01f-81fd-7ed3-8206-595dc09d152f",
                    "OrgID": Decimal(self.org.id),
                    "Data": {
                        "type": "airtime_transferred",
                        "amount": Decimal("0.00"),
                        "created_on": "2025-08-11T20:36:41.116000+00:00",
                        "currency": "USD",
                        "external_id": None,
                        "recipient": "tel:+250700000003",
                        "sender": "tel:+250700000002",
                    },
                },
            ],
            items,
        )
