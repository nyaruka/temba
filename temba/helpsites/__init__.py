from django.conf import settings


def get_client():
    from .client import HelpsitesClient

    return HelpsitesClient(settings.HELPSITES_URL, settings.HELPSITES_AUTH_TOKEN)
