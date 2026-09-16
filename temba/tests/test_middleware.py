import tempfile
from pathlib import Path

from django.conf import settings
from django.core.exceptions import DisallowedHost, MiddlewareNotUsed
from django.http import HttpResponse
from django.test import Client, RequestFactory, override_settings
from django.urls import reverse

from temba.middleware import AssumeHTTPSMiddleware, HealthCheckHostMiddleware, NoStoreMiddleware
from temba.tests import TembaTest


class ResponseHeadersTest(TembaTest):
    """
    The headers every response should carry come from the app itself, whatever is or isn't proxying to it.
    """

    def test_dynamic(self):
        response = self.client.get(reverse("public.public_index"), HTTP_ACCEPT_ENCODING="gzip")

        self.assertEqual(200, response.status_code)
        self.assertEqual("no-store", response["Cache-Control"])
        self.assertEqual("DENY", response["X-Frame-Options"])
        self.assertEqual("frame-ancestors 'none'", response["Content-Security-Policy"])
        self.assertEqual("nosniff", response["X-Content-Type-Options"])
        self.assertEqual("strict-origin-when-cross-origin", response["Referrer-Policy"])
        self.assertEqual("gzip", response["Content-Encoding"])

    def test_static(self):
        with tempfile.TemporaryDirectory() as static_root:
            Path(static_root, "test.js").write_text("console.log('hi');\n" * 20)

            # a fresh client so that WhiteNoise indexes this static root when its middleware is loaded
            with override_settings(STATIC_ROOT=static_root):
                response = Client().get(f"{settings.STATIC_URL}test.js", HTTP_ACCEPT_ENCODING="gzip")

            self.assertEqual(200, response.status_code)
            self.assertEqual("DENY", response["X-Frame-Options"])
            self.assertEqual("frame-ancestors 'none'", response["Content-Security-Policy"])
            self.assertEqual("nosniff", response["X-Content-Type-Options"])

            # served as it is on disk with a far-future max-age, so neither gzipped on the way out nor marked no-store
            self.assertEqual("max-age=315360000, public", response["Cache-Control"])
            self.assertNotIn("Content-Encoding", response)

    def test_no_store_leaves_explicit_caching_alone(self):
        request = RequestFactory().get("/")
        middleware = NoStoreMiddleware(lambda r: HttpResponse("ok", headers={"Cache-Control": "max-age=60"}))

        self.assertEqual("max-age=60", middleware(request)["Cache-Control"])


class AssumeHTTPSTest(TembaTest):
    def test_scheme(self):
        request = RequestFactory().get("/")
        self.assertFalse(request.is_secure())

        with override_settings(SECURE_ASSUME_HTTPS=True):
            AssumeHTTPSMiddleware(lambda r: HttpResponse())(request)

        self.assertTrue(request.is_secure())
        self.assertEqual("https", request.scheme)

    def test_not_used_when_off(self):
        with self.assertRaises(MiddlewareNotUsed):
            AssumeHTTPSMiddleware(lambda r: HttpResponse())


class HealthCheckHostTest(TembaTest):
    def test_host_replaced_for_the_health_check_path(self):
        # a health checker addresses the instance by its own address, which is never one of our domains
        request = RequestFactory().get("/system/ping/", headers={"host": "10.0.1.23:8020"})

        with override_settings(
            HEALTH_CHECK_PATH="/system/ping/", ALLOWED_HOSTS=["app.example.com"], BRAND={"domain": "app.example.com"}
        ):
            HealthCheckHostMiddleware(lambda r: HttpResponse())(request)

            self.assertEqual("app.example.com", request.get_host())

    def test_forwarded_host_replaced_when_thats_what_is_trusted(self):
        request = RequestFactory().get(
            "/system/ping/", headers={"host": "10.0.1.23:8020", "x-forwarded-host": "10.0.1.23:8020"}
        )

        with override_settings(
            HEALTH_CHECK_PATH="/system/ping/",
            ALLOWED_HOSTS=["app.example.com"],
            BRAND={"domain": "app.example.com"},
            USE_X_FORWARDED_HOST=True,
        ):
            HealthCheckHostMiddleware(lambda r: HttpResponse())(request)

            self.assertEqual("app.example.com", request.get_host())

    def test_other_paths_are_untouched(self):
        request = RequestFactory().get("/msg/", headers={"host": "10.0.1.23:8020"})

        with override_settings(
            HEALTH_CHECK_PATH="/system/ping/", ALLOWED_HOSTS=["app.example.com"], BRAND={"domain": "app.example.com"}
        ):
            HealthCheckHostMiddleware(lambda r: HttpResponse())(request)

            self.assertRaises(DisallowedHost, request.get_host)

    def test_not_used_when_no_health_check_path(self):
        with override_settings(HEALTH_CHECK_PATH=None):
            with self.assertRaises(MiddlewareNotUsed):
                HealthCheckHostMiddleware(lambda r: HttpResponse())
