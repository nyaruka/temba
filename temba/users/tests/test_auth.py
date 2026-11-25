from urllib.parse import urlencode

from django.core import mail
from django.test import override_settings
from django.urls import reverse

from temba.orgs.models import Invitation, OrgMembership, OrgRole
from temba.tests.base import TembaTest
from temba.users.models import User


class UserAuthTest(TembaTest):
    # Auth is handled by allauth, only test things we override in any way
    def test_signup(self):
        signup_url = reverse("account_signup")
        success_url = reverse("orgs.org_choose")

        response = self.client.get(signup_url)
        self.assertEqual(200, response.status_code)

        # bad inputs
        response = self.client.post(signup_url, {"email": "invalid"})
        self.assertEqual(200, response.status_code)
        form = response.context.get("form")
        self.assertFormError(form, "email", "Enter a valid email address.")
        self.assertFormError(form, "first_name", "This field is required.")
        self.assertFormError(form, "last_name", "This field is required.")

        # test valid signup
        response = self.client.post(
            signup_url,
            {
                "first_name": "Bobby",
                "last_name": "Burgers",
                "password1": "arstqwfp",
                "email": "bobbyburgers@burgers.com",
            },
        )

        self.assertRedirect(response, success_url)

        self.assertEqual(1, len(mail.outbox))
        self.assertEqual("Please Confirm Your Email Address", mail.outbox[0].subject)
        self.assertEqual(["bobbyburgers@burgers.com"], mail.outbox[0].recipients())

        # user should exist but have no org membership (workspace created after email verification)
        user = User.objects.get(email="bobbyburgers@burgers.com")
        self.assertFalse(OrgMembership.objects.filter(user=user).exists())

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

    @override_settings(BRAND={"features": []})
    def test_invite_with_closed_signups(self):
        signup_url = reverse("account_signup")

        # make sure we can't access the signup page
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

        # and we should be able to post.. but we handle tampering with the invite
        response = self.client.post(
            invite_signup,
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
        self.assertContains(response, "Your Message Hub")

        # make sure we didn't honor the tampered email
        self.assertFalse(User.objects.filter(email="bobbyburgers@burgers.com").exists())

        # we should now have a new user with the invitation email
        user = User.objects.filter(email="bob@textit.com").first()
        self.assertIsNotNone(user)

        email = user.emailaddress_set.all().first()
        self.assertTrue(email.verified)
