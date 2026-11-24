from celery import shared_task

from temba.utils.crons import cron_task

from .models import HelpdeskImport, HelpSite


@shared_task
def import_helpdesk_task(import_id):
    HelpdeskImport.objects.get(id=import_id).perform()


@cron_task()
def check_helpsite_domains():
    return HelpSite.check_verified_domains()
