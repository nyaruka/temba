from allauth.mfa.models import Authenticator

from django.contrib.auth.models import Permission

from temba.api.models import APIToken
from temba.orgs.models import Org, OrgRole
from temba.orgs.tasks import update_members_seen
from temba.tests import TembaTest
from temba.users.models import User


class UserTest(TembaTest):
    def test_model(self):
        user = User.create("jim@rapidpro.io", "Jim", "McFlow", password="super")
        self.org.add_user(user, OrgRole.EDITOR)
        self.org2.add_user(user, OrgRole.AGENT)

        self.assertEqual("Jim McFlow", user.name)
        self.assertEqual({"uuid": str(user.uuid), "name": "Jim McFlow"}, user.as_engine_ref())
        self.assertEqual([self.org, self.org2], list(user.get_orgs().order_by("id")))
        self.assertFalse(user.is_verified())
        self.assertEqual(0, user.emailaddress_set.count())

        user.set_verified(True)
        self.assertTrue(user.is_verified())
        self.assertTrue(user.emailaddress_set.filter(email="jim@rapidpro.io", primary=True, verified=True).exists())

        user.set_verified(False)
        self.assertFalse(user.is_verified())
        self.assertEqual(1, user.emailaddress_set.count())
        self.assertTrue(user.emailaddress_set.filter(email="jim@rapidpro.io", primary=True, verified=False).exists())

        # reverify can always work
        user.set_verified(True)
        self.assertTrue(user.is_verified())
        self.assertTrue(user.emailaddress_set.filter(email="jim@rapidpro.io", primary=True, verified=True).exists())

        user.last_name = ""
        user.save(update_fields=("last_name",))

        self.assertEqual("Jim", user.name)
        self.assertEqual({"uuid": str(user.uuid), "name": "Jim"}, user.as_engine_ref())

        self.assertEqual(user, User.objects.get_by_natural_key("jim@rapidpro.io"))
        self.assertEqual(user, User.objects.get_by_natural_key("JIM@rapidpro.io"))

        # remove emailaddress object
        user.emailaddress_set.all().delete()

        self.assertFalse(user.is_verified())
        self.assertEqual(0, user.emailaddress_set.count())

        # create email address as verification process
        user.emailaddress_set.create(email="jim@rapidpro.io")

        self.assertFalse(user.is_verified())
        self.assertEqual(1, user.emailaddress_set.count())

        user.set_verified(True)
        self.assertTrue(user.is_verified())
        self.assertTrue(user.emailaddress_set.filter(email="jim@rapidpro.io", primary=True, verified=True).exists())

    def test_admin_groups(self):
        admin = self.create_user("gad@textit.com")
        self.create_admin_group("Global Admins", orgs=[self.org], users=[admin])

        self.assertFalse(self.org.has_group_admin(self.admin))
        self.assertTrue(self.org.has_group_admin(admin))
        self.assertFalse(self.org2.has_group_admin(admin))

        # group admins have access to the orgs of their groups but don't own any
        self.assertEqual([self.org], list(admin.get_orgs()))
        self.assertEqual([], admin.get_owned_orgs())

        # and have the administrator role in those orgs without needing a membership
        self.assertEqual(OrgRole.ADMINISTRATOR, self.org.get_user_role(admin))
        self.assertIsNone(self.org.get_membership(admin, explicit_only=True))
        self.assertNotIn(admin, self.org.get_users())
        self.assertIsNone(self.org2.get_user_role(admin))

        # which overrides any explicit membership
        self.org.add_user(admin, OrgRole.AGENT)
        self.assertEqual(OrgRole.ADMINISTRATOR, self.org.get_user_role(admin))

        # but only in orgs where the group is an admin group
        self.org2.add_user(admin, OrgRole.AGENT)
        self.assertEqual(OrgRole.AGENT, self.org2.get_user_role(admin))
        self.assertEqual([self.org, self.org2], list(admin.get_orgs().order_by("id")))

        # child orgs don't inherit the admin groups of their parent
        self.org.features = [Org.FEATURE_CHILD_ORGS]
        self.org.save(update_fields=("features",))
        child = self.org.create_new(self.admin, "Child", self.org.timezone, as_child=True)
        self.assertEqual([], list(child.admin_groups.all()))
        self.assertIsNone(child.get_user_role(admin))

    def test_mfa(self):
        self.assertFalse(self.admin.is_mfa_enabled)
        self.assertFalse(self.editor.is_mfa_enabled)
        self.assertFalse(self.agent.is_mfa_enabled)

        Authenticator.objects.create(user_id=self.admin.id, type=Authenticator.Type.TOTP, data={"secret": "sesame"})
        Authenticator.objects.create(
            user_id=self.admin.id, type=Authenticator.Type.RECOVERY_CODES, data={"migrated_codes": ["abc", "edc"]}
        )

        Authenticator.objects.create(user_id=self.agent.id, type=Authenticator.Type.TOTP, data={"secret": "sesame"})

        self.assertTrue(self.admin.is_mfa_enabled)
        self.assertFalse(self.editor.is_mfa_enabled)
        self.assertTrue(self.agent.is_mfa_enabled)

        self.admin.disable_mfa()

        self.assertFalse(self.admin.is_mfa_enabled)
        self.assertFalse(self.editor.is_mfa_enabled)
        self.assertTrue(self.agent.is_mfa_enabled)

    def test_has_org_perm(self):
        granter = self.create_user("jim@rapidpro.io")
        granter.user_permissions.add(Permission.objects.get(content_type__app_label="orgs", codename="org_grant"))
        group_admin = self.create_user("gad@rapidpro.io")
        self.create_admin_group("Global Admins", orgs=[self.org], users=[group_admin])

        tests = (
            (
                self.org,
                "contacts.contact_list",
                {self.agent: False, self.admin: True, self.admin2: False, group_admin: True},
            ),
            (
                self.org2,
                "contacts.contact_list",
                {self.agent: False, self.admin: False, self.admin2: True, group_admin: False},
            ),
            (
                self.org2,
                "contacts.contact_read",
                {self.agent: False, self.admin: False, self.admin2: True, group_admin: False},
            ),
            (
                self.org,
                "orgs.org_edit",
                {self.agent: False, self.admin: True, self.admin2: False, group_admin: True},
            ),
            (
                self.org2,
                "orgs.org_edit",
                {self.agent: False, self.admin: False, self.admin2: True, group_admin: False},
            ),
            (
                self.org,
                "orgs.org_grant",
                {self.agent: False, self.admin: False, self.admin2: False, granter: True, group_admin: False},
            ),
            (
                self.org,
                "xxx.yyy_zzz",
                {self.agent: False, self.admin: False, self.admin2: False, group_admin: False},
            ),
        )
        for org, perm, checks in tests:
            for user, has_perm in checks.items():
                self.assertEqual(
                    has_perm,
                    user.has_org_perm(org, perm),
                    f"expected {user} to{'' if has_perm else ' not'} have perm {perm} in org {org.name}",
                )

    def test_release(self):
        token = APIToken.create(self.org, self.admin)
        self.create_admin_group("Global Admins", users=[self.admin])

        # admin doesn't "own" any orgs
        self.assertEqual(0, len(self.admin.get_owned_orgs()))

        # release all but our admin
        self.editor.release(self.customer_support)
        self.agent.release(self.customer_support)

        # still a user left, our org remains active
        self.org.refresh_from_db()
        self.assertTrue(self.org.is_active)

        # now that we are the last user, we own it now
        self.assertEqual(1, len(self.admin.get_owned_orgs()))
        self.admin.release(self.customer_support)

        # and we take our org with us
        self.org.refresh_from_db()
        self.assertFalse(self.org.is_active)

        token.refresh_from_db()
        self.assertFalse(token.is_active)
        self.assertEqual(0, self.admin.groups.count())

    def test_last_seen(self):
        membership = self.org.get_membership(self.admin)
        membership.record_seen()
        self.assertIsNone(membership.last_seen_on)

        update_members_seen()

        membership.refresh_from_db()
        self.assertIsNotNone(membership.last_seen_on)
