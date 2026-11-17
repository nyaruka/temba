import logging

from django.conf import settings
from django.utils import timezone

from temba.utils.crons import cron_task
from temba.utils.models import delete_in_batches

from .incidents import TYPES as INCIDENT_TYPES
from .models import Incident, Notification
from .types.builtin import IncidentReminderNotificationType

logger = logging.getLogger(__name__)


@cron_task()
def send_incident_reminders():
    types_with_reminders = [slug for slug, typ in INCIDENT_TYPES.items() if typ.reminders]
    ongoing = Incident.objects.filter(incident_type__in=types_with_reminders, ended_on=None).select_related("org")
    now = timezone.now()
    num_sent = 0

    for incident in ongoing:
        reminder = incident.type.get_due_reminder(incident, now)
        if not reminder:
            continue

        scope = IncidentReminderNotificationType.get_scope(incident, reminder)
        sent = incident.notifications.filter(notification_type=IncidentReminderNotificationType.slug, scope=scope)
        if not sent.exists():
            IncidentReminderNotificationType.create(incident, reminder)
            num_sent += 1

    return {"sent": num_sent}


@cron_task(lock_timeout=1800)
def send_notification_emails():
    pending = Notification.objects.filter(email_status=Notification.EMAIL_STATUS_PENDING)

    # a released user's address has been scrubbed to one that can't receive mail
    pending.filter(user__is_active=False).update(email_status=Notification.EMAIL_STATUS_NONE)

    pending = list(
        pending.filter(user__is_active=True).select_related("org", "user", "incident").order_by("created_on")
    )

    num_sent, num_errored = 0, 0

    for notification in pending:
        try:
            notification.send_email()
            num_sent += 1
        except Exception:  # pragma: no cover
            logger.error("error sending notification email", exc_info=True)
            num_errored += 1

    return {"sent": num_sent, "errored": num_errored}


@cron_task()
def trim_notifications():
    trim_before = timezone.now() - settings.RETENTION_PERIODS["notification"]

    num_deleted = delete_in_batches(Notification.objects.filter(created_on__lt=trim_before))

    return {"deleted": num_deleted}
