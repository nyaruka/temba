from datetime import date, datetime, timedelta, timezone as tzone

from openpyxl import load_workbook

from django.core.files.storage import default_storage
from django.utils import timezone

from temba.contacts.models import ContactField, ContactURN
from temba.tests import TembaTest
from temba.tickets.models import Ticket, TicketExport, Topic


class TicketExportTest(TembaTest):
    def _export(self, start_date: date, end_date: date, with_fields=(), with_groups=()):
        export = TicketExport.create(
            self.org,
            self.admin,
            start_date=start_date,
            end_date=end_date,
            with_fields=with_fields,
            with_groups=with_groups,
        )
        export.perform()

        workbook = load_workbook(filename=default_storage.open(f"orgs/{self.org.id}/ticket_exports/{export.uuid}.xlsx"))
        return workbook.worksheets, export

    def test_export_empty(self):
        # check results of sheet in workbook (no Contact ID column)
        sheets, export = self._export(start_date=date.today() - timedelta(days=7), end_date=date.today())
        self.assertExcelSheet(
            sheets[0],
            [
                [
                    "UUID",
                    "Opened On",
                    "Closed On",
                    "Topic",
                    "Assigned To",
                    "Contact UUID",
                    "Contact Name",
                    "URN Scheme",
                    "URN Value",
                ]
            ],
            tz=self.org.timezone,
        )

        with self.anonymous(self.org):
            # anon org doesn't see URN value column
            sheets, export = self._export(start_date=date.today() - timedelta(days=7), end_date=date.today())
            self.assertExcelSheet(
                sheets[0],
                [
                    [
                        "UUID",
                        "Opened On",
                        "Closed On",
                        "Topic",
                        "Assigned To",
                        "Contact UUID",
                        "Contact Name",
                        "URN Scheme",
                        "Anon Value",
                    ]
                ],
                tz=self.org.timezone,
            )

    def test_export(self):
        gender = self.create_field("gender", "Gender")
        age = self.create_field("age", "Age", value_type=ContactField.TYPE_NUMBER)

        # messages can't be older than org
        self.org.created_on = datetime(2016, 1, 2, 10, tzinfo=tzone.utc)
        self.org.save(update_fields=("created_on",))

        topic = Topic.create(self.org, self.admin, "AFC Richmond")
        assignee = self.admin
        today = timezone.now().astimezone(self.org.timezone).date()

        # create a contact with no urns
        nate = self.create_contact("Nathan Shelley", fields={"gender": "Male"})

        # create a contact with one urn
        jamie = self.create_contact(
            "Jamie Tartt", urns=["twitter:jamietarttshark"], fields={"gender": "Male", "age": 25}
        )

        # create a contact with multiple urns that have different max priority
        roy = self.create_contact(
            "Roy Kent", urns=["tel:+12345678900", "twitter:roykent"], fields={"gender": "Male", "age": 41}
        )

        # create a contact with multiple urns that have the same max priority
        sam = self.create_contact(
            "Sam Obisanya", urns=["twitter:nigerianprince", "tel:+9876543210"], fields={"gender": "Male", "age": 22}
        )
        sam.urns.update(priority=50)

        testers = self.create_group("Testers", contacts=[nate, roy])

        # create an open ticket for nate, opened 30 days ago
        ticket1 = self.create_ticket(
            nate, topic=topic, assignee=assignee, opened_on=timezone.now() - timedelta(days=30)
        )
        # create an open ticket for jamie, opened 25 days ago
        ticket2 = self.create_ticket(
            jamie, topic=topic, assignee=assignee, opened_on=timezone.now() - timedelta(days=25)
        )

        # create a closed ticket for roy, opened yesterday
        ticket3 = self.create_ticket(
            roy, topic=topic, assignee=assignee, opened_on=timezone.now() - timedelta(days=1), closed_on=timezone.now()
        )
        # create a closed ticket for sam, opened today
        ticket4 = self.create_ticket(
            sam, topic=topic, assignee=assignee, opened_on=timezone.now(), closed_on=timezone.now()
        )

        # create a ticket on another org for rebecca
        self.create_ticket(self.create_contact("Rebecca", urns=["twitter:rwaddingham"], org=self.org2))

        # check requesting export for last 90 days
        with self.mockReadOnly(assert_models={Ticket, ContactURN}):
            with self.assertNumQueries(18):
                sheets, export = self._export(start_date=today - timedelta(days=90), end_date=today)

        expected_headers = [
            "UUID",
            "Opened On",
            "Closed On",
            "Topic",
            "Assigned To",
            "Contact UUID",
            "Contact Name",
            "URN Scheme",
            "URN Value",
        ]

        self.assertExcelSheet(
            sheets[0],
            rows=[
                expected_headers,
                [
                    ticket1.uuid,
                    ticket1.opened_on,
                    "",
                    ticket1.topic.name,
                    ticket1.assignee.email,
                    ticket1.contact.uuid,
                    "Nathan Shelley",
                    "",
                    "",
                ],
                [
                    ticket2.uuid,
                    ticket2.opened_on,
                    "",
                    ticket2.topic.name,
                    ticket2.assignee.email,
                    ticket2.contact.uuid,
                    "Jamie Tartt",
                    "twitter",
                    "jamietarttshark",
                ],
                [
                    ticket3.uuid,
                    ticket3.opened_on,
                    ticket3.closed_on,
                    ticket3.topic.name,
                    ticket3.assignee.email,
                    ticket3.contact.uuid,
                    "Roy Kent",
                    "tel",
                    "+12345678900",
                ],
                [
                    ticket4.uuid,
                    ticket4.opened_on,
                    ticket4.closed_on,
                    ticket4.topic.name,
                    ticket4.assignee.email,
                    ticket4.contact.uuid,
                    "Sam Obisanya",
                    "twitter",
                    "nigerianprince",
                ],
            ],
            tz=self.org.timezone,
        )

        # check requesting export for last 7 days
        with self.mockReadOnly(assert_models={Ticket, ContactURN}):
            sheets, export = self._export(start_date=today - timedelta(days=7), end_date=today)

        self.assertExcelSheet(
            sheets[0],
            rows=[
                expected_headers,
                [
                    ticket3.uuid,
                    ticket3.opened_on,
                    ticket3.closed_on,
                    ticket3.topic.name,
                    ticket3.assignee.email,
                    ticket3.contact.uuid,
                    "Roy Kent",
                    "tel",
                    "+12345678900",
                ],
                [
                    ticket4.uuid,
                    ticket4.opened_on,
                    ticket4.closed_on,
                    ticket4.topic.name,
                    ticket4.assignee.email,
                    ticket4.contact.uuid,
                    "Sam Obisanya",
                    "twitter",
                    "nigerianprince",
                ],
            ],
            tz=self.org.timezone,
        )

        # check requesting with contact fields and groups
        with self.mockReadOnly(assert_models={Ticket, ContactURN}):
            sheets, export = self._export(
                start_date=today - timedelta(days=7), end_date=today, with_fields=(age, gender), with_groups=(testers,)
            )

        self.assertExcelSheet(
            sheets[0],
            rows=[
                expected_headers + ["Field:Age", "Field:Gender", "Group:Testers"],
                [
                    ticket3.uuid,
                    ticket3.opened_on,
                    ticket3.closed_on,
                    ticket3.topic.name,
                    ticket3.assignee.email,
                    ticket3.contact.uuid,
                    "Roy Kent",
                    "tel",
                    "+12345678900",
                    "41",
                    "Male",
                    True,
                ],
                [
                    ticket4.uuid,
                    ticket4.opened_on,
                    ticket4.closed_on,
                    ticket4.topic.name,
                    ticket4.assignee.email,
                    ticket4.contact.uuid,
                    "Sam Obisanya",
                    "twitter",
                    "nigerianprince",
                    "22",
                    "Male",
                    False,
                ],
            ],
            tz=self.org.timezone,
        )

        with self.anonymous(self.org):
            with self.mockReadOnly(assert_models={Ticket, ContactURN}):
                sheets, export = self._export(start_date=today - timedelta(days=90), end_date=today)
            self.assertExcelSheet(
                sheets[0],
                [
                    [
                        "UUID",
                        "Opened On",
                        "Closed On",
                        "Topic",
                        "Assigned To",
                        "Contact UUID",
                        "Contact Name",
                        "URN Scheme",
                        "Anon Value",
                    ],
                    [
                        ticket1.uuid,
                        ticket1.opened_on,
                        "",
                        ticket1.topic.name,
                        ticket1.assignee.email,
                        ticket1.contact.uuid,
                        "Nathan Shelley",
                        "",
                        ticket1.contact.ref,
                    ],
                    [
                        ticket2.uuid,
                        ticket2.opened_on,
                        "",
                        ticket2.topic.name,
                        ticket2.assignee.email,
                        ticket2.contact.uuid,
                        "Jamie Tartt",
                        "twitter",
                        ticket2.contact.ref,
                    ],
                    [
                        ticket3.uuid,
                        ticket3.opened_on,
                        ticket3.closed_on,
                        ticket3.topic.name,
                        ticket3.assignee.email,
                        ticket3.contact.uuid,
                        "Roy Kent",
                        "tel",
                        ticket3.contact.ref,
                    ],
                    [
                        ticket4.uuid,
                        ticket4.opened_on,
                        ticket4.closed_on,
                        ticket4.topic.name,
                        ticket4.assignee.email,
                        ticket4.contact.uuid,
                        "Sam Obisanya",
                        "twitter",
                        ticket4.contact.ref,
                    ],
                ],
                tz=self.org.timezone,
            )
