from django.db import models
from django.utils import timezone

from temba.contacts.models import Contact
from temba.orgs.models import Org
from temba.utils.models import TembaUUIDMixin


class AirtimeTransfer(TembaUUIDMixin, models.Model):
    STATUS_CREATED = "P"
    STATUS_CONFIRMED = "C"
    STATUS_REJECTED = "J"
    STATUS_CANCELLED = "A"
    STATUS_SUBMITTED = "B"
    STATUS_COMPLETED = "S"
    STATUS_REVERSED = "R"
    STATUS_DECLINED = "D"
    STATUS_CHOICES = (
        (STATUS_CREATED, "Created"),
        (STATUS_CONFIRMED, "Confirmed"),
        (STATUS_REJECTED, "Rejected"),
        (STATUS_CANCELLED, "Cancelled"),
        (STATUS_SUBMITTED, "Submitted"),
        (STATUS_COMPLETED, "Completed"),
        (STATUS_REVERSED, "Reversed"),
        (STATUS_DECLINED, "Declined"),
    )

    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="airtime_transfers")
    status = models.CharField(max_length=1, choices=STATUS_CHOICES)
    external_id = models.CharField(max_length=255, null=True)

    contact = models.ForeignKey(Contact, on_delete=models.PROTECT, related_name="airtime_transfers")
    recipient = models.CharField(max_length=255)  # URN that received the transfer
    sender = models.CharField(max_length=255, null=True)  # URN that sent the transfer

    currency = models.CharField(max_length=32, null=True)
    desired_amount = models.DecimalField(max_digits=10, decimal_places=2)
    actual_amount = models.DecimalField(max_digits=10, decimal_places=2)

    created_on = models.DateTimeField(default=timezone.now)
