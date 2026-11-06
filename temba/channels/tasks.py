import logging
from datetime import timedelta

from celery import shared_task

from django.conf import settings
from django.db.models import Count
from django.utils import timezone

from temba import mailroom
from temba.utils.crons import cron_task
from temba.utils.models import delete_in_batches

from .models import Channel, ChannelEvent, SyncEvent
from .types.android import AndroidType

logger = logging.getLogger(__name__)


@cron_task()
def check_android_channels():
    from temba.notifications.incidents.builtin import ChannelDisconnectedIncidentType
    from temba.notifications.models import Incident

    last_seen_cutoff = timezone.now() - timedelta(minutes=90)

    ongoing = Incident.objects.filter(incident_type=ChannelDisconnectedIncidentType.slug, ended_on=None).select_related(
        "channel"
    )

    for incident in ongoing:
        # if we've seen the channel since this incident started went out, then end it
        if incident.channel.last_seen > incident.started_on:
            incident.end()

    not_recently_seen = (
        Channel.objects.filter(channel_type=AndroidType.code, is_active=True, last_seen__lt=last_seen_cutoff)
        .exclude(org=None)
        .exclude(last_seen=None)
        .select_related("org")
    )

    for channel in not_recently_seen:
        ChannelDisconnectedIncidentType.get_or_create(channel)


@shared_task
def interrupt_channel_task(channel_id):
    channel = Channel.objects.get(pk=channel_id)

    # interrupt the channel, any sessions using this channel for calls,
    # fail pending/queued messages and clear courier messages
    mailroom.get_client().channel_interrupt(channel.org, channel)


@cron_task(lock_timeout=7200)
def trim_channel_events():
    """
    Trims old channel events
    """

    trim_before = timezone.now() - settings.RETENTION_PERIODS["channelevent"]

    num_deleted = delete_in_batches(ChannelEvent.objects.filter(created_on__lte=trim_before))

    return {"deleted": num_deleted}


@cron_task()
def trim_channel_sync_events():
    """
    Trims old Android channel sync events
    """

    trim_before = timezone.now() - settings.RETENTION_PERIODS["syncevent"]
    num_deleted = 0

    channels_with_events = (
        SyncEvent.objects.filter(created_on__lte=trim_before)
        .values("channel")
        .annotate(Count("id"))
        .filter(id__count__gt=1)
    )
    for result in channels_with_events:
        # trim older but always leave at least one per channel
        event_ids = list(
            SyncEvent.objects.filter(created_on__lte=trim_before, channel_id=result["channel"])
            .order_by("-created_on")
            .values_list("id", flat=True)[1:]
        )

        SyncEvent.objects.filter(id__in=event_ids).delete()
        num_deleted += len(event_ids)

    return {"deleted": num_deleted}
