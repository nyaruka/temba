from django.urls import reverse

from temba.contacts.models import ContactExport
from temba.notifications.models import Notification
from temba.notifications.types.builtin import ExportFinishedNotificationType
from temba.orgs.models import OrgMembership
from temba.tests import CRUDLTestMixin, TembaTest


class NotificationCRUDLTest(TembaTest, CRUDLTestMixin):
    def test_read(self):
        export = ContactExport.create(self.org, self.editor)
        export.perform()

        ExportFinishedNotificationType.create(export)

        notification = self.editor.notifications.get(export=export, is_seen=False)

        read_url = reverse("notifications.notification_read", args=[notification.id])

        self.assertRequestDisallowed(read_url, [None, self.admin])

        self.login(self.editor)
        response = self.client.get(read_url)
        self.assertRedirect(response, f"/export/download/{export.uuid}/")

        notification.refresh_from_db()
        self.assertTrue(notification.is_seen)

    def test_unsubscribe(self):
        export = ContactExport.create(self.org, self.editor)
        ExportFinishedNotificationType.create(export)

        notification = self.editor.notifications.get(export=export)
        unsubscribe_url = notification.get_unsubscribe_url().removeprefix("https://app.rapidpro.io")
        membership = OrgMembership.objects.get(org=self.org, user=self.editor)

        # GET only asks for confirmation, so link scanners can't unsubscribe anyone
        response = self.client.get(unsubscribe_url)
        self.assertContains(response, "You'll stop getting notification emails for the Nyaruka workspace.")

        membership.refresh_from_db()
        self.assertTrue(membership.email_notifications)

        # POST unsubscribes, without login or CSRF token, as mail clients do for one-click unsubscribe
        client = self.client_class(enforce_csrf_checks=True)
        response = client.post(unsubscribe_url, {"List-Unsubscribe": "One-Click"})
        self.assertContains(response, "You'll no longer get notification emails for the Nyaruka workspace.")

        membership.refresh_from_db()
        self.assertFalse(membership.email_notifications)

        # other memberships unaffected
        self.assertTrue(OrgMembership.objects.get(org=self.org, user=self.admin).email_notifications)

        # visiting again says they're already unsubscribed
        response = self.client.get(unsubscribe_url)
        self.assertContains(response, "You'll no longer get notification emails for the Nyaruka workspace.")

        # an invalid token
        response = self.client.get(reverse("notifications.notification_unsubscribe", args=["xyz"]))
        self.assertContains(response, "This unsubscribe link is no longer valid.")

        response = self.client.post(reverse("notifications.notification_unsubscribe", args=["xyz"]))
        self.assertContains(response, "This unsubscribe link is no longer valid.")

        # as is one for a membership which no longer exists
        self.org.remove_user(self.editor)

        response = self.client.get(unsubscribe_url)
        self.assertContains(response, "This unsubscribe link is no longer valid.")
        self.assertIsNone(Notification.from_unsubscribe_token(unsubscribe_url.rstrip("/").split("/")[-1]))
