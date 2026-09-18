from django.conf import settings
from django.core.checks import Error, register
from django.core.checks.mail import NON_PRODUCTION_EMAIL_BACKENDS
from django.core.mail import DEFAULT_MAILER_ALIAS
from django.utils.module_loading import import_string

from temba.utils.email.backend import CUSTOM_SMTP_MAILER_ALIAS, CustomSMTPBackend


@register()
def storage(app_configs, **kwargs):
    errors = []

    for name in ("default", "archives", "public", "staticfiles"):
        if name not in settings.STORAGES:
            errors.append(
                Error(
                    f"Missing '{name}' storage config.",
                    hint=f"Add configuration for '{name}' to STORAGES in Django settings.",
                )
            )

    if not settings.STORAGE_URL:
        errors.append(
            Error(
                "No storage URL set.",
                hint='Set STORAGE_URL in your Django settings. Should be "https://"+AWS_BUCKET_DOMAIN if using S3.',
            )
        )
    elif settings.STORAGE_URL.endswith("/"):
        errors.append(
            Error("Storage URL shouldn't end with trailing slash.", hint="Remove trailing slash in STORAGE_URL.")
        )
    return errors


@register()
def ports(app_configs, **kwargs):
    internet, internal = settings.INTERNET_PORT, settings.INTERNAL_PORT

    if (internet is None) != (internal is None):
        return [
            Error(
                "Only one of the internet and internal ports is set.",
                hint="Set both INTERNET_PORT and INTERNAL_PORT in Django settings, or neither to serve everything on one port.",
            )
        ]
    if internet is not None and internet == internal:
        return [
            Error(
                "The internet and internal ports are the same.",
                hint="Set INTERNET_PORT and INTERNAL_PORT in Django settings to two different ports.",
            )
        ]
    return []


@register()
def internal_auth_token(app_configs, **kwargs):
    if not settings.INTERNAL_AUTH_TOKEN:
        return [
            Error(
                "INTERNAL_AUTH_TOKEN is not set.",
                hint="Set INTERNAL_AUTH_TOKEN in Django settings to the shared secret the services calling the "
                "internal-only API are configured with. Nothing under /ti/ is served without it.",
            )
        ]
    return []


@register()
def mailers(app_configs, **kwargs):
    errors = []
    config = getattr(settings, "MAILERS", {})

    for alias in (DEFAULT_MAILER_ALIAS, CUSTOM_SMTP_MAILER_ALIAS):
        if alias not in config:
            errors.append(
                Error(
                    f"Missing '{alias}' mailer config.",
                    hint=f"Add configuration for '{alias}' to MAILERS in Django settings.",
                )
            )

    # the custom SMTP mailer must use a backend which reads SMTP configuration off each message, tho we also allow the
    # non-production backends so that tests and dev environments work as usual
    custom_smtp = config.get(CUSTOM_SMTP_MAILER_ALIAS)
    if custom_smtp is not None:
        backend = custom_smtp.get("BACKEND", "")
        try:
            valid = backend in NON_PRODUCTION_EMAIL_BACKENDS or issubclass(import_string(backend), CustomSMTPBackend)
        except ImportError:
            valid = False

        if not valid:
            errors.append(
                Error(
                    f"Mailer '{CUSTOM_SMTP_MAILER_ALIAS}' must use a backend which supports per-message SMTP configuration.",
                    hint=f"Set BACKEND for '{CUSTOM_SMTP_MAILER_ALIAS}' in MAILERS to temba.utils.email.backend.CustomSMTPBackend.",
                )
            )

    return errors
