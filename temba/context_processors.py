from django.conf import settings


def config(request):
    return {
        "COMPONENTS_DEV_MODE": getattr(settings, "COMPONENTS_DEV_MODE", False),
        "COMPONENTS_DEV_HOST": getattr(settings, "COMPONENTS_DEV_HOST", "localhost"),
        # Expose allauth-related flags used by templates
        "SOCIALACCOUNT_ENABLED": getattr(settings, "SOCIALACCOUNT_ENABLED", True),
        "SOCIALACCOUNT_ONLY": getattr(settings, "SOCIALACCOUNT_ONLY", False),
        "COMPONENTS_DEV_URL": getattr(settings, "COMPONENTS_DEV_URL", ""),
    }


def branding(request):
    """
    Stuff our branding into the context
    """
    return dict(branding=request.branding)


def weni_webchat(request):
    return {
        "weni_webchat_script_url": getattr(settings, "WENI_WEBCHAT_SCRIPT_URL", ""),
        "weni_webchat_cdn_url": getattr(settings, "WENI_WEBCHAT_CDN_URL", ""),
    }
