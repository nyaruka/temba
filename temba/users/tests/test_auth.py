from unittest.mock import Mock, patch
from urllib.parse import urlencode

from allauth.account.adapter import get_adapter
from allauth.account.models import EmailAddress
from allauth.core import context as allauth_context
from allauth.socialaccount.adapter import get_adapter as get_social_adapter
from allauth.socialaccount.helpers import complete_social_login
from allauth.socialaccount.models import SocialAccount
from allauth.socialaccount.providers import registry
from allauth.socialaccount.providers.openid_connect.provider import OpenIDConnectProvider

from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.contrib.messages.storage.fallback import FallbackStorage
from django.contrib.sessions.middleware import SessionMiddleware
from django.test import RequestFactory, override_settings
from django.urls import reverse
from django.utils.functional import lazystr

from temba.orgs.models import Invitation, OrgRole
from temba.tests.base import TembaTest
from temba.users.models import User


class UserAuthTest(TembaTest):
    # Auth is handled by allauth, only test things we override in any way
    def test_no_workspace_alert(self):
        # users with a workspace don't see the invitation-needed alert on account pages
        self.login(self.admin)
        response = self.client.get(reverse("account_change_password"))
        self.assertNotContains(response, "need an invitation to continue")

        # but users without one do
        user = User.create(
            email="noworkspace@temba.io", first_name="Nelly", last_name="Noworkspace", password="Qwerty123"
        )
        self.login(user)
        response = self.client.get(reverse("account_change_password"))
        self.assertContains(response, "need an invitation to continue")

        # unless the brand offers self-serve signup
        with override_settings(BRAND={**settings.BRAND, "signup_url": "/org/signup/"}):
            response = self.client.get(reverse("account_change_password"))
            self.assertNotContains(response, "need an invitation to continue")

    def test_login_with_invalid_invite(self):
        response = self.client.get(f"{reverse('account_login')}?invite=invalid")
        self.assertContains(response, "Sorry, your invitation is no longer valid. Please request a new invite.")

    def test_change_password(self):
        # make sure we get the correct help text on change password page
        self.login(self.admin)

        change_password_url = reverse("account_change_password")
        response = self.client.get(change_password_url)
        self.assertEqual(200, response.status_code)
        self.assertContains(response, "At least 8 characters or more")

    def test_mfa(self):
        self.login(self.admin)
        mfa_url = reverse("mfa_activate_totp")

        # we should be forced to reauthenticate before we can get to mfa
        response = self.client.get(mfa_url)
        self.assertRedirect(response, reverse("account_reauthenticate"))

        # Reauthenticate and make sure we get the QR code
        response = self.client.post(
            f"{reverse('account_reauthenticate')}?{urlencode({'next': mfa_url})}",
            {"login": self.admin.email, "password": self.default_password},
            follow=True,
        )
        self.assertContains(response, "scan the QR code below")

    def test_add_email(self):
        # we override change email to ensure the new email is not already in use
        self.login(self.admin)
        add_email_url = reverse("account_email")

        # try to change our email address to one that is already in use
        response = self.client.post(add_email_url, {"email": self.admin2.email, "action_add": True})

        self.assertEqual(200, response.status_code)
        form = response.context.get("form")
        self.assertFormError(form, "email", "This email is already in use")

        # now try to change our email address to a new one
        response = self.client.post(add_email_url, {"email": "newemail@temba.io", "action_add": True})
        self.assertRedirect(response, reverse("account_email"))

        # we should see the new email now
        emails = self.admin.emailaddress_set.all()
        self.assertEqual(2, emails.count())
        self.assertTrue(emails.filter(email="newemail@temba.io").exists())

    @override_settings(SSO_ONLY_DOMAINS={"SSO-Corp.com": lazystr("Use <b>Sign In with SSO Corp</b> instead.")})
    def test_sso_only_domains(self):
        login_url = reverse("account_login")

        # logging in with a password from a non-matching domain works
        response = self.client.post(login_url, {"login": self.admin.email, "password": self.default_password})
        self.assertRedirect(response, reverse("orgs.org_choose"))
        self.client.logout()

        # but a user whose email domain requires SSO is sent back to the login page with the error for that domain
        user = self.create_user("uma@sso-corp.com")
        EmailAddress.objects.create(user=user, email=user.email, verified=True, primary=True)
        self.org.add_user(user, OrgRole.EDITOR)

        response = self.client.post(login_url, {"login": user.email, "password": self.default_password})
        self.assertRedirect(response, login_url)

        response = self.client.get(login_url)
        self.assertContains(response, "Use &lt;b&gt;Sign In with SSO Corp&lt;/b&gt; instead.")
        self.assertNotIn("_auth_user_id", self.client.session)

        # and keeps where they were going
        response = self.client.post(f"{login_url}?next=/msg/", {"login": user.email, "password": self.default_password})
        self.assertEqual(f"{login_url}?next=%2Fmsg%2F", response.url)
        self.assertNotIn("_auth_user_id", self.client.session)

        # whereas a social login for the same user is allowed through
        adapter = get_adapter()
        request = RequestFactory().get("/")
        response = adapter.pre_login(
            request,
            user,
            email_verification="none",
            signal_kwargs={"sociallogin": Mock()},
            email=None,
            signup=False,
            redirect_url=None,
        )
        self.assertIsNone(response)

        # and an invited user from that domain can't signup with a password
        invitation = Invitation.create(self.org, self.admin, "sid@sso-corp.com", OrgRole.EDITOR)
        response = self.client.post(
            f"{reverse('account_signup')}?invite={invitation.secret}",
            {"first_name": "Sid", "last_name": "Sso", "email": "sid@sso-corp.com", "password1": "arstqwfp"},
        )
        self.assertFormError(response.context["form"], "email", "Use <b>Sign In with SSO Corp</b> instead.")
        self.assertFalse(User.objects.filter(email="sid@sso-corp.com").exists())

    def _social_login(
        self, provider_id: str, response: dict, *, process: str = "login", user=None, invite=None, extra_emails=()
    ):
        request = RequestFactory().get("/")
        SessionMiddleware(lambda r: None).process_request(request)
        if invite:
            request.session["invite_secret"] = invite.secret
        request._messages = FallbackStorage(request)
        request.user = user or AnonymousUser()
        request.branding = settings.BRAND
        request.org = None

        with allauth_context.request_context(request):
            provider = get_social_adapter().get_provider(request, provider_id)
            sociallogin = provider.sociallogin_from_response(request, response)
            sociallogin.email_addresses += [EmailAddress(email=e, verified=True, primary=False) for e in extra_emails]
            sociallogin.state = {"process": process}
            complete_social_login(request, sociallogin)

        return request

    @patch("temba.users.models.User.fetch_avatar")
    def test_social_login(self, mock_fetch_avatar):
        def google_settings(**kwargs):
            google = {"EMAIL_AUTHENTICATION": True, "APPS": [{"client_id": "1234", "secret": "sesame"}]}
            return override_settings(SOCIALACCOUNT_PROVIDERS={"google": {**google, **kwargs}})

        def social_login(data: dict, **kwargs):
            return self._social_login("google", data, **kwargs)

        # google is trusted for email authentication by default
        self.assertTrue(settings.SOCIALACCOUNT_PROVIDERS["google"]["EMAIL_AUTHENTICATION"])

        self.enterContext(google_settings())

        # older email addresses may not be stored lowercase
        user = self.create_user("bob.smith@temba.io")
        EmailAddress.objects.create(user=user, email="Bob.Smith@temba.io", verified=True, primary=True)

        # social login with an email the provider hasn't verified doesn't connect to the existing user with that email
        request = social_login({"sub": "1001", "email": "bob.smith@temba.io", "email_verified": False})
        self.assertNotIn("_auth_user_id", request.session)
        self.assertFalse(SocialAccount.objects.filter(user=user).exists())

        # unless the provider is configured as verifying emails
        with google_settings(VERIFIED_EMAIL=True):
            request = social_login({"sub": "1001", "email": "bob.smith@temba.io", "email_verified": False})
            self.assertEqual(str(user.id), request.session["_auth_user_id"])

        SocialAccount.objects.filter(user=user).delete()

        # providers that don't report an email (Google always does, but others like Azure AD may not) are checked for
        # one in other fields, which again is only considered verified if the provider is configured that way
        request = social_login({"sub": "1001", "upn": "bob.smith@temba.io"})
        self.assertNotIn("_auth_user_id", request.session)
        self.assertFalse(SocialAccount.objects.filter(user=user).exists())

        with google_settings(VERIFIED_EMAIL=True):
            request = social_login({"sub": "1001", "upn": "bob.smith@temba.io"})
            self.assertEqual(str(user.id), request.session["_auth_user_id"])

        SocialAccount.objects.filter(user=user).delete()
        mock_fetch_avatar.reset_mock()

        # social login with a verified email connects the social account to the existing user with that email and logs
        # them in, even if the email case differs
        request = social_login({"sub": "1001", "email": "bob.smith@temba.io", "email_verified": True})
        self.assertEqual(str(user.id), request.session["_auth_user_id"])
        self.assertEqual({"1001"}, set(SocialAccount.objects.filter(user=user).values_list("uid", flat=True)))
        self.assertEqual(1, mock_fetch_avatar.call_count)

        self.assertTrue(User.objects.get(id=user.id).has_usable_password())

        # and next time that social account is found directly
        request = social_login({"sub": "1001", "email": "bob.smith@temba.io", "email_verified": True})
        self.assertEqual(str(user.id), request.session["_auth_user_id"])
        self.assertEqual(1, SocialAccount.objects.filter(user=user).count())
        self.assertEqual(1, mock_fetch_avatar.call_count)

        # a provider not trusted for email authentication can't log in as an existing user, even with a verified email
        with google_settings(EMAIL_AUTHENTICATION=False):
            request = social_login({"sub": "1004", "email": "bob.smith@temba.io", "email_verified": True})
            self.assertNotIn("_auth_user_id", request.session)
            self.assertFalse(SocialAccount.objects.filter(uid="1004").exists())

        # a logged in user connecting a social account with another user's email gets it connected to themselves
        social_login(
            {"sub": "1002", "email": "bob.smith@temba.io", "email_verified": True}, process="connect", user=self.admin
        )
        self.assertEqual(self.admin, SocialAccount.objects.get(uid="1002").user)
        self.assertEqual(1, SocialAccount.objects.filter(user=user).count())

        # social login for an email without an existing user doesn't create one, as signup is closed
        request = social_login({"sub": "1003", "email": "sid@temba.io", "email_verified": True})
        self.assertNotIn("_auth_user_id", request.session)
        self.assertFalse(User.objects.filter(email__iexact="sid@temba.io").exists())
        self.assertFalse(SocialAccount.objects.filter(uid="1003").exists())

        # even with an invite, if that's for a different email
        invite = Invitation.create(self.org, self.admin, "Sid@temba.io", OrgRole.EDITOR)
        request = social_login({"sub": "1003", "email": "eve@temba.io", "email_verified": True}, invite=invite)
        self.assertNotIn("_auth_user_id", request.session)
        self.assertFalse(User.objects.filter(email__iexact="eve@temba.io").exists())
        self.assertFalse(SocialAccount.objects.filter(uid="1003").exists())

        # but with an invite for that email, signup creates the user, with the email verified by the invite even if the
        # provider didn't verify it, and accepts the invite
        request = social_login({"sub": "1003", "email": "sid@temba.io", "email_verified": False}, invite=invite)
        sid = User.objects.get(email__iexact="sid@temba.io")
        self.assertEqual(str(sid.id), request.session["_auth_user_id"])
        self.assertEqual(sid, SocialAccount.objects.get(uid="1003").user)
        self.assertTrue(sid.emailaddress_set.get(email__iexact="sid@temba.io").verified)
        self.assertEqual(OrgRole.EDITOR, self.org.get_user_role(sid))

        # if the invite is for an email other than the provider's primary, that becomes the user's email.. but signup is
        # closed if that email already belongs to someone else
        invite = Invitation.create(self.org, self.admin, "tom@temba.io", OrgRole.EDITOR)
        other = self.create_user("other@temba.io")
        EmailAddress.objects.create(user=other, email="tom@temba.io", verified=False, primary=False)
        request = social_login(
            {"sub": "1005", "email": "tom@gmail.com", "email_verified": True},
            invite=invite,
            extra_emails=["tom@temba.io"],
        )
        self.assertNotIn("_auth_user_id", request.session)
        self.assertFalse(SocialAccount.objects.filter(uid="1005").exists())

        EmailAddress.objects.filter(user=other).delete()

        request = social_login(
            {"sub": "1005", "email": "tom@gmail.com", "email_verified": True},
            invite=invite,
            extra_emails=["tom@temba.io"],
        )
        tom = User.objects.get(email="tom@temba.io")
        self.assertEqual(str(tom.id), request.session["_auth_user_id"])
        self.assertEqual("tom@temba.io", tom.emailaddress_set.get(primary=True, verified=True).email)
        self.assertEqual(OrgRole.EDITOR, self.org.get_user_role(tom))

        # an existing user invited to another workspace, but logging in via a provider that can't connect them by
        # email, also finds signup closed
        invite = Invitation.create(self.org2, self.admin2, "tom@temba.io", OrgRole.EDITOR)
        with google_settings(EMAIL_AUTHENTICATION=False):
            request = social_login(
                {"sub": "1007", "email": "tom@gmail.com", "email_verified": True},
                invite=invite,
                extra_emails=["tom@temba.io"],
            )
        self.assertNotIn("_auth_user_id", request.session)
        self.assertFalse(SocialAccount.objects.filter(uid="1007").exists())

        # a user whose email was never verified may have been signed up by someone else, so connecting a social login
        # to them removes their password
        ann = self.create_user("ann@temba.io")
        EmailAddress.objects.create(user=ann, email=ann.email, verified=False, primary=True)
        social_login({"sub": "1006", "email": "ann@temba.io", "email_verified": True})
        self.assertEqual(ann, SocialAccount.objects.get(uid="1006").user)
        self.assertFalse(User.objects.get(id=ann.id).has_usable_password())

    @override_settings(
        SOCIALACCOUNT_PROVIDERS={
            "openid_connect": {
                "APPS": [
                    {
                        "provider_id": "corp",
                        "name": "Corp",
                        "client_id": "1234",
                        "secret": "sesame",
                        "settings": {
                            "server_url": "https://sso.corp.com",
                            "email_authentication": True,
                            "verified_email": True,
                        },
                    }
                ]
            }
        }
    )
    @patch("temba.users.models.User.fetch_avatar")
    def test_social_login_oidc(self, mock_fetch_avatar):
        # the openid_connect provider isn't an installed app, so register it for this test only
        registry.load()
        self.enterContext(patch.dict(registry.provider_map, {OpenIDConnectProvider.id: OpenIDConnectProvider}))

        # OIDC nests the claims under userinfo and id_token, and some providers (e.g. Azure AD) don't send
        # email_verified, so this app is configured as trusted for email authentication and as verifying emails
        def social_login(uid: str, claims: dict):
            claims = {"sub": uid, **claims}
            return self._social_login("corp", {"userinfo": claims, "id_token": claims})

        def create_user(email: str):
            user = self.create_user(email)
            EmailAddress.objects.create(user=user, email=email, verified=True, primary=True)
            return user

        user = create_user("Bob.Smith@temba.io")

        # the social account is connected to the existing user with that email
        request = social_login("2001", {"email": "bob.smith@temba.io"})
        self.assertEqual(str(user.id), request.session["_auth_user_id"])
        self.assertEqual({"2001"}, set(SocialAccount.objects.filter(user=user).values_list("uid", flat=True)))

        # including when the email is only provided as the upn
        user2 = create_user("ann@temba.io")
        request = social_login("2002", {"upn": "ann@temba.io"})
        self.assertEqual(str(user2.id), request.session["_auth_user_id"])
        self.assertTrue(SocialAccount.objects.filter(user=user2, uid="2002").exists())

        # or the preferred_username
        user3 = create_user("cat@temba.io")
        request = social_login("2003", {"preferred_username": "cat@temba.io"})
        self.assertEqual(str(user3.id), request.session["_auth_user_id"])
        self.assertTrue(SocialAccount.objects.filter(user=user3, uid="2003").exists())

        # but an email without an existing user still finds signup closed
        request = social_login("2004", {"email": "nobody@temba.io"})
        self.assertNotIn("_auth_user_id", request.session)
        self.assertFalse(SocialAccount.objects.filter(uid="2004").exists())

        # and without that configuration, emails aren't trusted to connect to existing users
        app = settings.SOCIALACCOUNT_PROVIDERS["openid_connect"]["APPS"][0]
        with override_settings(
            SOCIALACCOUNT_PROVIDERS={
                "openid_connect": {"APPS": [{**app, "settings": {"server_url": "https://sso.corp.com"}}]}
            }
        ):
            user4 = create_user("dan@temba.io")
            request = social_login("2005", {"email": "dan@temba.io"})
            self.assertNotIn("_auth_user_id", request.session)
            self.assertFalse(SocialAccount.objects.filter(user=user4).exists())

            request = social_login("2005", {"upn": "dan@temba.io"})
            self.assertNotIn("_auth_user_id", request.session)
            self.assertFalse(SocialAccount.objects.filter(user=user4).exists())

    def test_signup(self):
        signup_url = reverse("account_signup")

        # signup without an invite is closed
        response = self.client.get(signup_url)
        self.assertContains(response, "Sign Up Closed")

        # we also need to ensure they can't post
        response = self.client.post(
            signup_url,
            {
                "first_name": "Bobby",
                "last_name": "Burgers",
                "password1": "arstqwfp",
                "email": "bobbyburgers@burgers.com",
            },
        )
        self.assertContains(response, "Sign Up Closed")

        # but we still need to be able to accept an invite
        invitation = Invitation.create(self.org, self.admin, "bob@textit.com", OrgRole.ADMINISTRATOR)
        invite_signup = f"{signup_url}?invite={invitation.secret}"

        response = self.client.get(invite_signup)
        self.assertNotContains(response, "Sign Up Closed")

        # and we should be able to post - to the bare URL as browsers do, relying on the invite secret stored in the
        # session by the GET above.. and we handle tampering with the invite
        response = self.client.post(
            signup_url,
            {
                "first_name": "Bobby",
                "last_name": "Burgers",
                "email": "bobbyburgers@burgers.com",
                "password1": "arstqwfp",
            },
            follow=True,
        )

        # should get signed up, logged in and redirected to inbox
        self.assertNotContains(response, "Sign Up Closed")
        self.assertContains(response, "temba-msg-list")

        # make sure we didn't honor the tampered email
        self.assertFalse(User.objects.filter(email="bobbyburgers@burgers.com").exists())

        # we should now have a new user with the invitation email
        user = User.objects.filter(email="bob@textit.com").first()
        self.assertIsNotNone(user)

        email = user.emailaddress_set.all().first()
        self.assertTrue(email.verified)

        # posting with the invite only in the query string, without the GET that stores it in the session, still
        # enforces its email
        self.client.logout()
        invitation = Invitation.create(self.org, self.admin, "sam@textit.com", OrgRole.EDITOR)
        self.client.post(
            f"{signup_url}?invite={invitation.secret}",
            {"first_name": "Sam", "last_name": "Spoof", "email": "victim@burgers.com", "password1": "arstqwfp"},
        )
        self.assertFalse(User.objects.filter(email="victim@burgers.com").exists())
        self.assertTrue(User.objects.filter(email="sam@textit.com").exists())

        # and the page shows that invite, rather than one in the session
        self.client.logout()
        invitation2 = Invitation.create(self.org, self.admin, "tim@textit.com", OrgRole.EDITOR)
        invitation3 = Invitation.create(self.org, self.admin, "tia@textit.com", OrgRole.EDITOR)
        self.client.get(f"{signup_url}?invite={invitation2.secret}")
        response = self.client.post(f"{signup_url}?invite={invitation3.secret}", {"first_name": "Tia"})
        self.assertEqual(invitation3, response.context["invite"])
