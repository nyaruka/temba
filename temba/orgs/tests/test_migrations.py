from temba.orgs.models import Invitation, OrgRole
from temba.tests import MigrationTest


class LowercaseInvitationEmailsTest(MigrationTest):
    app = "orgs"
    migrate_from = "0192_remove_unused_audit_fields"
    migrate_to = "0193_lowercase_invitation_emails"

    def setUpBeforeMigration(self, apps):
        self.invitation1 = Invitation.create(self.org, self.admin, "bob@textit.com", OrgRole.EDITOR)
        self.invitation2 = Invitation.create(self.org, self.admin, "jim@textit.com", OrgRole.EDITOR)
        Invitation.objects.filter(id=self.invitation2.id).update(email="Jim@TextIt.com")

    def test_migration(self):
        self.invitation1.refresh_from_db()
        self.invitation2.refresh_from_db()

        self.assertEqual("bob@textit.com", self.invitation1.email)
        self.assertEqual("jim@textit.com", self.invitation2.email)
