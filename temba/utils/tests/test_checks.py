from django.test import override_settings

from temba.tests import TembaTest
from temba.utils.checks import mailers, ports, storage


class SystemChecksTest(TembaTest):
    def test_storage(self):
        self.assertEqual(len(storage(None)), 0)

        with override_settings(STORAGES={"default": {"BACKEND": "x"}, "staticfiles": {"BACKEND": "x"}}):
            self.assertEqual(storage(None)[0].msg, "Missing 'archives' storage config.")
            self.assertEqual(storage(None)[1].msg, "Missing 'public' storage config.")

        with override_settings(STORAGE_URL=None):
            self.assertEqual(storage(None)[0].msg, "No storage URL set.")

        with override_settings(STORAGE_URL="http://example.com/uploads/"):
            self.assertEqual(storage(None)[0].msg, "Storage URL shouldn't end with trailing slash.")

    def test_ports(self):
        self.assertEqual(len(ports(None)), 0)

        with override_settings(INTERNET_PORT=None, INTERNAL_PORT=None):
            self.assertEqual(len(ports(None)), 0)

        with override_settings(INTERNET_PORT=None):
            self.assertEqual(ports(None)[0].msg, "Only one of the internet and internal ports is set.")

        with override_settings(INTERNAL_PORT=None):
            self.assertEqual(ports(None)[0].msg, "Only one of the internet and internal ports is set.")

        with override_settings(INTERNET_PORT=8021):
            self.assertEqual(ports(None)[0].msg, "The internet and internal ports are the same.")

    def test_mailers(self):
        self.assertEqual(
            len(mailers(None)), 0
        )  # in tests the custom SMTP mailer is the locmem backend which is allowed

        LOCMEM = {"BACKEND": "django.core.mail.backends.locmem.EmailBackend"}
        CUSTOM_SMTP = {"BACKEND": "temba.utils.email.backend.CustomSMTPBackend"}

        with override_settings(MAILERS={"marketing": LOCMEM}):
            self.assertEqual(mailers(None)[0].msg, "Missing 'default' mailer config.")
            self.assertEqual(mailers(None)[1].msg, "Missing 'custom_smtp' mailer config.")

        with override_settings(MAILERS={"default": LOCMEM, "custom_smtp": CUSTOM_SMTP}):
            self.assertEqual(len(mailers(None)), 0)

        # the custom SMTP mailer using a regular SMTP backend is a misconfiguration that would silently send workspace
        # branded email via the default SMTP server
        with override_settings(
            MAILERS={"default": LOCMEM, "custom_smtp": {"BACKEND": "django.core.mail.backends.smtp.EmailBackend"}}
        ):
            self.assertEqual(
                mailers(None)[0].msg,
                "Mailer 'custom_smtp' must use a backend which supports per-message SMTP configuration.",
            )

        # as is a backend that can't be imported
        with override_settings(MAILERS={"default": LOCMEM, "custom_smtp": {"BACKEND": "no.such.Backend"}}):
            self.assertEqual(
                mailers(None)[0].msg,
                "Mailer 'custom_smtp' must use a backend which supports per-message SMTP configuration.",
            )
