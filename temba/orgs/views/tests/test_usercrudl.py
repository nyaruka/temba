from django.test.utils import override_settings
from django.urls import reverse

from temba.orgs.models import Org, OrgRole
from temba.tests import CRUDLTestMixin, TembaTest
from temba.tickets.models import Team


class UserCRUDLTest(TembaTest, CRUDLTestMixin):
    def test_list(self):
        list_url = reverse("orgs.user_list")

        system_user = self.create_user("system@textit.com")
        system_user.is_system = True
        system_user.save(update_fields=("is_system",))

        # add system user to workspace
        self.org.add_user(system_user, OrgRole.ADMINISTRATOR)

        # nobody can access if users feature not enabled
        response = self.requestView(list_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.org.features = [Org.FEATURE_USERS]
        self.org.save(update_fields=("features",))

        self.assertRequestDisallowed(list_url, [None, self.editor, self.agent])

        response = self.assertListFetch(list_url, [self.admin], context_objects=[self.admin, self.agent, self.editor])
        self.assertNotContains(response, "(All Topics)")

        self.org.features += [Org.FEATURE_TEAMS]
        self.org.save(update_fields=("features",))

        response = self.assertListFetch(list_url, [self.admin], context_objects=[self.admin, self.agent, self.editor])
        self.assertEqual(response.context["admin_count"], 1)
        self.assertContains(response, "(All Topics)")

        # can search by name or email
        self.assertListFetch(list_url + "?search=andy", [self.admin], context_objects=[self.admin])
        self.assertListFetch(list_url + "?search=editor@textit.com", [self.admin], context_objects=[self.editor])

        response = self.requestView(list_url, self.customer_support, choose_org=self.org)
        self.assertEqual(
            set(list(response.context["object_list"])),
            {self.admin, self.agent, self.editor, system_user},
        )
        self.assertContains(response, "(All Topics)")
        self.assertEqual(response.context["admin_count"], 2)

    def test_team(self):
        team_url = reverse("orgs.user_team", args=[self.org.default_team.id])

        # nobody can access if teams feature not enabled
        response = self.requestView(team_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.org.features = [Org.FEATURE_TEAMS]
        self.org.save(update_fields=("features",))

        self.assertRequestDisallowed(team_url, [None, self.editor, self.agent])

        self.assertListFetch(team_url, [self.admin], context_objects=[self.agent])
        self.assertContentMenu(team_url, self.admin, [])  # because it's a system team

        team = Team.create(self.org, self.admin, "My Team")
        team_url = reverse("orgs.user_team", args=[team.id])

        self.assertContentMenu(team_url, self.admin, ["Edit", "Delete"])

        # teams from other orgs must not be accessible by id
        self.org2.features = [Org.FEATURE_TEAMS]
        self.org2.save(update_fields=("features",))
        other_team = Team.create(self.org2, self.admin2, "Secret Team")

        other_team_url = reverse("orgs.user_team", args=[other_team.id])
        response = self.requestView(other_team_url, self.admin)
        self.assertEqual(404, response.status_code)
        self.assertNotContains(response, "Secret Team", status_code=404)

    def test_update(self):
        system_user = self.create_user("system@textit.com")
        system_user.is_system = True
        system_user.save(update_fields=("is_system",))

        update_url = reverse("orgs.user_update", args=[self.agent.id])

        # nobody can access if users feature not enabled
        response = self.requestView(update_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.org.features = [Org.FEATURE_USERS]
        self.org.save(update_fields=("features",))

        self.assertRequestDisallowed(update_url, [None, self.editor, self.agent])

        # agent form includes permission fields
        self.assertUpdateFetch(
            update_url,
            [self.admin],
            form_fields={"role": "T", "can_assign": True, "can_reply_non_own": True},
        )

        # check can't update user not in the current org
        self.assertRequestDisallowed(reverse("orgs.user_update", args=[self.admin2.id]), [self.admin])

        # make agent an editor
        response = self.assertUpdateSubmit(update_url, self.admin, {"role": "E"})
        self.assertRedirect(response, reverse("orgs.user_list"))

        self.assertEqual({self.agent, self.editor}, set(self.org.get_users(roles=[OrgRole.EDITOR])))

        # editor form does not include permission fields
        self.assertUpdateFetch(update_url, [self.admin], form_fields={"role": "E"})

        # and back to an agent
        self.assertUpdateSubmit(update_url, self.admin, {"role": "T"})
        self.assertEqual({self.agent}, set(self.org.get_users(roles=[OrgRole.AGENT])))

        # update agent with restricted permissions
        self.assertUpdateSubmit(update_url, self.admin, {"role": "T", "can_assign": False})
        self.org._membership_cache = {}
        membership = self.org.get_membership(self.agent)
        self.assertFalse(membership.can_assign)
        self.assertFalse(membership.can_reply_non_own)

        # update agent with full permissions
        self.assertUpdateSubmit(update_url, self.admin, {"role": "T", "can_assign": True, "can_reply_non_own": True})
        self.org._membership_cache = {}
        membership = self.org.get_membership(self.agent)
        self.assertTrue(membership.can_assign)
        self.assertTrue(membership.can_reply_non_own)

        # adding teams feature enables team selection for agents
        self.org.features += [Org.FEATURE_TEAMS]
        self.org.save(update_fields=("features",))
        sales = Team.create(self.org, self.admin, "Sales", topics=[])

        update_url = reverse("orgs.user_update", args=[self.agent.id])

        self.assertUpdateFetch(
            update_url,
            [self.admin],
            form_fields={"role": "T", "team": self.org.default_team, "can_assign": True, "can_reply_non_own": True},
        )
        self.assertUpdateSubmit(update_url, self.admin, {"role": "T", "team": sales.id})

        self.org._membership_cache = {}
        self.assertEqual(sales, self.org.get_membership(self.agent).team)

        # try updating ourselves...
        update_url = reverse("orgs.user_update", args=[self.admin.id])

        # can't be updated because no other admins
        response = self.assertUpdateSubmit(update_url, self.admin, {"role": "E"}, object_unchanged=self.admin)
        self.assertRedirect(response, reverse("orgs.user_list"))
        self.assertEqual({self.editor}, set(self.org.get_users(roles=[OrgRole.EDITOR])))
        self.assertEqual({self.admin}, set(self.org.get_users(roles=[OrgRole.ADMINISTRATOR])))

        # even if we add system user to workspace
        self.org.add_user(system_user, OrgRole.ADMINISTRATOR)
        response = self.assertUpdateSubmit(update_url, self.admin, {"role": "E"}, object_unchanged=self.admin)
        self.assertRedirect(response, reverse("orgs.user_list"))
        self.assertEqual({self.editor}, set(self.org.get_users(roles=[OrgRole.EDITOR])))
        self.assertEqual({self.admin, system_user}, set(self.org.get_users(roles=[OrgRole.ADMINISTRATOR])))

        # add another admin to workspace and try again
        self.org.add_user(self.admin2, OrgRole.ADMINISTRATOR)

        response = self.assertUpdateSubmit(update_url, self.admin, {"role": "E"}, object_unchanged=self.admin)
        self.assertRedirect(response, reverse("orgs.org_start"))  # no longer have access to user list page

        self.assertEqual({self.editor, self.admin}, set(self.org.get_users(roles=[OrgRole.EDITOR])))
        self.assertEqual({self.admin2, system_user}, set(self.org.get_users(roles=[OrgRole.ADMINISTRATOR])))

        # cannot update system user on a workspace
        update_url = reverse("orgs.user_update", args=[system_user.id])
        response = self.requestView(update_url, self.admin2)
        self.assertRedirect(response, reverse("orgs.org_workspace"))
        self.assertEqual({self.editor, self.admin}, set(self.org.get_users(roles=[OrgRole.EDITOR])))
        self.assertEqual({self.admin2, system_user}, set(self.org.get_users(roles=[OrgRole.ADMINISTRATOR])))

    def test_delete(self):
        system_user = self.create_user("system@textit.com")
        system_user.is_system = True
        system_user.save(update_fields=("is_system",))

        delete_url = reverse("orgs.user_delete", args=[self.agent.id])

        # nobody can access if users feature not enabled
        response = self.requestView(delete_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.org.features = [Org.FEATURE_USERS]
        self.org.save(update_fields=("features",))

        self.assertRequestDisallowed(delete_url, [None, self.editor, self.agent])

        # check can't delete user not in the current org
        self.assertRequestDisallowed(reverse("orgs.user_delete", args=[self.admin2.id]), [self.admin])

        response = self.assertDeleteFetch(delete_url, [self.admin], as_modal=True)
        self.assertContains(
            response, "You are about to remove the user <b>Agnes</b> from your workspace. Are you sure?"
        )

        # submitting the delete doesn't actually delete the user - only removes them from the org
        response = self.assertDeleteSubmit(delete_url, self.admin, object_unchanged=self.agent)

        self.assertRedirect(response, reverse("orgs.user_list"))
        self.assertEqual({self.editor, self.admin}, set(self.org.get_users()))

        # try deleting ourselves..
        delete_url = reverse("orgs.user_delete", args=[self.admin.id])

        # can't be removed because no other admins
        response = self.assertDeleteSubmit(delete_url, self.admin, object_unchanged=self.admin)
        self.assertRedirect(response, reverse("orgs.user_list"))
        self.assertEqual({self.editor, self.admin}, set(self.org.get_users()))

        # cannot still even when the other admin is a system user
        self.org.add_user(system_user, OrgRole.ADMINISTRATOR)
        response = self.assertDeleteSubmit(delete_url, self.admin, object_unchanged=self.admin)
        self.assertRedirect(response, reverse("orgs.user_list"))
        self.assertEqual({self.editor, self.admin, system_user}, set(self.org.get_users()))

        # cannot remove system user too
        self.assertRequestDisallowed(reverse("orgs.user_delete", args=[system_user.id]), [self.admin])
        self.assertEqual({self.editor, self.admin, system_user}, set(self.org.get_users()))

        # add another admin to workspace and try again
        self.org.add_user(self.admin2, OrgRole.ADMINISTRATOR)

        response = self.assertDeleteSubmit(delete_url, self.admin, object_unchanged=self.admin)

        # this time we could remove ourselves
        response = self.assertDeleteSubmit(delete_url, self.admin, object_unchanged=self.admin)
        self.assertRedirect(response, reverse("orgs.org_choose"))
        self.assertEqual({self.editor, self.admin2, system_user}, set(self.org.get_users()))

    def test_edit(self):
        edit_url = reverse("orgs.user_edit")

        # no access if anonymous
        self.assertRequestDisallowed(edit_url, [None])

        self.assertUpdateFetch(
            edit_url,
            [self.admin],
            form_fields=["first_name", "last_name", "avatar", "language"],
        )

        # language is only shown if there are multiple options
        with override_settings(LANGUAGES=(("en-us", "English"),)):
            self.assertUpdateFetch(
                edit_url,
                [self.admin],
                form_fields=["first_name", "last_name", "avatar"],
            )

        # try to submit without required fields
        self.assertUpdateSubmit(
            edit_url,
            self.admin,
            {},
            form_errors={
                "first_name": "This field is required.",
                "last_name": "This field is required.",
                "language": "This field is required.",
            },
            object_unchanged=self.admin,
        )

        # change the name and language
        self.assertUpdateSubmit(
            edit_url,
            self.admin,
            {
                "avatar": self.getMockImageUpload(),
                "language": "pt-br",
                "first_name": "Admin",
                "last_name": "User",
            },
            success_status=302,
        )

        self.admin.refresh_from_db()
        self.assertEqual("Admin User", self.admin.name)
        self.assertIsNotNone(self.admin.avatar)
        self.assertEqual("pt-br", self.admin.language)

        self.assertEqual(0, self.admin.notifications.count())

        self.admin.language = "en-us"
        self.admin.save()

        # check that user still has a valid session
        self.assertEqual(200, self.client.get(reverse("msgs.msg_inbox")).status_code)

        # reset password as test suite assumes this password
        self.admin.set_password("Qwerty123")
        self.admin.save()

        # submit when language isn't an option
        with override_settings(LANGUAGES=(("en-us", "English"),)):
            self.assertUpdateSubmit(
                edit_url,
                self.admin,
                {
                    "first_name": "Andy",
                    "last_name": "Flows",
                    "email": "admin@trileet.com",
                },
                success_status=302,
            )

            self.admin.refresh_from_db()
            self.assertEqual("Andy", self.admin.first_name)
            self.assertEqual("en-us", self.admin.language)
