from datetime import date, timedelta
from unittest.mock import call

from django.core import mail
from django.urls import reverse
from django.utils import timezone

from temba.contacts.models import ContactExport, ContactImport
from temba.flows.models import ResultsExport
from temba.msgs.models import MessageExport, MsgFolder
from temba.notifications.incidents.builtin import (
    ChannelDisconnectedIncidentType,
    ChannelTemplatesFailedIncidentType,
    OrgFlaggedIncidentType,
)
from temba.notifications.models import Notification
from temba.notifications.tasks import send_notification_emails, trim_notifications
from temba.notifications.types.builtin import ExportFinishedNotificationType, InvitationAcceptedNotificationType
from temba.orgs.models import Invitation, ItemCount, OrgRole
from temba.tests import TembaTest, matchers
from temba.tests.mailroom import mock_mailroom
from temba.tickets.models import TicketExport


class NotificationTest(TembaTest):
    def assert_notifications(self, *, after=None, expected_json, expected_target, expected_users, email):
        notifications = Notification.objects.all()
        if after:
            notifications = notifications.filter(created_on__gt=after)

        self.assertEqual(len(expected_users), notifications.count(), "notification count mismatch")

        actual_users = set()

        for notification in notifications:
            expected = expected_json.copy()
            expected["url"] = reverse("notifications.notification_read", args=[notification.id])

            self.assertEqual(expected, notification.as_json())
            self.assertEqual(expected_target, notification.get_target_url())
            self.assertEqual(email, notification.email_status == Notification.EMAIL_STATUS_PENDING)
            actual_users.add(notification.user)

        # check who was notified
        self.assertEqual(expected_users, actual_users)

    def test_contact_export_finished(self):
        export = ContactExport.create(self.org, self.editor)
        export.perform()

        ExportFinishedNotificationType.create(export)

        self.assertFalse(self.editor.notifications.get(export=export).is_seen)

        # we only notify the user that started the export
        self.assert_notifications(
            after=export.created_on,
            expected_json={
                "type": "export:finished",
                "created_on": matchers.ISODatetime(),
                "is_seen": False,
                "export": {"type": "contact", "num_records": 0},
            },
            expected_target=f"/export/download/{export.uuid}/",
            expected_users={self.editor},
            email=True,
        )

        send_notification_emails()

        self.assertEqual(1, len(mail.outbox))
        self.assertEqual("[Nyaruka] Your contact export is ready", mail.outbox[0].subject)
        self.assertEqual(["editor@textit.com"], mail.outbox[0].recipients())

        # calling task again won't send more emails
        send_notification_emails()

        self.assertEqual(1, len(mail.outbox))

    def test_contact_export_finished_unverified_user(self):
        self.unverifed_user = self.create_user("unverified@textit.com", first_name="Fred")
        self.org.add_user(self.unverifed_user, OrgRole.ADMINISTRATOR)  # unverified admin will be skipped

        export = ContactExport.create(self.org, self.unverifed_user)
        export.perform()

        ExportFinishedNotificationType.create(export)

        self.assertFalse(self.unverifed_user.notifications.get(export=export).is_seen)
        self.assertEqual(
            self.unverifed_user.notifications.get(export=export).email_status, Notification.EMAIL_STATUS_UNVERIFIED
        )

        # we only notify the user that started the export
        self.assert_notifications(
            after=export.created_on,
            expected_json={
                "type": "export:finished",
                "created_on": matchers.ISODatetime(),
                "is_seen": False,
                "export": {"type": "contact", "num_records": 0},
            },
            expected_target=f"/export/download/{export.uuid}/",
            expected_users={self.unverifed_user},
            email=False,
        )

        send_notification_emails()

        # no email sent for unverified and notification email status is updated to unverified
        self.assertEqual(0, len(mail.outbox))
        self.assertEqual(
            self.unverifed_user.notifications.get(export=export).email_status, Notification.EMAIL_STATUS_UNVERIFIED
        )

        # calling task again won't send any emails
        send_notification_emails()

        self.assertEqual(0, len(mail.outbox))

    def test_message_export_finished(self):
        export = MessageExport.create(
            self.org, self.editor, start_date=date.today(), end_date=date.today(), folder=MsgFolder.INBOX
        )
        export.perform()

        ExportFinishedNotificationType.create(export)

        self.assertFalse(self.editor.notifications.get(export=export).is_seen)

        # we only notify the user that started the export
        self.assert_notifications(
            after=export.created_on,
            expected_json={
                "type": "export:finished",
                "created_on": matchers.ISODatetime(),
                "is_seen": False,
                "export": {"type": "message", "num_records": 0},
            },
            expected_target=f"/export/download/{export.uuid}/",
            expected_users={self.editor},
            email=True,
        )

        send_notification_emails()

        self.assertEqual(1, len(mail.outbox))
        self.assertEqual("[Nyaruka] Your message export is ready", mail.outbox[0].subject)
        self.assertEqual(["editor@textit.com"], mail.outbox[0].recipients())

        # calling task again won't send more emails
        send_notification_emails()

        self.assertEqual(1, len(mail.outbox))

    def test_results_export_finished(self):
        flow1 = self.create_flow("Test Flow 1")
        flow2 = self.create_flow("Test Flow 2")
        export = ResultsExport.create(
            self.org,
            self.editor,
            start_date=date.today(),
            end_date=date.today(),
            flows=[flow1, flow2],
            with_fields=(),
            with_groups=(),
            responded_only=True,
            extra_urns=(),
        )
        export.perform()

        ExportFinishedNotificationType.create(export)

        self.assertFalse(self.editor.notifications.get(export=export).is_seen)

        # we only notify the user that started the export
        self.assert_notifications(
            after=export.created_on,
            expected_json={
                "type": "export:finished",
                "created_on": matchers.ISODatetime(),
                "is_seen": False,
                "export": {"type": "results", "num_records": 0},
            },
            expected_target=f"/export/download/{export.uuid}/",
            expected_users={self.editor},
            email=True,
        )

        send_notification_emails()

        self.assertEqual(1, len(mail.outbox))
        self.assertEqual("[Nyaruka] Your results export is ready", mail.outbox[0].subject)
        self.assertEqual(["editor@textit.com"], mail.outbox[0].recipients())

        # calling task again won't send more emails
        send_notification_emails()

        self.assertEqual(1, len(mail.outbox))

    def test_export_finished(self):
        export = TicketExport.create(self.org, self.editor, start_date=date.today(), end_date=date.today())
        export.perform()

        ExportFinishedNotificationType.create(export)

        self.assertFalse(self.editor.notifications.get(export=export).is_seen)

        # we only notify the user that started the export
        self.assert_notifications(
            after=export.created_on,
            expected_json={
                "type": "export:finished",
                "created_on": matchers.ISODatetime(),
                "is_seen": False,
                "export": {"type": "ticket", "num_records": 0},
            },
            expected_target=f"/export/download/{export.uuid}/",
            expected_users={self.editor},
            email=True,
        )

        send_notification_emails()

        self.assertEqual(1, len(mail.outbox))
        self.assertEqual("[Nyaruka] Your ticket export is ready", mail.outbox[0].subject)
        self.assertEqual(["editor@textit.com"], mail.outbox[0].recipients())

    def test_import_finished(self):
        imp = ContactImport.objects.create(org=self.org, mappings={}, num_records=5, created_by=self.editor)

        # mailroom will create these notifications when it's complete
        Notification.create_all(
            imp.org, "import:finished", scope=f"contact:{imp.id}", users=[self.editor], contact_import=imp
        )
        self.assertFalse(self.editor.notifications.get(contact_import=imp).is_seen)

        # we only notify the user that started the import
        self.assert_notifications(
            after=imp.created_on,
            expected_json={
                "type": "import:finished",
                "created_on": matchers.ISODatetime(),
                "is_seen": False,
                "import": {"type": "contact", "num_records": 5},
            },
            expected_target=f"/contactimport/read/{imp.uuid}/",
            expected_users={self.editor},
            email=False,
        )

    def test_tickets_opened(self):
        # mailroom will create these notifications
        Notification.create_all(self.org, "tickets:opened", scope="", users=[self.agent, self.editor])

        self.assert_notifications(
            expected_json={
                "type": "tickets:opened",
                "created_on": matchers.ISODatetime(),
                "is_seen": False,
            },
            expected_target="/ticket/unassigned/",
            expected_users={self.agent, self.editor},
            email=False,
        )

    def test_tickets_activity(self):
        # mailroom will create these notifications
        Notification.create_all(self.org, "tickets:activity", scope="", users=[self.agent, self.editor])

        self.assert_notifications(
            expected_json={
                "type": "tickets:activity",
                "created_on": matchers.ISODatetime(),
                "is_seen": False,
            },
            expected_target="/ticket/mine/",
            expected_users={self.agent, self.editor},
            email=False,
        )

    def test_channel_templates_failed(self):
        self.org.add_user(self.editor, OrgRole.ADMINISTRATOR)  # upgrade editor to administrator

        ChannelTemplatesFailedIncidentType.get_or_create(channel=self.channel)

        self.assert_notifications(
            expected_json={
                "type": "incident:started",
                "created_on": matchers.ISODatetime(),
                "is_seen": False,
                "incident": {
                    "type": "channel:templates_failed",
                    "title": "WhatsApp Templates Sync Failed",
                    "started_on": matchers.ISODatetime(),
                    "ended_on": None,
                },
            },
            expected_target=f"/channels/channel/read/{self.channel.uuid}/",
            expected_users={self.editor, self.admin},
            email=True,
        )

        send_notification_emails()

        self.assertEqual(2, len(mail.outbox))
        self.assertEqual("[Nyaruka] Incident: WhatsApp Templates Sync Failed", mail.outbox[0].subject)
        self.assertEqual("[Nyaruka] Incident: WhatsApp Templates Sync Failed", mail.outbox[1].subject)
        self.assertEqual(
            {"admin@textit.com", "editor@textit.com"},
            set(mail.outbox[0].recipients()).union(mail.outbox[1].recipients()),
        )

    def test_incident_started(self):
        self.org.add_user(self.editor, OrgRole.ADMINISTRATOR)  # upgrade editor to administrator

        OrgFlaggedIncidentType.get_or_create(self.org)

        self.assert_notifications(
            expected_json={
                "type": "incident:started",
                "created_on": matchers.ISODatetime(),
                "is_seen": False,
                "incident": {
                    "type": "org:flagged",
                    "title": "Workspace Flagged",
                    "started_on": matchers.ISODatetime(),
                    "ended_on": None,
                },
            },
            expected_target="/incident/",
            expected_users={self.editor, self.admin},
            email=True,
        )

        send_notification_emails()

        self.assertEqual(2, len(mail.outbox))
        self.assertEqual("[Nyaruka] Incident: Workspace Flagged", mail.outbox[0].subject)
        self.assertEqual("[Nyaruka] Incident: Workspace Flagged", mail.outbox[1].subject)

        recipients = set(mail.outbox[0].recipients()).union(mail.outbox[1].recipients())
        self.assertEqual({self.admin.email, self.editor.email}, recipients)

    def test_invitation_accepted(self):
        invitation = Invitation.create(self.org, self.admin, "bob@textit.com", OrgRole.ADMINISTRATOR)
        user = self.create_user("bob@textit.com")
        invitation.accept(user)

        InvitationAcceptedNotificationType.create(invitation, user)

        self.assert_notifications(
            expected_json={
                "type": "invitation:accepted",
                "created_on": matchers.ISODatetime(),
                "is_seen": True,
            },
            expected_target=None,
            expected_users={self.admin},
            email=True,
        )

        send_notification_emails()

        self.assertEqual(1, len(mail.outbox))
        self.assertEqual("[Nyaruka] New user joined your workspace", mail.outbox[0].subject)
        self.assertEqual(["admin@textit.com"], mail.outbox[0].recipients())  # only the other admins
        self.assertIn("User bob@textit.com accepted an invitation to join your workspace.", mail.outbox[0].body)

    @mock_mailroom
    def test_realtime_publish(self, mr_mocks):
        # UI notifications are published to mailroom for realtime delivery once the transaction commits
        export = ContactExport.create(self.org, self.editor)

        with self.captureOnCommitCallbacks(execute=True):
            ExportFinishedNotificationType.create(export)

        notification = self.editor.notifications.get(export=export)
        self.assertEqual(
            [
                call(
                    self.org,
                    [{"user_uuid": str(self.editor.uuid), "data": notification.as_json()}],
                )
            ],
            mr_mocks.calls["notification_publish"],
        )

        # email-only notifications are never published (no UI medium, nothing to deliver live)
        invitation = Invitation.create(self.org, self.admin, "bob@textit.com", OrgRole.ADMINISTRATOR)
        user = self.create_user("bob@textit.com")

        with self.captureOnCommitCallbacks(execute=True):
            InvitationAcceptedNotificationType.create(invitation, user)

        self.assertEqual(1, len(mr_mocks.calls["notification_publish"]))

        # a duplicate (already-unseen) notification isn't re-created, so nothing new is published
        with self.captureOnCommitCallbacks(execute=True):
            ExportFinishedNotificationType.create(export)

        self.assertEqual(1, len(mr_mocks.calls["notification_publish"]))

        # publishing is best-effort: a mailroom failure is logged, not raised, and the notification is still created
        export2 = ContactExport.create(self.org, self.editor)
        mr_mocks.exception(ConnectionError("mailroom unreachable"))

        with self.assertLogs("temba.notifications.models", level="ERROR"):
            with self.captureOnCommitCallbacks(execute=True):
                ExportFinishedNotificationType.create(export2)

        self.assertTrue(self.editor.notifications.filter(export=export2).exists())

        # a type that fans out to multiple users is published as a single batched call with one entry per user
        self.org.add_user(self.editor, OrgRole.ADMINISTRATOR)  # so the incident notifies both admin and editor
        before = len(mr_mocks.calls["notification_publish"])

        with self.captureOnCommitCallbacks(execute=True):
            ChannelDisconnectedIncidentType.get_or_create(channel=self.channel)

        new_calls = mr_mocks.calls["notification_publish"][before:]
        self.assertEqual(1, len(new_calls))  # one batched publish, not one per user
        org_arg, items = new_calls[0].args
        self.assertEqual(self.org, org_arg)
        self.assertEqual({str(self.admin.uuid), str(self.editor.uuid)}, {item["user_uuid"] for item in items})

    def test_channel_disconnected(self):
        self.org.add_user(self.editor, OrgRole.ADMINISTRATOR)  # upgrade editor to administrator

        incident = ChannelDisconnectedIncidentType.get_or_create(channel=self.channel)

        self.assert_notifications(
            expected_json={
                "type": "incident:started",
                "created_on": matchers.ISODatetime(),
                "is_seen": False,
                "incident": {
                    "type": "channel:disconnected",
                    "title": "Channel Disconnected",
                    "started_on": matchers.ISODatetime(),
                    "ended_on": None,
                },
            },
            expected_target=f"/channels/channel/read/{self.channel.uuid}/",
            expected_users={self.editor, self.admin},
            email=True,
        )
        send_notification_emails()

        self.assertEqual(2, len(mail.outbox))
        self.assertEqual("[Nyaruka] Incident: Channel Disconnected", mail.outbox[0].subject)
        self.assertEqual("[Nyaruka] Incident: Channel Disconnected", mail.outbox[1].subject)
        self.assertEqual(
            {"admin@textit.com", "editor@textit.com"},
            set(mail.outbox[0].recipients()).union(mail.outbox[1].recipients()),
        )

        self.assertEqual(1, self.editor.notifications.filter(is_seen=False).count())
        self.assertEqual(0, self.editor.notifications.filter(is_seen=True).count())
        self.assertEqual(1, self.admin.notifications.filter(is_seen=False).count())
        self.assertEqual(0, self.admin.notifications.filter(is_seen=True).count())

        # try having a new incident will not create new notifications
        incident2 = ChannelDisconnectedIncidentType.get_or_create(channel=self.channel)
        self.assertEqual(incident.pk, incident2.pk)
        send_notification_emails()
        self.assertEqual(2, len(mail.outbox))

        # end incident before the user visits the page
        incident.end()

        self.assertEqual(1, self.editor.notifications.filter(is_seen=False).count())
        self.assertEqual(0, self.editor.notifications.filter(is_seen=True).count())
        self.assertEqual(1, self.admin.notifications.filter(is_seen=False).count())
        self.assertEqual(0, self.admin.notifications.filter(is_seen=True).count())

        # a new incident after the first was ended
        incident3 = ChannelDisconnectedIncidentType.get_or_create(channel=self.channel)
        self.assertNotEqual(incident.pk, incident3.pk)

        send_notification_emails()
        self.assertEqual(4, len(mail.outbox))
        self.assertEqual("[Nyaruka] Incident: Channel Disconnected", mail.outbox[2].subject)
        self.assertEqual("[Nyaruka] Incident: Channel Disconnected", mail.outbox[3].subject)
        self.assertEqual(
            {"admin@textit.com", "editor@textit.com"},
            set(mail.outbox[2].recipients()).union(mail.outbox[3].recipients()),
        )

        self.assertEqual(2, self.editor.notifications.filter(is_seen=False).count())
        self.assertEqual(0, self.editor.notifications.filter(is_seen=True).count())
        self.assertEqual(2, self.admin.notifications.filter(is_seen=False).count())
        self.assertEqual(0, self.admin.notifications.filter(is_seen=True).count())

    def test_counts(self):
        imp = ContactImport.objects.create(org=self.org, mappings={}, num_records=5, created_by=self.editor)
        Notification.create_all(
            imp.org, "import:finished", scope=f"contact:{imp.id}", users=[self.editor], contact_import=imp, medium="UE"
        )
        Notification.create_all(self.org, "tickets:opened", scope="", users=[self.agent, self.editor], medium="UE")
        Notification.create_all(self.org, "tickets:activity", scope="", users=[self.agent, self.editor], medium="UE")
        Notification.create_all(self.org, "tickets:reply", scope="12", users=[self.editor], medium="E")  # email only
        Notification.create_all(
            self.org2, "tickets:activity", scope="", users=[self.editor], medium="UE"
        )  # different org

        def assert_count(org, user, expected: int):
            self.assertEqual(expected, Notification.get_unseen_count(org, user))

        assert_count(self.org, self.agent, 2)
        assert_count(self.org, self.editor, 3)
        assert_count(self.org2, self.agent, 0)
        assert_count(self.org2, self.editor, 1)

        Notification.mark_seen(self.org, self.agent, "tickets:activity", scope="")

        assert_count(self.org, self.agent, 1)
        assert_count(self.org, self.editor, 3)
        assert_count(self.org2, self.agent, 0)
        assert_count(self.org2, self.editor, 1)

        Notification.objects.filter(org=self.org, user=self.editor, notification_type="tickets:opened").delete()

        assert_count(self.org, self.agent, 1)
        assert_count(self.org, self.editor, 2)
        assert_count(self.org2, self.agent, 0)
        assert_count(self.org2, self.editor, 1)

        ItemCount.squash()

        assert_count(self.org, self.agent, 1)
        assert_count(self.org, self.editor, 2)
        assert_count(self.org2, self.agent, 0)
        assert_count(self.org2, self.editor, 1)

        Notification.mark_seen(self.org, self.editor)

        assert_count(self.org, self.agent, 1)
        assert_count(self.org, self.editor, 0)
        assert_count(self.org2, self.agent, 0)
        assert_count(self.org2, self.editor, 1)

    def test_trim_task(self):
        self.org.suspend()
        self.org.unsuspend()

        notification1 = self.admin.notifications.order_by("id").last()

        self.org.suspend()
        self.org.unsuspend()

        notification2 = self.admin.notifications.order_by("id").last()

        notification1.created_on = timezone.now() - timedelta(days=33)
        notification1.save(update_fields=("created_on",))

        trim_notifications()

        self.assertFalse(Notification.objects.filter(id=notification1.id).exists())
        self.assertTrue(Notification.objects.filter(id=notification2.id).exists())
