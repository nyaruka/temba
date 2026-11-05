from unittest.mock import MagicMock, patch

from allauth.account.adapter import DefaultAccountAdapter
from allauth.account.models import EmailAddress
from allauth.socialaccount.adapter import DefaultSocialAccountAdapter
from allauth.socialaccount.models import SocialAccount, SocialLogin

from django.conf import settings
from django.contrib.messages import get_messages
from django.contrib.messages.storage.fallback import FallbackStorage
from django.test import RequestFactory

from temba.orgs.models import Invitation, OrgRole
from temba.tests.base import TembaTest
from temba.users.adapter import TembaAccountAdapter, TembaSocialAccountAdapter
from temba.users.models import User


class SSOAdapterTest(TembaTest):
    def setUp(self):
        super().setUp()
        self.factory = RequestFactory()
        self.adapter = TembaSocialAccountAdapter()
        self.account_adapter = TembaAccountAdapter()

    def _make_sociallogin(self, email, **extra_data):
        sociallogin = SocialLogin()
        sociallogin.user = User()
        sociallogin.account = SocialAccount(
            provider="openid_connect",
            uid="uid-test",
            extra_data={"email": email, **extra_data},
        )
        return sociallogin

    def _make_request(self):
        request = self.factory.get("/accounts/login/")
        request.session = self.client.session
        request.branding = settings.BRAND
        request._messages = FallbackStorage(request)
        return request

    def _run_pre_social_login(self, request, sociallogin):
        def connect(social_login, request, user, *args, **kwargs):
            social_login.user = user

        with patch.object(SocialLogin, "connect", connect):
            self.adapter.pre_social_login(request, sociallogin)

    def test_extract_email_from_upn(self):
        sociallogin = self._make_sociallogin("", upn="user@unicef.org")
        self.assertEqual("user@unicef.org", TembaSocialAccountAdapter.extract_email(sociallogin))

    def test_extract_email_from_nested_userinfo(self):
        sociallogin = SocialLogin()
        sociallogin.user = User()
        sociallogin.account = SocialAccount(
            provider="unicef",
            uid="uid-nested",
            extra_data={
                "userinfo": {"preferred_username": "user@unicef.org", "email_verified": False},
                "id_token": {"sub": "oid-123"},
            },
        )
        self.assertEqual("user@unicef.org", TembaSocialAccountAdapter.extract_email(sociallogin))

    def test_extract_email_from_email_addresses(self):
        sociallogin = self._make_sociallogin("")
        sociallogin.email_addresses = [EmailAddress(email="user@unicef.org", verified=False, primary=True)]
        self.assertEqual("user@unicef.org", TembaSocialAccountAdapter.extract_email(sociallogin))

    def test_is_email_verified_for_openid_connect(self):
        provider = MagicMock()
        provider.id = "unicef"
        self.assertTrue(self.adapter.is_email_verified(provider, "user@unicef.org"))

    def test_can_authenticate_by_email(self):
        self.assertTrue(self.adapter.can_authenticate_by_email(MagicMock(), "user@unicef.org"))

    def test_populate_user_marks_email_addresses_verified(self):
        request = self._make_request()
        sociallogin = SocialLogin()
        sociallogin.user = User()
        sociallogin.account = SocialAccount(
            provider="unicef",
            uid="uid-populate",
            extra_data={"userinfo": {"preferred_username": "user@unicef.org"}},
        )

        user = self.adapter.populate_user(request, sociallogin, {})

        self.assertEqual("user@unicef.org", user.email)
        self.assertEqual(1, len(sociallogin.email_addresses))
        self.assertEqual("user@unicef.org", sociallogin.email_addresses[0].email)
        self.assertTrue(sociallogin.email_addresses[0].verified)

    def test_pre_social_login_replaces_unverified_email_addresses(self):
        user = User.objects.create_user(
            email="user@unicef.org",
            password=self.default_password,
            first_name="Test",
            last_name="User",
        )
        EmailAddress.objects.filter(user=user).update(verified=False)

        request = self._make_request()
        sociallogin = self._make_sociallogin("user@unicef.org")
        sociallogin.email_addresses = [EmailAddress(email="user@unicef.org", verified=False, primary=True)]

        self._run_pre_social_login(request, sociallogin)

        self.assertTrue(sociallogin.email_addresses[0].verified)

    def test_pre_social_login_marks_existing_unverified_email_as_verified(self):
        user = User.objects.create_user(
            email="user@unicef.org",
            password=self.default_password,
            first_name="Test",
            last_name="User",
        )
        EmailAddress.objects.filter(user=user).update(verified=False)

        request = self._make_request()
        sociallogin = self._make_sociallogin("user@unicef.org")

        self._run_pre_social_login(request, sociallogin)

        self.assertEqual(user, sociallogin.user)
        self.assertTrue(EmailAddress.objects.get(user=user).verified)

    def test_pre_social_login_connects_existing_user_with_case_mismatch(self):
        user = User.objects.create_user(
            email="User@unicef.org",
            password=self.default_password,
            first_name="Test",
            last_name="User",
        )
        EmailAddress.objects.filter(user=user).update(verified=False)

        request = self._make_request()
        sociallogin = self._make_sociallogin("user@unicef.org")

        self._run_pre_social_login(request, sociallogin)

        self.assertEqual(user, sociallogin.user)
        self.assertTrue(EmailAddress.objects.get(user=user).verified)

    def test_pre_social_login_finds_user_by_emailaddress_when_user_email_differs(self):
        user = User.objects.create_user(
            email="old@unicef.org",
            password=self.default_password,
            first_name="Test",
            last_name="User",
        )
        EmailAddress.objects.filter(user=user).delete()
        EmailAddress.objects.create(user=user, email="user@unicef.org", verified=False, primary=True)

        request = self._make_request()
        sociallogin = self._make_sociallogin("user@unicef.org")

        self._run_pre_social_login(request, sociallogin)

        self.assertEqual(user, sociallogin.user)
        self.assertTrue(EmailAddress.objects.get(user=user, email="user@unicef.org").verified)

    def test_pre_social_login_keeps_verified_email_for_existing_user(self):
        user = User.objects.create_user(
            email="verified@unicef.org",
            password=self.default_password,
            first_name="Test",
            last_name="User",
        )
        EmailAddress.objects.update_or_create(user=user, email=user.email, defaults={"verified": True, "primary": True})

        request = self._make_request()
        sociallogin = self._make_sociallogin("verified@unicef.org")

        self._run_pre_social_login(request, sociallogin)

        self.assertEqual(user, sociallogin.user)
        self.assertTrue(EmailAddress.objects.get(user=user).verified)

    def test_save_user_marks_new_user_email_as_verified(self):
        request = self._make_request()
        sociallogin = self._make_sociallogin("newuser@unicef.org")
        user = User.objects.create_user(
            email="newuser@unicef.org",
            password=self.default_password,
            first_name="New",
            last_name="User",
        )

        with patch.object(DefaultSocialAccountAdapter, "save_user", return_value=user):
            saved_user = self.adapter.save_user(request, sociallogin)

        self.assertEqual(user, saved_user)
        self.assertTrue(EmailAddress.objects.get(user=user).verified)

    def test_post_login_accepts_invite_with_case_insensitive_email(self):
        invitation = Invitation.create(self.org, self.admin, "User@unicef.org", OrgRole.EDITOR)
        user = User.create("user@unicef.org", "Test", "User", password=self.default_password)

        request = self._make_request()
        request.session["invite_secret"] = invitation.secret
        self.account_adapter.request = request

        with patch.object(DefaultAccountAdapter, "post_login", return_value=None):
            self.account_adapter.post_login(
                request,
                user,
                email_verification=None,
                signal_kwargs={},
                email=user.email,
                signup=False,
                redirect_url="/org/choose/",
            )

        invitation.refresh_from_db()
        self.assertFalse(invitation.is_active)
        self.assertTrue(user.get_orgs().filter(id=self.org.id).exists())

    def test_post_login_does_not_accept_invite_with_different_email(self):
        invitation = Invitation.create(self.org, self.admin, "other@unicef.org", OrgRole.EDITOR)
        user = User.create("user@unicef.org", "Test", "User", password=self.default_password)

        request = self._make_request()
        request.session["invite_secret"] = invitation.secret
        self.account_adapter.request = request

        with patch.object(DefaultAccountAdapter, "post_login", return_value=None):
            self.account_adapter.post_login(
                request,
                user,
                email_verification=None,
                signal_kwargs={},
                email=user.email,
                signup=False,
                redirect_url="/org/choose/",
            )

        invitation.refresh_from_db()
        self.assertTrue(invitation.is_active)
        self.assertFalse(user.get_orgs().filter(id=self.org.id).exists())

        messages = [str(m.message) for m in get_messages(request)]
        self.assertTrue(any("other@unicef.org" in message for message in messages))

    def test_social_post_login_delegates_to_account_adapter(self):
        invitation = Invitation.create(self.org, self.admin, "user@unicef.org", OrgRole.EDITOR)
        user = User.create("user@unicef.org", "Test", "User", password=self.default_password)

        request = self._make_request()
        request.session["invite_secret"] = invitation.secret
        self.adapter.request = request

        with patch.object(TembaAccountAdapter, "post_login", return_value=None) as account_post_login:
            self.adapter.post_login(
                request,
                user,
                email_verification=None,
                signal_kwargs={},
                email=user.email,
                signup=False,
                redirect_url="/org/choose/",
            )

        account_post_login.assert_called_once()
        invitation.refresh_from_db()
        self.assertFalse(invitation.is_active)

    def test_send_mail_includes_email_in_context(self):
        request = self._make_request()
        self.account_adapter.request = request
        context = {"password_reset_url": "https://example.com/reset"}

        with patch("temba.users.adapter.EmailSender.from_email_type") as from_email_type:
            sender = MagicMock()
            from_email_type.return_value = sender
            self.account_adapter.send_mail("account/email/account_already_exists", "user@unicef.org", context)

        sender.send.assert_called_once()
        recipients, template, sent_context = sender.send.call_args.args
        self.assertEqual(["user@unicef.org"], recipients)
        self.assertEqual("account/email/account_already_exists", template)
        self.assertEqual("user@unicef.org", sent_context["email"])
