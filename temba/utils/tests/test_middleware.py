from django.conf import settings
from django.test import override_settings
from django.urls import reverse

from temba.orgs.models import OrgRole
from temba.tests import TembaTest, override_brand


class MiddlewareTest(TembaTest):
    def test_org(self):
        index_url = reverse("public.public_index")

        response = self.client.get(index_url)
        self.assertFalse(response.has_header("X-Temba-Workspace"))

        # if a user has a single org, that becomes the current org
        self.login(self.admin)

        response = self.client.get(index_url)
        self.assertEqual(str(self.org.uuid), response["X-Temba-Workspace"])

        # add them to another org
        self.org2.add_user(self.admin, OrgRole.ADMINISTRATOR)

        # we'll still have the original org
        response = self.client.get(index_url)
        self.assertEqual(str(self.org.uuid), response["X-Temba-Workspace"])

        # but when we login again, it'll select the newest org
        self.login(self.admin)
        response = self.client.get(index_url)
        self.assertEqual(str(self.org2.uuid), response["X-Temba-Workspace"])

        # org will be read from session if set
        s = self.client.session
        s.update({"org_id": self.org.id})
        s.save()

        response = self.client.get(index_url)
        self.assertEqual(str(self.org.uuid), response["X-Temba-Workspace"])

        # org can be sent as a header too and we check it matches
        response = self.client.post(reverse("flows.flow_create"), {}, headers={"X-Temba-Workspace": str(self.org.uuid)})
        self.assertEqual(200, response.status_code)

        response = self.client.post(
            reverse("flows.flow_create"), {}, headers={"X-Temba-Workspace": str(self.org2.uuid)}
        )
        self.assertEqual(403, response.status_code)

        # and a mismatch says which workspace the session is actually in
        self.assertEqual(str(self.org.uuid), response["X-Temba-Workspace"])

        self.login(self.customer_support)

        # our staff user doesn't have a default org
        response = self.client.get(index_url)
        self.assertFalse(response.has_header("X-Temba-Workspace"))

        # but they can specify an org to service as a header
        response = self.client.get(index_url, headers={"X-Temba-Service-Org": str(self.org.id)})
        self.assertEqual(str(self.org.uuid), response["X-Temba-Workspace"])

        response = self.client.get(index_url)
        self.assertFalse(response.has_header("X-Temba-Workspace"))

        # members of an org's admin groups can access it without a membership
        group_admin = self.create_user("gad@textit.com")
        self.create_admin_group("Global Admins", orgs=[self.org2], users=[group_admin])
        self.login(group_admin, choose_org=self.org2)

        response = self.client.get(index_url)
        self.assertEqual(str(self.org2.uuid), response["X-Temba-Workspace"])

        self.login(self.editor)

        response = self.client.get(index_url)
        self.assertEqual(str(self.org.uuid), response["X-Temba-Workspace"])
        # non-staff can't specify a different org from their own
        response = self.client.get(index_url, headers={"X-Temba-Service-Org": str(self.org2.id)})
        self.assertNotEqual(str(self.org2.uuid), response["X-Temba-Workspace"])

    def test_redirect(self):
        self.assertNotRedirect(self.client.get(reverse("public.public_index")), None)

        # now set our brand to redirect
        with override_brand(redirect="/redirect"):
            self.assertRedirect(self.client.get(reverse("public.public_index")), "/redirect")

    def test_language(self):
        def assert_text(text: str):
            self.assertContains(self.client.get(settings.LOGIN_URL, follow=True), text)

        # default is English
        assert_text("continue?")

        # can be overridden in Django settings
        with override_settings(DEFAULT_LANGUAGE="es"):
            assert_text("continuar?")

        # if we have an authenticated user, their setting takes priority
        self.login(self.admin)

        self.admin.language = "fr"
        self.admin.save(update_fields=("language",))

        assert_text("continuer?")
