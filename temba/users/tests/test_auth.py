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

    def _social_login(self, provider_id: str, response: dict):
        request = RequestFactory().get("/")
        SessionMiddleware(lambda r: None).process_request(request)
        request._messages = FallbackStorage(request)
        request.user = AnonymousUser()
        request.branding = settings.BRAND
        request.org = None

        with allauth_context.request_context(request):
            provider = get_social_adapter().get_provider(request, provider_id)
            sociallogin = provider.sociallogin_from_response(request, response)
            sociallogin.state = {"process": "login"}
            complete_social_login(request, sociallogin)

        return request

    @override_settings(SOCIALACCOUNT_PROVIDERS={"google": {"APPS": [{"client_id": "1234", "secret": "sesame"}]}})
    @patch("temba.users.models.User.fetch_avatar")
    def test_social_login(self, mock_fetch_avatar):
        def social_login(uid: str, email: str):
            return self._social_login("google", {"sub": uid, "email": email, "email_verified": True})

        # social login for an email with an existing user connects the social account to that user and logs them in,
        # even if the email case differs
        user = self.create_user("Bob.Smith@temba.io")
        EmailAddress.objects.create(user=user, email=user.email, verified=True, primary=True)
        request = social_login("1001", "bob.smith@temba.io")
        self.assertEqual(str(user.id), request.session["_auth_user_id"])
        self.assertEqual({"1001"}, set(SocialAccount.objects.filter(user=user).values_list("uid", flat=True)))

        # and next time that social account is found directly
        request = social_login("1001", "bob.smith@temba.io")
        self.assertEqual(str(user.id), request.session["_auth_user_id"])
        self.assertEqual(1, SocialAccount.objects.filter(user=user).count())

        # but social login for an email without an existing user doesn't create one, as signup is closed
        request = social_login("1002", "nobody@temba.io")
        self.assertNotIn("_auth_user_id", request.session)
        self.assertFalse(User.objects.filter(email__iexact="nobody@temba.io").exists())
        self.assertFalse(SocialAccount.objects.filter(uid="1002").exists())

    @override_settings(
        SOCIALACCOUNT_PROVIDERS={
            "openid_connect": {
                "APPS": [
                    {
                        "provider_id": "corp",
                        "name": "Corp",
                        "client_id": "1234",
                        "secret": "sesame",
                        "settings": {"server_url": "https://sso.corp.com"},
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
        # email_verified, so allauth itself won't match the email to an existing user
        def social_login(uid: str, claims: dict):
            claims = {"sub": uid, **claims}
            return self._social_login("corp", {"userinfo": claims, "id_token": claims})

        def create_user(email: str):
            user = self.create_user(email)
            EmailAddress.objects.create(user=user, email=email, verified=True, primary=True)
            return user

        user = create_user("Bob.Smith@temba.io")

        # the social account is still connected to the existing user with that email
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
