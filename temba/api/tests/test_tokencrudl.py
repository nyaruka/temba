from django.urls import reverse

from temba.api.models import APIToken
from temba.orgs.models import OrgRole
from temba.tests import CRUDLTestMixin, TembaTest


class APITokenCRUDLTest(CRUDLTestMixin, TembaTest):
    def test_list(self):
        tokens_url = reverse("api.apitoken_list")

        self.assertRequestDisallowed(tokens_url, [None, self.agent])
        response = self.assertListFetch(tokens_url, [self.editor, self.admin], context_objects=[])

        # the temba-apitoken-list component fetches the tokens itself from the internal API
        self.assertContains(response, "temba-apitoken-list")
        self.assertEqual(f"{reverse('api.internal.api_tokens')}.json", response.context["list_url"])
        self.assertEqual(3, response.context["token_limit"])

        # and never contains full keys
        token1 = APIToken.create(self.org, self.admin)
        response = self.requestView(tokens_url, self.admin)
        self.assertNotContains(response, token1.key)

        self.assertContentMenu(tokens_url, self.admin, ["New"])

        # once a user has reached the limit, the option to create a new token is gone
        APIToken.create(self.org, self.admin)
        APIToken.create(self.org, self.admin)
        self.assertContentMenu(tokens_url, self.admin, [])

        # but that's per user
        self.assertContentMenu(tokens_url, self.editor, ["New"])

    def test_create(self):
        create_url = reverse("api.apitoken_create")

        self.assertRequestDisallowed(create_url, [None, self.agent])

        response = self.requestView(create_url, self.admin)
        self.assertEqual(200, response.status_code)
        self.assertContains(response, "Its key will only be shown once")
        self.assertContains(response, 'type="submit"')

        # add user to other org and create API tokens for both
        self.org2.add_user(self.admin, OrgRole.EDITOR)
        token1 = APIToken.create(self.org, self.admin)
        APIToken.create(self.org, self.editor)  # other user
        APIToken.create(self.org2, self.admin)  # other org

        # POSTing creates a token and responds with its key, the only time it's shown, rather than redirecting
        response = self.requestView(create_url, self.admin, post_data={}, choose_org=self.org)
        self.assertEqual(200, response.status_code)
        self.assertEqual(2, self.admin.get_api_tokens(self.org).count())
        token2 = self.admin.get_api_tokens(self.org).order_by("created").last()
        self.assertNotEqual(token1, token2)
        self.assertEqual(token2.key, response.context["new_key"])
        self.assertContains(response, token2.key)
        self.assertNotContains(response, 'type="submit"')

        # editors can create tokens too
        response = self.requestView(create_url, self.editor, post_data={})
        self.assertEqual(200, response.status_code)
        self.assertEqual(2, self.editor.get_api_tokens(self.org).count())

        APIToken.create(self.org, self.admin)

        # once at the limit, the modal says so and POSTing is a noop
        response = self.requestView(create_url, self.admin, choose_org=self.org)
        self.assertContains(response, "You already have the maximum of 3 tokens")
        self.assertNotContains(response, 'type="submit"')

        response = self.requestView(create_url, self.admin, post_data={}, choose_org=self.org)
        self.assertEqual(200, response.status_code)
        self.assertIsNone(response.context["new_key"])
        self.assertEqual(3, self.admin.get_api_tokens(self.org).count())

    def test_delete(self):
        token1 = APIToken.create(self.org, self.admin)
        token2 = APIToken.create(self.org, self.editor)

        delete_url = reverse("api.apitoken_delete", args=[token1.digest])

        # tokens are referenced by their digest, not their key
        self.assertRequestDisallowed(reverse("api.apitoken_delete", args=[token1.key]), [self.admin])
        self.assertRequestDisallowed(delete_url, [self.editor, self.admin2])

        response = self.assertDeleteFetch(delete_url, [self.admin], as_modal=True)
        self.assertContains(response, f"You are about to delete the API token <b>{token1.key[:6]}…</b>")

        response = self.assertDeleteSubmit(delete_url, self.admin, object_deactivated=token1)
        self.assertRedirect(response, "/apitoken/")

        token1.refresh_from_db()
        token2.refresh_from_db()

        self.assertIsNotNone(token1.deleted_on)
        self.assertIsNone(token2.deleted_on)
