from django.urls import reverse

from temba.airtime.models import AirtimeTransfer
from temba.tests import CRUDLTestMixin, TembaTest


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

    def test_read(self):
        read_url = reverse("airtime.airtimetransfer_read", args=[self.transfer1.uuid])

        self.assertRequestDisallowed(read_url, [None, self.agent, self.admin2])
        response = self.assertReadFetch(read_url, [self.editor, self.admin], context_object=self.transfer1)
        self.assertContains(response, "Ben Haggerty")
        self.assertContains(response, "+250 700 000 003")
        self.assertTrue(response.context["show_logs"])

        with self.anonymous(self.org):
            response = self.requestView(read_url, self.admin)

            self.assertContains(response, "Ben Haggerty")
            self.assertNotContains(response, "+250 700 000 003")
            self.assertFalse(response.context["show_logs"])
