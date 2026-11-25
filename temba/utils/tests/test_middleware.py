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

        self.login(self.customer_support)

        # our staff user doesn't have a default org
        response = self.client.get(index_url)
        self.assertFalse(response.has_header("X-Temba-Workspace"))

        # but they can specify an org to service as a header
        response = self.client.get(index_url, headers={"X-Temba-Service-Org": str(self.org.id)})
        self.assertEqual(str(self.org.uuid), response["X-Temba-Workspace"])

        response = self.client.get(index_url)
        self.assertFalse(response.has_header("X-Temba-Workspace"))

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

    def test_preview(self):
        index_url = reverse("public.public_index")

        # an unauthenticated request can't toggle the cookie — blocks cross-origin <img src=".../?preview=1"> planting
        response = self.client.get(index_url + "?preview=1")
        self.assertNotIn("temba-preview", response.cookies)
        self.assertFalse(response.wsgi_request.preview)

        self.login(self.admin)

        # ?preview=1 opts in and sets the year-long hardened cookie, with request.preview set on the same request
        response = self.client.get(index_url + "?preview=1")
        cookie = response.cookies["temba-preview"]
        self.assertEqual("1", cookie.value)
        self.assertEqual(365 * 24 * 60 * 60, cookie["max-age"])
        self.assertEqual("Lax", cookie["samesite"])
        self.assertTrue(cookie["httponly"])
        self.assertTrue(response.wsgi_request.preview)

        # subsequent request without the toggle reads the cookie back
        response = self.client.get(index_url)
        self.assertTrue(response.wsgi_request.preview)
        self.assertNotIn("temba-preview", response.cookies)

        # unrecognized values don't toggle and fall back to the cookie
        response = self.client.get(index_url + "?preview=on")
        self.assertTrue(response.wsgi_request.preview)
        self.assertNotIn("temba-preview", response.cookies)

        # ?preview=0 opts out and clears the cookie
        response = self.client.get(index_url + "?preview=0")
        self.assertEqual("", response.cookies["temba-preview"].value)
        self.assertFalse(response.wsgi_request.preview)

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
