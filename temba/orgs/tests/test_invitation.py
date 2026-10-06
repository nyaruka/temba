from datetime import timedelta

from django.core import mail
from django.utils import timezone

from temba.orgs.models import Invitation, OrgRole
from temba.orgs.tasks import expire_invitations
from temba.tests import TembaTest
from temba.tickets.models import Team
from temba.users.models import User


class InvitationTest(TembaTest):
    def test_model(self):
        invitation = Invitation.create(self.org, self.admin, "InvitedEditor@TextIt.com", OrgRole.EDITOR)
        self.assertEqual("invitededitor@textit.com", invitation.email)

        self.assertEqual(OrgRole.EDITOR, invitation.role)

        invitation.send()

        self.assertEqual(1, len(mail.outbox))
        self.assertEqual(["invitededitor@textit.com"], mail.outbox[0].recipients())
        self.assertEqual("[Nyaruka] Invitation to join workspace", mail.outbox[0].subject)
        self.assertIn(f"https://app.rapidpro.io/org/join/{invitation.secret}/", mail.outbox[0].body)

        new_editor = User.create("invitededitor@textit.com", "Bob", "", "Qwerty123", "en-US")
        invitation.accept(new_editor)

        self.assertEqual(1, self.admin.notifications.count())
        self.assertFalse(invitation.is_active)
        self.assertEqual({self.editor, new_editor}, set(self.org.get_users(roles=[OrgRole.EDITOR])))

        # invite an agent user to a specific team
        sales = Team.create(self.org, self.admin, "Sales", topics=[])
        invitation = Invitation.create(self.org, self.admin, "invitedagent@textit.com", OrgRole.AGENT, team=sales)

        self.assertEqual(OrgRole.AGENT, invitation.role)
        self.assertEqual(sales, invitation.team)

        invitation.send()
        new_agent = User.create("invitedagent@textit.com", "Bob", "", "Qwerty123", "en-US")
        invitation.accept(new_agent)

        self.assertEqual({self.agent, new_agent}, set(self.org.get_users(roles=[OrgRole.AGENT])))
        self.assertEqual({new_agent}, set(sales.get_users()))

    def test_expire_task(self):
        invitation1 = Invitation.objects.create(
            org=self.org,
            role_code="E",
            email="neweditor@textit.com",
            created_by=self.admin,
            created_on=timezone.now() - timedelta(days=31),
            modified_by=self.admin,
        )
        invitation2 = Invitation.objects.create(
            org=self.org,
            role_code="T",
            email="newagent@textit.com",
            created_by=self.admin,
            created_on=timezone.now() - timedelta(days=29),
            modified_by=self.admin,
        )

        expire_invitations()

        invitation1.refresh_from_db()
        invitation2.refresh_from_db()

        self.assertFalse(invitation1.is_active)
        self.assertTrue(invitation2.is_active)
