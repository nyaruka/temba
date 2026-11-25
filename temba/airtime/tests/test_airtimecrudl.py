from django.urls import reverse

from temba.airtime.models import AirtimeTransfer, AirtimeTransferLog
from temba.tests import CRUDLTestMixin, TembaTest, cleanup


class AirtimeCRUDLTest(TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        contact = self.create_contact("Ben Haggerty", phone="+250700000003")

        self.transfer1 = AirtimeTransfer.objects.create(
            org=self.org,
            status=AirtimeTransfer.STATUS_COMPLETED,
            contact=contact,
            recipient="tel:+250700000003",
            currency="RWF",
            desired_amount="1100",
            actual_amount="1000",
        )
        # a rejected transfer has no currency or actual amount
        self.transfer2 = AirtimeTransfer.objects.create(
            org=self.org,
            status=AirtimeTransfer.STATUS_REJECTED,
            sender="tel:+250700000002",
            contact=contact,
            recipient="tel:+250700000003",
            currency=None,
            desired_amount="1100",
            actual_amount="0",
        )

        # and a transfer for a different org
        self.other_org_transfer = AirtimeTransfer.objects.create(
            org=self.org2,
            status=AirtimeTransfer.STATUS_COMPLETED,
            contact=self.create_contact("Frank", phone="+12065552021", org=self.org2),
            recipient="tel:+12065552021",
            currency="USD",
            desired_amount="1",
            actual_amount="1",
        )

    def test_list(self):
        list_url = reverse("airtime.airtimetransfer_list")

        self.assertRequestDisallowed(list_url, [None, self.agent])
        response = self.assertListFetch(
            list_url, [self.editor, self.admin], context_objects=[self.transfer2, self.transfer1]
        )
        self.assertContains(response, "Ben Haggerty")
        self.assertContains(response, "+250 700 000 003")
        self.assertContains(response, "Completed")
        self.assertContains(response, "Rejected")
        self.assertContains(response, "--")  # unset currency/amount

        with self.anonymous(self.org):
            response = self.requestView(list_url, self.admin)

            self.assertContains(response, "Ben Haggerty")
            self.assertNotContains(response, "+250 700 000 003")

    @cleanup(dynamodb=True)
    def test_read(self):
        read_url = reverse("airtime.airtimetransfer_read", args=[self.transfer1.uuid])

        self.assertRequestDisallowed(read_url, [None, self.agent, self.admin2])
        response = self.assertReadFetch(read_url, [self.editor, self.admin], context_object=self.transfer1)
        self.assertContains(response, "Ben Haggerty")
        self.assertContains(response, "+250 700 000 003")
        self.assertTrue(response.context["show_logs"])
        self.assertEqual([], response.context["logs"])
        self.assertContains(response, "Logs are kept for 7 days.")

        self.create_airtime_log(
            self.transfer1,
            AirtimeTransferLog.TYPE_CREATE,
            http_logs=[
                {
                    "url": "https://dvs-api.dtone.com/v1/transactions",
                    "status_code": 200,
                    "request": "POST /v1/transactions HTTP/1.1\r\n\r\n{}",
                    "response": 'HTTP/1.1 200 OK\r\n\r\n{"id": 2237512891}',
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2026-11-25T12:00:00Z",
                }
            ],
        )
        self.create_airtime_log(
            self.transfer1,
            AirtimeTransferLog.TYPE_CONFIRM,
            errors=[{"code": "provider_error", "ext_code": "", "message": "Insufficient balance"}],
        )
        self.create_airtime_log(self.transfer1, AirtimeTransferLog.TYPE_CONFIRM, org=self.org2)  # wrong org, ignored
        self.create_airtime_log(self.transfer2, AirtimeTransferLog.TYPE_CREATE)  # other transfer

        response = self.requestView(read_url, self.admin)
        logs = response.context["logs"]
        self.assertEqual(2, len(logs))
        self.assertEqual("Create Transfer", logs[0]["type_display"])
        self.assertFalse(logs[0]["is_error"])
        self.assertEqual(1, len(logs[0]["http_logs"]))
        self.assertEqual("Confirm Transfer", logs[1]["type_display"])
        self.assertTrue(logs[1]["is_error"])
        self.assertContains(response, "https://dvs-api.dtone.com/v1/transactions")
        self.assertContains(response, "Insufficient balance")

        with self.anonymous(self.org):
            response = self.requestView(read_url, self.admin)

            self.assertContains(response, "Ben Haggerty")
            self.assertNotContains(response, "+250 700 000 003")
            self.assertFalse(response.context["show_logs"])
            self.assertEqual([], response.context["logs"])
            self.assertNotContains(response, "Insufficient balance")

            # staff can still see the logs
            response = self.requestView(read_url, self.customer_support, choose_org=self.org)
            self.assertTrue(response.context["show_logs"])
            self.assertEqual(2, len(response.context["logs"]))
