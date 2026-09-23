import logging
from datetime import datetime, timezone as tzone

from django_valkey import get_valkey_connection

from django.conf import settings
from django.utils import timezone

from temba.utils.crons import cron_task
from temba.utils.models import delete_in_batches

from .models import FlowActivityCount, FlowResultCount, FlowRevision, FlowSession, FlowStartCount

logger = logging.getLogger(__name__)


@cron_task(lock_timeout=7200)
def squash_flow_counts():
    FlowActivityCount.squash()
    FlowResultCount.squash()
    FlowStartCount.squash()


@cron_task()
def trim_flow_revisions():
    # get when the last time we trimmed was
    r = get_valkey_connection()
    last_trim = r.get(FlowRevision.LAST_TRIM_KEY)
    if not last_trim:
        last_trim = 0

    last_trim = datetime.utcfromtimestamp(int(last_trim)).astimezone(tzone.utc)
    num_trimmed = FlowRevision.trim(last_trim)

    r.set(FlowRevision.LAST_TRIM_KEY, int(timezone.now().timestamp()))

    return {"trimmed": num_trimmed}


@cron_task()
def trim_flow_sessions():
    """
    Cleanup ended flow sessions
    """

    trim_before = timezone.now() - settings.RETENTION_PERIODS["flowsession"]

    num_deleted = delete_in_batches(FlowSession.objects.filter(ended_on__lte=trim_before), order_by="ended_on")

    return {"deleted": num_deleted}
