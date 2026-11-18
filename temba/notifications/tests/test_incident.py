from datetime import datetime, timedelta, timezone as tzone
from unittest.mock import patch

from django.core import mail
from django.utils import timezone

from temba.notifications.incidents.builtin import (
    ChannelDisconnectedIncidentType,
    OrgFlaggedIncidentType,
    OrgSuspendedIncidentType,
)
from temba.notifications.models import Incident, Notification
from temba.notifications.tasks import send_incident_reminders, send_notification_emails
from temba.orgs.models import Org
from temba.tests import TembaTest, matchers


class IncidentTest(TembaTest):
    def test_create(self):
        # we use a unique constraint to enforce uniqueness on org+type+scope for ongoing incidents which allows use of
        # INSERT .. ON CONFLICT DO NOTHING
        incident1 = Incident.get_or_create(self.org, "org:flagged", scope="scope1")

        # try to create another for the same scope
        incident2 = Incident.get_or_create(self.org, "org:flagged", scope="scope1")

        # different scope
        incident3 = Incident.get_or_create(self.org, "org:flagged", scope="scope2")

        self.assertEqual(incident1, incident2)
        self.assertNotEqual(incident1, incident3)

        # each created incident creates a notification for the workspace admin
        self.assertEqual(2, Notification.objects.count())
        self.assertEqual(1, incident1.notifications.count())
        self.assertEqual(1, incident2.notifications.count())

        # check that once incident 1 ends, new incidents can be created for same scope
        incident1.end()

        incident4 = Incident.get_or_create(self.org, "org:flagged", scope="scope1")

        self.assertNotEqual(incident1, incident4)
        self.assertEqual(3, Notification.objects.count())
        self.assertEqual(1, incident4.notifications.count())

    def test_org_flagged(self):
        self.org.flag()

        incident = Incident.objects.get()
        self.assertEqual("org:flagged", incident.incident_type)
        self.assertEqual({self.admin}, set(n.user for n in incident.notifications.all()))

        self.assertEqual(
            {"type": "org:flagged", "started_on": matchers.ISODatetime(), "ended_on": None}, incident.as_json()
        )

        self.org.unflag()

        incident = Incident.objects.get()  # still only have 1 incident, but now it has ended
        self.assertEqual("org:flagged", incident.incident_type)
        self.assertIsNotNone(incident.ended_on)

    def test_org_suspended(self):
        self.org.suspend()

        incident = Incident.objects.get()
        self.assertEqual("org:suspended", incident.incident_type)
        self.assertEqual({self.admin}, set(n.user for n in incident.notifications.all()))

        self.assertEqual(
            {"type": "org:suspended", "started_on": matchers.ISODatetime(), "ended_on": None}, incident.as_json()
        )

        self.org.reactivate()

        incident = Incident.objects.get()  # still only have 1 incident, but now it has ended
        self.assertEqual("org:suspended", incident.incident_type)
        self.assertIsNotNone(incident.ended_on)

        reasons = {
            "B": "Your workspace has been suspended because of a problem with billing.",
            "L": "Your workspace has been suspended because it has exceeded the limits of its plan.",
            "S": "Your workspace has been suspended.",
        }

        for reason, text in reasons.items():
            send_notification_emails()
            mail.outbox.clear()
            self.org.suspend(reason)
            send_notification_emails()

            self.assertEqual(1, len(mail.outbox))
            self.assertEqual("[Nyaruka] Incident: Workspace Suspended", mail.outbox[0].subject)
            self.assertIn(text, mail.outbox[0].body)
            self.assertIn("including those started by triggers and campaigns", mail.outbox[0].body)
            self.assertIn("including those started by triggers and campaigns", mail.outbox[0].alternatives[0][0])

            self.org.reactivate()

    def test_org_restricted(self):
        suspends_on = datetime(2026, 12, 1, 12, 0, 0, tzinfo=tzone.utc)
        reasons = {
            "B": "Your workspace has been restricted because of a problem with billing.",
            "L": "Your workspace has been restricted because it has exceeded the limits of its plan.",
            "S": "Your workspace has been restricted.",
        }

        for reason, text in reasons.items():
            mail.outbox.clear()
            self.org.restrict(reason, suspends_on=suspends_on)

            incident = Incident.objects.get(incident_type="org:restricted", ended_on=None)
            self.assertEqual(suspends_on, incident.type.get_deadline(incident))
            self.assertEqual({self.admin}, set(n.user for n in incident.notifications.all()))

            send_notification_emails()

            self.assertEqual(1, len(mail.outbox))
            self.assertEqual("[Nyaruka] Incident: Workspace Restricted", mail.outbox[0].subject)
            self.assertIn(text, mail.outbox[0].body)
            self.assertIn("your flows will keep handling incoming messages", mail.outbox[0].body)
            self.assertIn("your workspace will be suspended on Dec. 1, 2026", mail.outbox[0].body)
            self.assertIn("your workspace will be suspended on Dec. 1, 2026", mail.outbox[0].alternatives[0][0])
            self.assertIn("which stops all of its flows", mail.outbox[0].body)

            self.org.reactivate()

            incident.refresh_from_db()
            self.assertIsNotNone(incident.ended_on)

        # admins are reminded a week and two days before suspension
        suspends_on = timezone.now() + Org.RESTRICTION_PERIOD
        self.org.restrict(Org.RESTRICTED_BILLING, suspends_on=suspends_on)
        send_notification_emails()
        mail.outbox.clear()

        for days in (7, 2):
            with patch("django.utils.timezone.now", return_value=suspends_on - timedelta(days=days, hours=-1)):
                self.assertEqual({"sent": 1}, send_incident_reminders())

            send_notification_emails()

        self.assertEqual(
            ["[Nyaruka] Reminder: Workspace Restricted", "[Nyaruka] Reminder: Workspace Restricted"],
            [m.subject for m in mail.outbox],
        )

    def test_reminders(self):
        t0 = datetime(2026, 11, 1, 12, 0, 0, tzinfo=tzone.utc)
        deadlines = {}

        def suspend(org, started_on):
            org.suspend()
            incident = org.incidents.get(incident_type="org:suspended", ended_on=None)
            incident.started_on = started_on
            incident.save(update_fields=("started_on",))
            deadlines[incident.id] = started_on + timedelta(days=14)
            return incident

        def send_reminders(now) -> dict:
            with patch("django.utils.timezone.now", return_value=now):
                return send_incident_reminders()

        def reminder_scopes(incident) -> list:
            return list(
                incident.notifications.filter(notification_type="incident:reminder")
                .order_by("id")
                .values_list("scope", flat=True)
            )

        # types without a deadline never have a due reminder
        flagged = OrgFlaggedIncidentType.get_or_create(self.org)
        self.assertIsNone(OrgFlaggedIncidentType().get_due_reminder(flagged, t0))
        flagged.end()

        with (
            patch.object(OrgSuspendedIncidentType, "reminders", (timedelta(days=7), timedelta(days=2))),
            patch.object(OrgSuspendedIncidentType, "get_deadline", lambda self, i: deadlines[i.id]),
        ):
            incident1 = suspend(self.org, t0)
            send_notification_emails()  # send the started emails

            # nothing due yet
            self.assertEqual({"sent": 0}, send_reminders(t0 + timedelta(days=3)))
            self.assertEqual([], reminder_scopes(incident1))

            # first reminder due 7 days before the deadline
            self.assertEqual({"sent": 1}, send_reminders(t0 + timedelta(days=7, hours=1)))
            self.assertEqual([f"{incident1.id}:604800"], reminder_scopes(incident1))

            reminder = incident1.notifications.get(notification_type="incident:reminder")
            self.assertEqual(self.admin, reminder.user)
            self.assertEqual(Notification.MEDIUM_EMAIL, reminder.medium)
            self.assertTrue(reminder.is_seen)
            self.assertEqual(Notification.EMAIL_STATUS_PENDING, reminder.email_status)

            # and only sent once
            self.assertEqual({"sent": 0}, send_reminders(t0 + timedelta(days=7, hours=2)))

            mail.outbox.clear()
            send_notification_emails()

            self.assertEqual(1, len(mail.outbox))
            self.assertEqual("[Nyaruka] Reminder: Workspace Suspended", mail.outbox[0].subject)
            self.assertEqual(["admin@textit.com"], mail.outbox[0].recipients())
            self.assertIn("Your workspace has been suspended.", mail.outbox[0].body)

            # templates can say when the deadline is
            reminder.refresh_from_db()
            context = reminder.type.get_email_context(reminder, self.org.branding)
            self.assertEqual(t0 + timedelta(days=14), context["deadline"])

            # sent emails don't make it look unsent
            self.assertEqual({"sent": 0}, send_reminders(t0 + timedelta(days=7, hours=3)))

            # second reminder due 2 days before the deadline
            self.assertEqual({"sent": 1}, send_reminders(t0 + timedelta(days=12, hours=1)))
            self.assertEqual([f"{incident1.id}:604800", f"{incident1.id}:172800"], reminder_scopes(incident1))

            # nothing once the deadline has passed
            self.assertEqual({"sent": 0}, send_reminders(t0 + timedelta(days=15)))

            # or once the incident has ended
            self.org.reactivate()
            self.assertEqual({"sent": 0}, send_reminders(t0 + timedelta(days=12, hours=2)))

            # an incident that started within a week of its deadline skips the reminder that fell due before then
            incident2 = suspend(self.org2, t0 + timedelta(days=1))
            deadlines[incident2.id] = t0 + timedelta(days=6)

            self.assertEqual({"sent": 0}, send_reminders(t0 + timedelta(days=2)))
            self.assertEqual({"sent": 1}, send_reminders(t0 + timedelta(days=4, hours=1)))
            self.assertEqual([f"{incident2.id}:172800"], reminder_scopes(incident2))

            self.org2.reactivate()

            # a reminder isn't sent more than a day after it fell due
            incident3 = suspend(self.org, t0)

            self.assertEqual({"sent": 0}, send_reminders(t0 + timedelta(days=9)))
            self.assertEqual({"sent": 1}, send_reminders(t0 + timedelta(days=12, hours=1)))
            self.assertEqual([f"{incident3.id}:172800"], reminder_scopes(incident3))

            self.org.reactivate()

            # or if it falls due within a day of the incident starting
            incident4 = suspend(self.org2, t0 + timedelta(days=6, hours=23))
            deadlines[incident4.id] = t0 + timedelta(days=14)

            self.assertEqual({"sent": 0}, send_reminders(t0 + timedelta(days=7, hours=1)))
            self.assertEqual([], reminder_scopes(incident4))

    def test_webhooks_unhealthy(self):
        incident = Incident.objects.create(  # mailroom will create these
            org=self.org,
            incident_type="webhooks:unhealthy",
            scope="",
            started_on=datetime(2021, 11, 12, 14, 23, 30, 123456, tzinfo=tzone.utc),
        )

        self.assertEqual(
            {
                "type": "webhooks:unhealthy",
                "started_on": "2021-11-12T14:23:30.123456+00:00",
                "ended_on": None,
            },
            incident.as_json(),
        )

    def test_channel_disconnected(self):
        ChannelDisconnectedIncidentType.get_or_create(self.channel)
        incident = Incident.objects.get()

        self.assertEqual(
            {
                "type": "channel:disconnected",
                "started_on": matchers.ISODatetime(),
                "ended_on": None,
            },
            incident.as_json(),
        )
        self.assertEqual(
            f"/channels/channel/read/{self.channel.uuid}/", incident.type.get_notification_target_url(incident)
        )
