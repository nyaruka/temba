from datetime import date
from unittest.mock import call

from temba.contacts.models import Contact
from temba.orgs.models import OrgRole
from temba.orgs.tasks import squash_item_counts
from temba.tests import TembaTest, mock_mailroom
from temba.tickets.models import Team, Ticket, Topic, export_ticket_stats
from temba.utils.uuid import uuid7


class TicketTest(TembaTest):
    @mock_mailroom
    def test_model(self, mr_mocks):
        topic = Topic.create(self.org, self.admin, "Sales")
        contact = self.create_contact("Bob", urns=["twitter:bobby"])

        ticket = Ticket.objects.create(
            uuid=uuid7(),
            org=self.org,
            contact=contact,
            topic=self.org.default_topic,
            status="O",
        )

        self.assertEqual(f"Ticket[uuid={ticket.uuid}, topic=General]", str(ticket))

        # test bulk assignment
        Ticket.bulk_assign(self.org, self.admin, [ticket], self.agent)

        # test bulk un-assignment
        Ticket.bulk_assign(self.org, self.admin, [ticket], None)

        self.assertEqual(
            [
                call(self.org, self.admin, [ticket], self.agent, via="ui"),
                call(self.org, self.admin, [ticket], None, via="ui"),
            ],
            mr_mocks.calls["ticket_change_assignee"],
        )

        # test bulk adding a note
        Ticket.bulk_add_note(self.org, self.admin, [ticket], "please handle")

        self.assertEqual(
            [call(self.org, self.admin, [ticket], "please handle", via="ui")], mr_mocks.calls["ticket_add_note"]
        )

        # test bulk changing topic
        Ticket.bulk_change_topic(self.org, self.admin, [ticket], topic)

        self.assertEqual([call(self.org, self.admin, [ticket], topic, via="ui")], mr_mocks.calls["ticket_change_topic"])

        # test bulk closing
        Ticket.bulk_close(self.org, self.admin, [ticket])

        self.assertEqual([call(self.org, self.admin, [ticket], via="ui")], mr_mocks.calls["ticket_close"])

        # test bulk re-opening
        Ticket.bulk_reopen(self.org, self.admin, [ticket])

        self.assertEqual([call(self.org, self.admin, [ticket], via="ui")], mr_mocks.calls["ticket_reopen"])

    @mock_mailroom
    def test_counts(self, mr_mocks):
        general = self.org.default_topic
        cats = Topic.create(self.org, self.admin, "Cats")

        contact1 = self.create_contact("Bob", urns=["twitter:bobby"])
        contact2 = self.create_contact("Jim", urns=["twitter:jimmy"])

        org2_general = self.org2.default_topic
        org2_contact = self.create_contact("Bob", urns=["twitter:bobby"], org=self.org2)

        t1 = self.create_ticket(contact1, topic=general)
        t2 = self.create_ticket(contact2, topic=general)
        t3 = self.create_ticket(contact1, topic=general)
        t4 = self.create_ticket(contact2, topic=cats)
        t5 = self.create_ticket(contact1, topic=cats)
        t6 = self.create_ticket(org2_contact, topic=org2_general)

        def assert_counts(
            org, *, assignee_open: dict, assignee_closed: dict, topic_open: dict, topic_closed: dict, contacts: dict
        ):
            all_topics = org.topics.filter(is_active=True)
            assignees = [None] + list(org.get_users())

            self.assertEqual(
                assignee_open, {u: Ticket.get_assignee_count(org, u, all_topics, Ticket.STATUS_OPEN) for u in assignees}
            )
            self.assertEqual(
                assignee_closed,
                {u: Ticket.get_assignee_count(org, u, all_topics, Ticket.STATUS_CLOSED) for u in assignees},
            )

            self.assertEqual(sum(assignee_open.values()), Ticket.get_status_count(org, all_topics, Ticket.STATUS_OPEN))
            self.assertEqual(
                sum(assignee_closed.values()), Ticket.get_status_count(org, all_topics, Ticket.STATUS_CLOSED)
            )

            self.assertEqual(topic_open, Ticket.get_topic_counts(org, list(org.topics.all()), Ticket.STATUS_OPEN))
            self.assertEqual(topic_closed, Ticket.get_topic_counts(org, list(org.topics.all()), Ticket.STATUS_CLOSED))

            self.assertEqual(contacts, {c: Contact.objects.get(id=c.id).ticket_count for c in contacts})

        # t1:O/None/General t2:O/None/General t3:O/None/General t4:O/None/Cats t5:O/None/Cats t6:O/None/General
        assert_counts(
            self.org,
            assignee_open={None: 5, self.agent: 0, self.editor: 0, self.admin: 0},
            assignee_closed={None: 0, self.agent: 0, self.editor: 0, self.admin: 0},
            topic_open={general: 3, cats: 2},
            topic_closed={general: 0, cats: 0},
            contacts={contact1: 3, contact2: 2},
        )
        assert_counts(
            self.org2,
            assignee_open={None: 1, self.admin2: 0},
            assignee_closed={None: 0, self.admin2: 0},
            topic_open={org2_general: 1},
            topic_closed={org2_general: 0},
            contacts={org2_contact: 1},
        )

        Ticket.bulk_assign(self.org, self.admin, [t1, t2], assignee=self.agent)
        Ticket.bulk_assign(self.org, self.admin, [t3], assignee=self.editor)
        Ticket.bulk_assign(self.org2, self.admin2, [t6], assignee=self.admin2)

        # t1:O/Agent/General t2:O/Agent/General t3:O/Editor/General t4:O/None/Cats t5:O/None/Cats t6:O/Admin2/General
        assert_counts(
            self.org,
            assignee_open={None: 2, self.agent: 2, self.editor: 1, self.admin: 0},
            assignee_closed={None: 0, self.agent: 0, self.editor: 0, self.admin: 0},
            topic_open={general: 3, cats: 2},
            topic_closed={general: 0, cats: 0},
            contacts={contact1: 3, contact2: 2},
        )
        assert_counts(
            self.org2,
            assignee_open={None: 0, self.admin2: 1},
            assignee_closed={None: 0, self.admin2: 0},
            topic_open={org2_general: 1},
            topic_closed={org2_general: 0},
            contacts={org2_contact: 1},
        )

        Ticket.bulk_close(self.org, self.admin, [t1, t4])
        Ticket.bulk_close(self.org2, self.admin2, [t6])

        # t1:C/Agent/General t2:O/Agent/General t3:O/Editor/General t4:C/None/Cats t5:O/None/Cats t6:C/Admin2/General
        assert_counts(
            self.org,
            assignee_open={None: 1, self.agent: 1, self.editor: 1, self.admin: 0},
            assignee_closed={None: 1, self.agent: 1, self.editor: 0, self.admin: 0},
            topic_open={general: 2, cats: 1},
            topic_closed={general: 1, cats: 1},
            contacts={contact1: 2, contact2: 1},
        )
        assert_counts(
            self.org2,
            assignee_open={None: 0, self.admin2: 0},
            assignee_closed={None: 0, self.admin2: 1},
            topic_open={org2_general: 0},
            topic_closed={org2_general: 1},
            contacts={org2_contact: 0},
        )

        Ticket.bulk_assign(self.org, self.admin, [t1, t5], assignee=self.admin)

        # t1:C/Admin/General t2:O/Agent/General t3:O/Editor/General t4:C/None/Cats t5:O/Admin/Cats t6:C/Admin2/General
        assert_counts(
            self.org,
            assignee_open={None: 0, self.agent: 1, self.editor: 1, self.admin: 1},
            assignee_closed={None: 1, self.agent: 0, self.editor: 0, self.admin: 1},
            topic_open={general: 2, cats: 1},
            topic_closed={general: 1, cats: 1},
            contacts={contact1: 2, contact2: 1},
        )

        Ticket.bulk_reopen(self.org, self.admin, [t4])
        Ticket.bulk_change_topic(self.org, self.admin, [t1], cats)

        # t1:C/Admin/General t2:O/Agent/General t3:O/Editor/General t4:O/None/Cats t5:O/Admin/Cats t6:C/Admin2/General
        assert_counts(
            self.org,
            assignee_open={None: 1, self.agent: 1, self.editor: 1, self.admin: 1},
            assignee_closed={None: 0, self.agent: 0, self.editor: 0, self.admin: 1},
            topic_open={general: 2, cats: 2},
            topic_closed={general: 0, cats: 1},
            contacts={contact1: 2, contact2: 2},
        )

        squash_item_counts()  # shouldn't change counts

        assert_counts(
            self.org,
            assignee_open={None: 1, self.agent: 1, self.editor: 1, self.admin: 1},
            assignee_closed={None: 0, self.agent: 0, self.editor: 0, self.admin: 1},
            topic_open={general: 2, cats: 2},
            topic_closed={general: 0, cats: 1},
            contacts={contact1: 2, contact2: 2},
        )

        t1.delete()
        t2.delete()
        t6.delete()

        # t3:O/Editor/General t4:O/None/Cats t5:O/Admin/Cats
        assert_counts(
            self.org,
            assignee_open={None: 1, self.agent: 0, self.editor: 1, self.admin: 1},
            assignee_closed={None: 0, self.agent: 0, self.editor: 0, self.admin: 0},
            topic_open={general: 1, cats: 2},
            topic_closed={general: 0, cats: 0},
            contacts={contact1: 2, contact2: 1},
        )
        assert_counts(
            self.org2,
            assignee_open={None: 0, self.admin2: 0},
            assignee_closed={None: 0, self.admin2: 0},
            topic_open={org2_general: 0},
            topic_closed={org2_general: 0},
            contacts={org2_contact: 0},
        )

        squash_item_counts()

        # check count model raw values are consistent
        self.assertEqual(
            {
                f"tickets:O:{general.id}:{self.editor.id}": 1,
                f"tickets:O:{cats.id}:0": 1,
                f"tickets:O:{cats.id}:{self.admin.id}": 1,
            },
            {c["scope"]: c["count"] for c in self.org.counts.order_by("scope").values("scope", "count")},
        )

    def test_export_ticket_stats(self):
        sales = Team.create(self.org, self.admin, "Sales")
        self.org.add_user(self.agent, OrgRole.AGENT, team=sales)
        self.org.add_user(self.editor, OrgRole.AGENT, team=sales)

        self.org.daily_counts.create(day=date(2022, 4, 30), scope="tickets:opened:0", count=1)
        self.org.daily_counts.create(day=date(2022, 5, 3), scope="tickets:opened:1", count=1)
        self.org.daily_counts.create(day=date(2022, 5, 3), scope=f"tickets:assigned:0:{self.admin.id}", count=1)
        self.org.daily_counts.create(day=date(2022, 5, 3), scope=f"msgs:ticketreplies:0:{self.admin.id}", count=1)

        self.org.daily_counts.create(
            day=date(2022, 5, 4), scope=f"msgs:ticketreplies:{sales.id}:{self.editor.id}", count=1
        )
        self.org.daily_counts.create(
            day=date(2022, 5, 4), scope=f"msgs:ticketreplies:{sales.id}:{self.agent.id}", count=1
        )

        self.org.daily_counts.create(day=date(2022, 5, 5), scope=f"msgs:ticketreplies:0:{self.admin.id}", count=1)
        self.org.daily_counts.create(day=date(2022, 5, 5), scope=f"msgs:ticketreplies:0:{self.admin.id}", count=1)
        self.org.daily_counts.create(day=date(2022, 5, 5), scope="tickets:opened:0", count=1)
        self.org.daily_counts.create(
            day=date(2022, 5, 5), scope=f"msgs:ticketreplies:{sales.id}:{self.agent.id}", count=1
        )

        def _record_first_reply(org, user, d: date, seconds: int):
            org.daily_counts.create(day=d, scope=f"ticketresptime:0:{user.id}:total", count=seconds)
            org.daily_counts.create(day=d, scope=f"ticketresptime:0:{user.id}:count", count=1)

        _record_first_reply(self.org, self.admin, date(2022, 4, 30), 60)
        _record_first_reply(self.org, self.admin, date(2022, 5, 1), 60)
        _record_first_reply(self.org, self.admin, date(2022, 5, 1), 120)
        _record_first_reply(self.org, self.admin, date(2022, 5, 1), 180)
        _record_first_reply(self.org, self.admin, date(2022, 5, 2), 11)
        _record_first_reply(self.org, self.admin, date(2022, 5, 2), 70)

        workbook = export_ticket_stats(self.org, date(2022, 4, 30), date(2022, 5, 6))
        self.assertEqual(["Tickets"], workbook.sheetnames)
        self.assertExcelRow(
            workbook.active, 1, ["", "Opened", "Replies", "Reply Time (Secs)"] + ["Assigned", "Replies"] * 3
        )
        self.assertExcelRow(workbook.active, 2, [date(2022, 4, 30), 1, 0, 60, 0, 0, 0, 0, 0, 0])
        self.assertExcelRow(workbook.active, 3, [date(2022, 5, 1), 0, 0, 120, 0, 0, 0, 0, 0, 0])
        self.assertExcelRow(workbook.active, 4, [date(2022, 5, 2), 0, 0, 40, 0, 0, 0, 0, 0, 0])
        self.assertExcelRow(workbook.active, 5, [date(2022, 5, 3), 1, 1, "", 1, 1, 0, 0, 0, 0])
        self.assertExcelRow(workbook.active, 6, [date(2022, 5, 4), 0, 2, "", 0, 0, 0, 1, 0, 1])
        self.assertExcelRow(workbook.active, 7, [date(2022, 5, 5), 1, 3, "", 0, 2, 0, 1, 0, 0])
