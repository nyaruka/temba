import logging

import requests
from celery import shared_task
from django_valkey import get_valkey_connection

from django.utils import timezone

from temba.channels.models import Channel
from temba.request_logs.models import HTTPLog

logger = logging.getLogger(__name__)


@shared_task
def refresh_turn_whatsapp_tokens():
    r = get_valkey_connection()
    if r.get("refresh_turn_whatsapp_tokens"):  # pragma: no cover
        return

    with r.lock("refresh_turn_whatsapp_tokens", 1800):
        # only channels claimed with login credentials need new tokens generating - doing so invalidates the previous
        # token, so channels using an API token created by the user are left alone
        for channel in Channel.objects.filter(is_active=True, channel_type="TRN").order_by("id"):
            if not channel.config.get(Channel.CONFIG_USERNAME) or not channel.config.get(Channel.CONFIG_PASSWORD):
                continue

            try:
                url = channel.config[Channel.CONFIG_BASE_URL] + "/v1/users/login"

                start = timezone.now()
                resp = requests.post(
                    url, auth=(channel.config[Channel.CONFIG_USERNAME], channel.config[Channel.CONFIG_PASSWORD])
                )
                HTTPLog.from_response(HTTPLog.WHATSAPP_TOKENS_SYNCED, resp, start, timezone.now(), channel=channel)

                if resp.status_code != 200:
                    continue

                channel.config[Channel.CONFIG_AUTH_TOKEN] = resp.json()["users"][0]["token"]
                channel.save(update_fields=["config"])
            except Exception as e:
                logger.error(f"Error refreshing whatsapp tokens: {str(e)}", exc_info=True)
