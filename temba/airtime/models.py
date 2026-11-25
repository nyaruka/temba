from dataclasses import dataclass
from datetime import datetime

import iso8601

from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from temba.contacts.models import Contact
from temba.orgs.models import Org
from temba.utils import dynamo
from temba.utils.models import UUIDMixin


class AirtimeTransfer(UUIDMixin, models.Model):
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

    def get_logs(self) -> list:
        """
        Gets the logs of this transfer's interactions with its provider, oldest first
        """
        items = dynamo.MAIN.query(
            KeyConditionExpression="PK = :pk", ExpressionAttributeValues={":pk": f"att#{self.uuid}"}
        )["Items"]

        return [AirtimeTransferLog.from_item(self, item) for item in items if item["OrgID"] == self.org_id]


@dataclass
class AirtimeTransferLog:
    """
    A log of an interaction with an airtime provider, written by mailroom to DynamoDB
    """

    TYPE_CREATE = "create"
    TYPE_CONFIRM = "confirm"
    TYPE_DISPLAY = {TYPE_CREATE: _("Create Transfer"), TYPE_CONFIRM: _("Confirm Transfer")}

    uuid: str
    transfer: AirtimeTransfer
    log_type: str
    http_logs: list[dict]
    errors: list[dict]
    is_error: bool
    elapsed_ms: int
    created_on: datetime

    @classmethod
    def from_item(cls, transfer, item: dict):
        assert item["OrgID"] == transfer.org_id, "org ID mismatch for airtime transfer log"

        data = item["Data"] | dynamo.load_jsongz(item["DataGZ"])

        return cls(
            uuid=item["SK"].split("#")[1],
            transfer=transfer,
            log_type=data["type"],
            http_logs=data["http_logs"],
            errors=data["errors"],
            is_error=data.get("is_error", False),
            elapsed_ms=int(data["elapsed_ms"]),
            created_on=iso8601.parse_date(data["created_on"]),
        )

    def get_display(self) -> dict:
        return {
            "uuid": self.uuid,
            "type_display": self.TYPE_DISPLAY.get(self.log_type, self.log_type),
            "http_logs": self.http_logs,
            "errors": self.errors,
            "is_error": self.is_error,
            "elapsed_ms": self.elapsed_ms,
            "created_on": self.created_on.isoformat(),
        }
