from django.urls import reverse
from django.utils.translation import gettext_lazy as _

from ..models import Incident, IncidentType


class ChannelDisconnectedIncidentType(IncidentType):
    """
    Android channel appears to be disconnected.
    """

    slug = "channel:disconnected"
    title = _("Channel Disconnected")

    @classmethod
    def get_or_create(cls, channel):
        """
        Creates a channel disconnected incident if one is not already ongoing
        """
        return Incident.get_or_create(channel.org, cls.slug, scope=str(channel.id), channel=channel)

    def get_notification_target_url(self, incident) -> str:
        return reverse("channels.channel_read", args=[str(incident.channel.uuid)])


class ChannelOutdatedAppIncidentType(IncidentType):
    """
    Android channel using outdated version of the client app - created by mailroom.
    """

    slug = "channel:outdated_app"
    title = _("Channel Android App Outdated")


class WebhooksUnhealthyIncidentType(IncidentType):
    """
    Webhook calls from flows have been taking too long to respond for a period of time - created by mailroom.
    """

    slug = "webhooks:unhealthy"
    title = _("Webhooks Unhealthy")
