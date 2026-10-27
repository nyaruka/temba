import json
from datetime import date

from allauth.account.models import EmailAddress
from allauth.account.signals import email_changed
from allauth.mfa.models import Authenticator
from allauth.mfa.signals import authentication_failed, authenticator_added, authenticator_removed, authenticator_reset

from django.contrib.auth.models import Group
from django.contrib.auth.signals import user_login_failed
from django.db import transaction
from django.test import RequestFactory
from django.urls import reverse

from temba.api.models import APIToken
from temba.contacts.models import ContactExport
from temba.orgs.models import Invitation, OrgRole
from temba.tests import TembaTest
from temba.utils import audit


class AuditTest(TembaTest):
    def assertAudited(self, expected: list[tuple], fn):
        """
        Asserts that calling fn records exactly the given (event, extra fields) audit entries, returning the entries
        """
        with self.assertLogs("temba.audit", level="INFO") as logs, self.captureOnCommitCallbacks(execute=True):
            fn()

        entries = [r.audit for r in logs.records]
        self.assertEqual([e[0] for e in expected], [e["audit"] for e in entries])

        for (event, fields), entry in zip(expected, entries):
            for key, value in fields.items():
                self.assertEqual(value, entry.get(key), f"mismatch in {key} of {event}")

        return entries

    def test_record(self):
        # outside of a request there's no actor or client
        entries = self.assertAudited(
            [("test.thing", {"data": {"foo": "bar"}})],
            lambda: audit.record("test.thing", user=self.editor, org=self.org, foo="bar"),
        )
        self.assertEqual(
            {"uuid": str(self.editor.uuid), "email": "editor@textit.com", "staff": False}, entries[0]["user"]
        )
        self.assertEqual({"uuid": str(self.org.uuid), "name": "Nyaruka"}, entries[0]["workspace"])
        self.assertNotIn("actor", entries[0])
        self.assertNotIn("client", entries[0])

        # with a request, the actor, workspace and client are taken from it
        request = RequestFactory().get(
            "/foo/", REMOTE_ADDR="10.0.0.1", HTTP_X_FORWARDED_FOR="1.2.3.4, 10.0.0.2", HTTP_USER_AGENT="Bot/1.0"
        )
        request.user = self.admin
        request.org = self.org

        entries = self.assertAudited(
            [("test.thing", {"path": "/foo/"})], lambda: audit.record("test.thing", request=request)
        )
        self.assertEqual(str(self.admin.uuid), entries[0]["actor"]["uuid"])
        self.assertEqual(str(self.org.uuid), entries[0]["workspace"]["uuid"])
        self.assertEqual(
            {"address": "10.0.0.1", "forwarded_for": "1.2.3.4, 10.0.0.2", "user_agent": "Bot/1.0"},
            entries[0]["client"],
        )
        self.assertNotIn("user", entries[0])
        self.assertNotIn("data", entries[0])

        # outside of a request, an explicit actor is used
        entries = self.assertAudited([("test.thing", {})], lambda: audit.record("test.thing", actor=self.editor))
        self.assertEqual(str(self.editor.uuid), entries[0]["actor"]["uuid"])

        # entries are formatted as a line of JSON
        with self.assertLogs("temba.audit", level="INFO") as logs, self.captureOnCommitCallbacks(execute=True):
            audit.record("test.thing", when=date(2026, 1, 2))
        self.assertEqual(
            {"audit": "test.thing", "time": logs.records[0].audit["time"], "data": {"when": "2026-01-02"}},
            json.loads(audit.AuditFormatter().format(logs.records[0])),
        )

        # entries are only logged once the transaction commits, so changes that are rolled back aren't recorded
        with self.assertNoLogs("temba.audit"), self.captureOnCommitCallbacks(execute=True):
            with self.assertRaises(ValueError), transaction.atomic():
                audit.record("test.thing")
                raise ValueError("rolled back")

        # and failing to record is logged rather than raised
        with self.assertLogs("temba.utils.audit", level="ERROR"):
            audit.record("test.thing", user=object())

    def test_auth_events(self):
        login_url = reverse("account_login")

        # a failed login records the identifier tried but nothing secret
        entries = self.assertAudited(
            [("user.login_failed", {"data": {"email": "editor@textit.com"}})],
            lambda: self.client.post(login_url, {"login": "editor@textit.com", "password": "wrong"}),
        )
        self.assertNotIn("wrong", json.dumps(entries, default=str))

        # an identifier that isn't an email address might be a password typed into the wrong field, so isn't recorded
        # (the login form refuses those itself, but other authentication paths may not)
        entries = self.assertAudited(
            [("user.login_failed", {"data": {"email": None}})],
            lambda: user_login_failed.send(
                sender=self.__class__, credentials={"email": "Sesame123", "password": "********"}, request=None
            ),
        )
        self.assertNotIn("Sesame123", json.dumps(entries, default=str))

        self.assertAudited(
            [("user.login", {"path": login_url})],
            lambda: self.client.post(login_url, {"login": "editor@textit.com", "password": self.default_password}),
        )

        self.assertAudited(
            [("user.password_changed", {})],
            lambda: self.client.post(
                reverse("account_change_password"),
                {"oldpassword": self.default_password, "password1": "Sesame123!", "password2": "Sesame123!"},
            ),
        )

        self.assertAudited([("user.logout", {})], lambda: self.client.post(reverse("account_logout")))

        # logging out when not logged in isn't recorded
        with self.assertNoLogs("temba.audit"), self.captureOnCommitCallbacks(execute=True):
            self.client.post(reverse("account_logout"))

        request = RequestFactory().get("/")
        request.user = self.admin
        totp = Authenticator.objects.create(user=self.admin, type=Authenticator.Type.TOTP, data={"secret": "sesame"})

        for signal, event in (
            (authenticator_added, "user.mfa_added"),
            (authenticator_removed, "user.mfa_removed"),
            (authenticator_reset, "user.mfa_reset"),
            (authentication_failed, "user.mfa_failed"),
        ):
            self.assertAudited(
                [(event, {"data": {"type": "totp"}})],
                lambda: signal.send(sender=Authenticator, request=request, user=self.admin, authenticator=totp),
            )

        old = EmailAddress(user=self.admin, email="admin@textit.com")
        new = EmailAddress(user=self.admin, email="admin2@textit.com")
        self.assertAudited(
            [("user.email_changed", {"data": {"old": "admin@textit.com", "new": "admin2@textit.com"}})],
            lambda: email_changed.send(
                sender=EmailAddress, request=request, user=self.admin, from_email_address=old, to_email_address=new
            ),
        )

    def test_mfa_failed(self):
        # end to end, so a change to what allauth sends with its signal would be caught
        Authenticator.objects.create(user=self.admin, type=Authenticator.Type.TOTP, data={"secret": "JBSWY3DPEHPK3PXP"})

        response = self.client.post(
            reverse("account_login"), {"login": "admin@textit.com", "password": self.default_password}
        )
        self.assertRedirect(response, reverse("mfa_authenticate"))

        self.assertAudited(
            [("user.mfa_failed", {"data": {"type": "totp"}})],
            lambda: self.client.post(reverse("mfa_authenticate"), {"code": "000000"}),
        )

    def test_access_changes(self):
        user = self.create_user("bob@textit.com")

        self.assertAudited(
            [("workspace.member_added", {"data": {"role": "E"}})],
            lambda: self.org.add_user(user, OrgRole.EDITOR),
        )
        self.assertAudited(
            [("workspace.member_role_changed", {"data": {"role": "A", "previous_role": "E"}})],
            lambda: self.org.add_user(user, OrgRole.ADMINISTRATOR),
        )

        # changing only the permissions isn't a role change
        self.assertAudited(
            [
                (
                    "workspace.member_updated",
                    {"data": {"role": "A", "team": None, "can_assign": False, "can_reply_non_own": True}},
                )
            ],
            lambda: self.org.add_user(user, OrgRole.ADMINISTRATOR, can_assign=False),
        )

        entries = self.assertAudited([("api_token.created", {})], lambda: APIToken.create(self.org, user))
        token1 = APIToken.objects.get(key__startswith=entries[0]["data"]["token"], user=user)
        self.assertAudited([("api_token.released", {})], lambda: token1.release())

        token2 = APIToken.create(self.org, user)

        self.assertAudited([("workspace.member_removed", {})], lambda: self.org.remove_user(user))

        self.assertAudited(
            [("workspace.invitation_created", {"data": {"email": "carol@textit.com", "role": "T"}})],
            lambda: Invitation.create(self.org, self.admin, "Carol@textit.com", OrgRole.AGENT),
        )

        # releasing a user records each of their tokens being released, and outside of a request whoever released them
        entries = self.assertAudited(
            [("user.released", {}), ("api_token.released", {"data": {"token": token2.key[:4]}})],
            lambda: user.release(self.customer_support),
        )
        self.assertEqual([str(self.customer_support.uuid)] * 2, [e["actor"]["uuid"] for e in entries])

        # releasing a workspace also removes its members
        num_members = self.org2.users.count()
        self.assertAudited(
            [("workspace.released", {})] + [("workspace.member_removed", {})] * num_members,
            lambda: self.org2.release(self.customer_support, release_users=False),
        )

    def test_exports(self):
        export = ContactExport.create(self.org, self.admin)

        entries = self.assertAudited([("export.started", {})], lambda: export.start())
        self.assertEqual({"export": str(export.uuid), "type": "contact"}, entries[0]["data"])
        self.assertEqual(str(self.admin.uuid), entries[0]["user"]["uuid"])

        self.login(self.editor)
        entries = self.assertAudited(
            [("export.downloaded", {"data": {"export": str(export.uuid), "type": "contact"}})],
            lambda: self.client.get(reverse("orgs.export_download", args=[export.uuid]) + "?raw=1"),
        )
        self.assertEqual(str(self.editor.uuid), entries[0]["actor"]["uuid"])

    def test_staff_changes(self):
        self.login(self.customer_support, choose_org=None)

        org_update_url = reverse("staff.org_update", args=[self.org.id])
        self.assertAudited(
            [("workspace.suspend", {"workspace": {"uuid": str(self.org.uuid), "name": "Nyaruka"}})],
            lambda: self.client.post(org_update_url, {"action": "suspend"}),
        )

        # an unknown action is refused, and nothing recorded
        with self.assertNoLogs("temba.audit"), self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(org_update_url, {"action": "released"})
        self.assertEqual(400, response.status_code)

        self.assertAudited(
            [("workspace.staff_updated", {"data": {"is_anon": True, "features": ["new_orgs"], "admin_groups": []}})],
            lambda: self.client.post(org_update_url, {"name": "Nyaruka", "features": ["new_orgs"], "is_anon": True}),
        )

        self.assertAudited(
            [("workspace.serviced", {})],
            lambda: self.client.post(reverse("staff.org_service"), {"other_org": self.org2.id}),
        )

        user_update_url = reverse("staff.user_update", args=[self.editor.id])
        self.assertAudited(
            [("user.staff_disable_mfa", {})], lambda: self.client.post(user_update_url, {"action": "disable-mfa"})
        )

        with self.assertNoLogs("temba.audit"), self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(user_update_url, {"action": "release"})
        self.assertEqual(400, response.status_code)

        beta = Group.objects.create(name="Beta")
        entries = self.assertAudited(
            [("user.staff_updated", {"data": {"groups": ["Beta"]}})],
            lambda: self.client.post(
                user_update_url,
                {"email": "editor@textit.com", "first_name": "Ed", "last_name": "Itor", "groups": [beta.id]},
            ),
        )
        self.assertEqual(str(self.customer_support.uuid), entries[0]["actor"]["uuid"])
        self.assertNotIn("old_email", entries[0]["data"])

        # a staff change of email is recorded with the old and new addresses
        self.assertAudited(
            [
                (
                    "user.staff_updated",
                    {"data": {"groups": [], "old_email": "editor@textit.com", "new_email": "ed@textit.com"}},
                )
            ],
            lambda: self.client.post(
                user_update_url, {"email": "ed@textit.com", "first_name": "Ed", "last_name": "Itor"}
            ),
        )
