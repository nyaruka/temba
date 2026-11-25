from temba.orgs.models import OrgRole
from temba.orgs.views.context_processors import RolePermsWrapper
from temba.tests import TembaTest


class OrgContextProcessorTest(TembaTest):
    def test_role_perms_wrapper(self):
        perms = RolePermsWrapper(OrgRole.ADMINISTRATOR)

        self.assertTrue(perms["msgs"]["msg_list"])
        self.assertTrue(perms["contacts"]["contact_update"])
        self.assertTrue(perms["orgs"]["org_locations"])
        self.assertTrue(perms["orgs"]["org_delete"])
        self.assertTrue(perms["tickets"]["ticket_list"])
        self.assertTrue(perms["users"]["user_list"])

        perms = RolePermsWrapper(OrgRole.EDITOR)

        self.assertTrue(perms["msgs"]["msg_list"])
        self.assertTrue(perms["contacts"]["contact_update"])
        self.assertFalse(perms["orgs"]["org_delete"])
        self.assertTrue(perms["tickets"]["ticket_list"])
        self.assertFalse(perms["users"]["user_list"])

        perms = RolePermsWrapper(OrgRole.AGENT)

        self.assertFalse(perms["msgs"]["msg_list"])
        self.assertFalse(perms["contacts"]["contact_update"])
        self.assertFalse(perms["orgs"]["org_delete"])
        self.assertTrue(perms["tickets"]["ticket_list"])
        self.assertFalse(perms["users"]["user_list"])

        self.assertFalse(perms["msgs"]["foo"])  # no blow up if perm doesn't exist
        self.assertFalse(perms["chickens"]["foo"])  # or app doesn't exist

        with self.assertRaises(TypeError):
            list(perms)
