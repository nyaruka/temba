import logging

import requests
from celery import shared_task

from temba.channels.models import Channel
from temba.utils.crons import cron_task

logger = logging.getLogger(__name__)


@cron_task()
def refresh_templates():
    """
    Queues a template refresh for every active channel whose type uses templates.
    """

    # get all active channels for types that use templates
    channel_types = [t.code for t in Channel.get_types() if t.template_type]
    channel_ids = Channel.objects.filter(
        is_active=True, channel_type__in=channel_types, org__is_active=True, org__is_suspended=False
    ).values_list("id", flat=True)

    num_queued = 0
    for channel_id in channel_ids:
        refresh_channel_templates.delay(channel_id)
        num_queued += 1

    return {"queued": num_queued}


@shared_task
def refresh_channel_templates(channel_id):
    """
    Syncs the templates of a single channel.
    """

    channel = Channel.objects.filter(id=channel_id, is_active=True).select_related("org").first()
    if not channel:
        return

    try:
        channel.refresh_templates()
    except requests.RequestException:
        pass  # logged to channel's HTTP logs by the channel type
    except Exception as e:
        logger.error(f"Error refreshing whatsapp templates: {str(e)}", exc_info=True)
