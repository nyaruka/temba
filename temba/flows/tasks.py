import logging
from datetime import datetime, timezone as tzone

from django_valkey import get_valkey_connection

from django.conf import settings
from django.utils import timezone

from temba.utils.crons import cron_task

from .models import FlowActivityCount, FlowResultCount, FlowRevision, FlowSession, FlowStartCount

logger = logging.getLogger(__name__)

TRIM_SESSIONS_BATCH_SIZE = 1000


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

    # each batch resumes from where the last ended, as rescanning from the start means walking every index entry
    # deleted so far that vacuum hasn't yet removed, which makes large trims quadratic
    resume_from = None
    num_deleted = 0

    while True:
        batch_qs = FlowSession.objects.filter(ended_on__lte=trim_before)
        if resume_from:
            batch_qs = batch_qs.filter(ended_on__gte=resume_from)  # inclusive as other sessions may share this value

        batch = list(batch_qs.order_by("ended_on").values_list("id", "ended_on")[:TRIM_SESSIONS_BATCH_SIZE])
        if not batch:
            break

        FlowSession.objects.filter(id__in=[s[0] for s in batch]).delete()
        num_deleted += len(batch)
        resume_from = batch[-1][1]

    return {"deleted": num_deleted}
