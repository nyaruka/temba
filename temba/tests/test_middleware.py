import tempfile
from pathlib import Path

from django.conf import settings
from django.core.exceptions import DisallowedHost, MiddlewareNotUsed
from django.http import HttpResponse
from django.test import Client, RequestFactory, override_settings
from django.urls import reverse

from temba.middleware import NoStoreMiddleware, ProxiedRequestMiddleware
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


class ProxiedRequestTest(TembaTest):
    EXEMPT = dict(
        ALLOWED_HOSTS_EXEMPT_PATHS=("/system/ping/",),
        ALLOWED_HOSTS=["app.example.com"],
        BRAND={"domain": "app.example.com"},
    )
    SPLIT = dict(INTERNET_PORT=8020, INTERNAL_PORT=8021, ALLOWED_HOSTS_EXEMPT_PATHS=("/system/ping/",))

    def test_scheme_assumed_https(self):
        request = RequestFactory().get("/")
        self.assertFalse(request.is_secure())

        with override_settings(SECURE_ASSUME_HTTPS=True):
            ProxiedRequestMiddleware(lambda r: HttpResponse())(request)

        self.assertTrue(request.is_secure())
        self.assertEqual("https", request.scheme)

    def test_scheme_left_alone_when_not_assumed(self):
        request = RequestFactory().get("/")

        with override_settings(SECURE_ASSUME_HTTPS=False, **self.EXEMPT):
            ProxiedRequestMiddleware(lambda r: HttpResponse())(request)

        self.assertFalse(request.is_secure())

    def test_host_replaced_for_an_exempt_path(self):
        # a health checker addresses the instance by its own address, which is never one of our domains
        request = RequestFactory().get("/system/ping/", headers={"host": "10.0.1.23:8020"})

        with override_settings(**self.EXEMPT):
            ProxiedRequestMiddleware(lambda r: HttpResponse())(request)

            self.assertEqual("app.example.com", request.get_host())

    def test_forwarded_host_replaced_when_thats_what_is_trusted(self):
        request = RequestFactory().get(
            "/system/ping/", headers={"host": "10.0.1.23:8020", "x-forwarded-host": "10.0.1.23:8020"}
        )

        with override_settings(USE_X_FORWARDED_HOST=True, **self.EXEMPT):
            ProxiedRequestMiddleware(lambda r: HttpResponse())(request)

            self.assertEqual("app.example.com", request.get_host())

    def test_other_paths_are_untouched(self):
        request = RequestFactory().get("/msg/", headers={"host": "10.0.1.23:8020"})

        with override_settings(**self.EXEMPT):
            ProxiedRequestMiddleware(lambda r: HttpResponse())(request)

            self.assertRaises(DisallowedHost, request.get_host)

    def serve(self, path, port, **extra):
        request = RequestFactory().get(path, SERVER_PORT=str(port), **extra)
        return ProxiedRequestMiddleware(lambda r: HttpResponse("served"))(request)

    def test_internal_api_requires_the_token(self):
        with override_settings(INTERNAL_AUTH_TOKEN="topsecret", **self.SPLIT):
            self.assertEqual(
                b"served", self.serve("/ti/websockets/connect", 8021, HTTP_AUTHORIZATION="Token topsecret").content
            )

            # a bare 403 for a missing, wrong or differently framed token
            for header in (None, "Token open", "Bearer topsecret", "topsecret"):
                extra = {"HTTP_AUTHORIZATION": header} if header else {}
                response = self.serve("/ti/websockets/connect", 8021, **extra)
                self.assertEqual(403, response.status_code, header)
                self.assertEqual(b"", response.content)

            # nothing else asks for it
            self.assertEqual(b"served", self.serve("/msg/", 8020).content)
            self.assertEqual(b"served", self.serve("/system/ping/", 8021).content)

        # and with no token configured nothing under /ti/ is served at all
        with override_settings(INTERNAL_AUTH_TOKEN=None, **self.SPLIT):
            self.assertEqual(
                403, self.serve("/ti/websockets/connect", 8021, HTTP_AUTHORIZATION="Token None").status_code
            )

    def test_internal_port_serves_only_the_internal_api_and_health_check(self):
        with override_settings(**self.SPLIT):
            self.assertEqual(
                b"served", self.serve("/ti/websockets/connect", 8021, HTTP_AUTHORIZATION="Token topsecret").content
            )
            self.assertEqual(b"served", self.serve("/system/ping/", 8021).content)

            for path in ("/", "/msg/", "/api/v2/contacts.json", "/sitestatic/css/temba.css", "/system/ping"):
                self.assertEqual(404, self.serve(path, 8021).status_code, path)

    def test_internet_port_serves_everything_but_the_internal_api(self):
        # with TESTING off so that it's the port matching that serves these, not the allowance for the test client
        with override_settings(TESTING=False, **self.SPLIT):
            for path in ("/", "/msg/", "/api/v2/contacts.json", "/sitestatic/css/temba.css", "/system/ping/"):
                self.assertEqual(b"served", self.serve(path, 8020).content, path)

            self.assertEqual(404, self.serve("/ti/websockets/connect", 8020).status_code)

    def test_other_ports_serve_nothing(self):
        with override_settings(TESTING=False, **self.SPLIT):
            for path in ("/", "/msg/", "/system/ping/", "/ti/websockets/connect"):
                self.assertEqual(404, self.serve(path, 8000).status_code, path)

        # except under test, where the test client says everything arrived on port 80
        with override_settings(**self.SPLIT):
            self.assertEqual(b"served", self.serve("/", 80).content)
            self.assertEqual(404, self.serve("/ti/websockets/connect", 80).status_code)

    def test_port_is_the_one_connected_to_not_the_one_claimed(self):
        with override_settings(USE_X_FORWARDED_PORT=True, **self.SPLIT):
            self.assertEqual(404, self.serve("/ti/websockets/connect", 8020, HTTP_X_FORWARDED_PORT="8021").status_code)

    def test_through_the_whole_stack(self):
        # a fresh client so that the middleware is loaded with the split in place
        with override_settings(INTERNAL_AUTH_TOKEN="topsecret", **self.SPLIT):
            client = Client(HTTP_AUTHORIZATION="Token topsecret")
            internal, public = dict(SERVER_PORT="8021"), dict(SERVER_PORT="8020")

            self.assertEqual(
                200, client.post("/ti/websockets/connect", content_type="application/json", **internal).status_code
            )
            # refused outright, not with the 404 page - the middleware that gives it its context hasn't run
            response = client.get("/", **internal)
            self.assertEqual(404, response.status_code)
            self.assertEqual(b"", response.content)

            response = client.post("/ti/websockets/connect", content_type="application/json", **public)
            self.assertEqual(404, response.status_code)
            self.assertEqual(b"", response.content)
            self.assertEqual(200, client.get(reverse("public.public_index"), **public).status_code)

            # the wrong port is checked before the token, so a request with neither is still a 404
            response = Client().post("/ti/websockets/connect", content_type="application/json", **public)
            self.assertEqual(404, response.status_code)
            response = Client().post("/ti/websockets/connect", content_type="application/json", **internal)
            self.assertEqual(403, response.status_code)
            self.assertEqual(b"", response.content)

    def test_not_used_when_nothing_is_wanted(self):
        with override_settings(
            SECURE_ASSUME_HTTPS=False, ALLOWED_HOSTS_EXEMPT_PATHS=(), INTERNET_PORT=None, INTERNAL_PORT=None
        ):
            with self.assertRaises(MiddlewareNotUsed):
                ProxiedRequestMiddleware(lambda r: HttpResponse())

    def test_used_when_only_one_thing_is_wanted(self):
        for only in (
            dict(SECURE_ASSUME_HTTPS=True, ALLOWED_HOSTS_EXEMPT_PATHS=(), INTERNET_PORT=None, INTERNAL_PORT=None),
            dict(SECURE_ASSUME_HTTPS=False, INTERNET_PORT=None, INTERNAL_PORT=None, **self.EXEMPT),
            dict(SECURE_ASSUME_HTTPS=False, **self.SPLIT),
        ):
            with override_settings(**only):
                self.assertIsNotNone(ProxiedRequestMiddleware(lambda r: HttpResponse()))
