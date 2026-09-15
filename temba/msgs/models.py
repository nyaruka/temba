import itertools
import logging
import mimetypes
import os
import re
from array import array
from dataclasses import dataclass
from datetime import timedelta
from enum import Enum
from fnmatch import fnmatch
from urllib.parse import unquote, urlparse

import iso8601

from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.core.files.storage import default_storage
from django.db import models
from django.db.models import Prefetch, Q, Sum
from django.db.models.functions import Lower
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from temba import mailroom
from temba.channels.models import Channel, ChannelLog
from temba.contacts.models import Contact, ContactGroup, ContactURN
from temba.orgs.models import DependencyMixin, Export, ExportType, Org
from temba.schedules.models import Schedule
from temba.utils import languages, on_transaction_commit
from temba.utils.export.models import MultiSheetExporter
from temba.utils.models import LegacyIDMixin, TembaModel
from temba.utils.models.counts import BaseSquashableCount
from temba.utils.s3 import public_file_storage
from temba.utils.uuid import uuid4, uuid7_range

logger = logging.getLogger(__name__)


class Media(models.Model):
    """
    An uploaded media file that can be used as an attachment on messages.
    """

    ALLOWED_CONTENT_TYPES = (
        "image/apng",
        "image/avif",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp",
        "audio/*",
        "video/*",
        "application/pdf",
    )
    MAX_UPLOAD_SIZE = 1024 * 1024 * 25  # 25MB

    STATUS_PENDING = "P"
    STATUS_READY = "R"
    STATUS_FAILED = "F"
    STATUS_CHOICES = ((STATUS_PENDING, "Pending"), (STATUS_READY, "Ready"), (STATUS_FAILED, "Failed"))

    uuid = models.UUIDField(default=uuid4, unique=True)
    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="media")
    url = models.URLField(max_length=2048)
    content_type = models.CharField(max_length=255)
    path = models.CharField(max_length=2048)
    size = models.IntegerField(default=0)  # bytes
    original = models.ForeignKey("self", null=True, on_delete=models.CASCADE, related_name="alternates")
    status = models.CharField(max_length=1, default=STATUS_PENDING, choices=STATUS_CHOICES)

    # fields that will be set after upload by a processing task
    duration = models.IntegerField(default=0)  # milliseconds
    width = models.IntegerField(default=0)  # pixels
    height = models.IntegerField(default=0)  # pixels

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_on = models.DateTimeField(default=timezone.now)

    @classmethod
    def is_allowed_type(cls, content_type: str) -> bool:
        for allowed_type in cls.ALLOWED_CONTENT_TYPES:
            if fnmatch(content_type, allowed_type):
                return True
        return False

    @classmethod
    def get_storage_path(cls, org, uuid, filename):
        """
        Returns the storage path for the given filename. Differs slightly from that used by the media endpoint because
        it preserves the original filename which courier still needs if there's no media record for an attachment URL.
        """
        return f"orgs/{org.id}/media/{str(uuid)[0:4]}/{uuid}/{filename}"

    @classmethod
    def clean_name(cls, filename: str, content_type: str) -> str:
        base_name, extension = os.path.splitext(filename)
        base_name = re.sub(r"[^\w\-\[\]\(\) ]", "", base_name).strip()[:255] or "file"

        if not extension or len(extension) < 2 or not extension[1:].isalnum():
            extension = mimetypes.guess_extension(content_type) or ".bin"

        return base_name + extension

    @classmethod
    def from_upload(cls, org, user, file, process=True):
        """
        Creates a new media instance from a file upload.
        """

        from .tasks import process_media_upload

        assert cls.is_allowed_type(file.content_type), "unsupported content type"

        filename = cls.clean_name(file.name, file.content_type)

        # browsers might send m4a files but correct MIME type is audio/mp4
        if filename.endswith(".m4a"):
            file.content_type = "audio/mp4"

        media = cls._create(org, user, filename, file.content_type, file)

        if process:
            on_transaction_commit(lambda: process_media_upload.delay(media.id))

        return media

    @classmethod
    def create_alternate(cls, original, filename: str, content_type: str, file, **kwargs):
        """
        Creates a new alternate media instance for the given original.
        """

        return cls._create(
            original.org,
            original.created_by,
            filename,
            content_type,
            file,
            original=original,
            status=cls.STATUS_READY,
            **kwargs,
        )

    @classmethod
    def _create(cls, org, user, filename: str, content_type: str, file, **kwargs):
        uuid = uuid4()
        path = cls.get_storage_path(org, uuid, filename)
        path = public_file_storage.save(path, file)
        size = public_file_storage.size(path)

        return cls.objects.create(
            uuid=uuid,
            org=org,
            url=public_file_storage.url(path),
            content_type=content_type,
            path=path,
            size=size,
            created_by=user,
            **kwargs,
        )

    @property
    def filename(self) -> str:
        return os.path.basename(self.path)

    def process_upload(self):
        from .media import process_upload

        assert self.status == self.STATUS_PENDING, "media file is already processed"
        assert not self.original, "only original uploads can be processed"

        process_upload(self)

    def __str__(self) -> str:
        return f"{self.content_type}:{self.url}"

    class Meta:
        indexes = [
            models.Index(name="media_originals_by_org", fields=["org", "-created_on"], condition=Q(original=None))
        ]


class Broadcast(LegacyIDMixin, models.Model):
    """
    A broadcast is a message that is sent out to more than one recipient, such
    as a ContactGroup or a list of Contacts. It's nothing more than a way to tie
    messages sent from the same bundle together
    """

    STATUS_PENDING = "P"  # exists in the database
    STATUS_QUEUED = "Q"  # batch tasks created, count_count set
    STATUS_STARTED = "S"  # first batch task started
    STATUS_COMPLETED = "C"  # last batch task completed
    STATUS_FAILED = "F"
    STATUS_INTERRUPTED = "I"
    STATUS_CHOICES = (
        (STATUS_PENDING, "Pending"),
        (STATUS_QUEUED, "Queued"),
        (STATUS_STARTED, "Started"),
        (STATUS_COMPLETED, "Completed"),
        (STATUS_FAILED, "Failed"),
        (STATUS_INTERRUPTED, "Interrupted"),
    )

    uuid = models.UUIDField(unique=True)
    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="broadcasts")
    status = models.CharField(max_length=1, choices=STATUS_CHOICES, default=STATUS_PENDING)
    contact_count = models.IntegerField(default=0, null=True)  # null until status is QUEUED

    # recipients of this broadcast
    groups = models.ManyToManyField(ContactGroup, related_name="addressed_broadcasts")
    contacts = models.ManyToManyField(Contact, related_name="addressed_broadcasts")
    urns = ArrayField(models.TextField(), null=True)
    query = models.TextField(null=True)
    exclusions = models.JSONField(default=dict, null=True)

    # message content
    translations = models.JSONField()  # text, attachments and quick replies by language
    base_language = models.CharField(max_length=3)  # ISO-639-3
    template = models.ForeignKey("templates.Template", null=True, on_delete=models.PROTECT)
    template_variables = ArrayField(models.TextField(), null=True)

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+")
    created_on = models.DateTimeField(default=timezone.now)
    modified_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+")
    modified_on = models.DateTimeField(default=timezone.now)

    # used for scheduled broadcasts which are never actually sent themselves but spawn child broadcasts which are
    schedule = models.OneToOneField(Schedule, on_delete=models.PROTECT, null=True, related_name="broadcast")
    parent = models.ForeignKey("Broadcast", on_delete=models.PROTECT, null=True, related_name="children")
    is_active = models.BooleanField(null=True, default=True)

    @classmethod
    def create(
        cls,
        org,
        user,
        translations: dict[str, dict],
        *,
        base_language: str,
        groups=(),
        contacts=(),
        urns=(),
        query=None,
        exclude=None,
        template=None,
        template_variables=(),
        schedule=None,
    ):
        assert groups or contacts or urns or query, "can't create broadcast without recipients"
        assert base_language and languages.get_name(base_language), f"{base_language} is not a valid language code"
        assert base_language in translations, "no translation for base language"

        return mailroom.get_client().msg_broadcast(
            org,
            user,
            translations=translations,
            base_language=base_language,
            groups=groups,
            contacts=contacts,
            urns=urns,
            query=query,
            exclude=exclude,
            template=template,
            template_variables=template_variables,
            schedule=schedule,
        )

    @classmethod
    def preview(cls, org, *, include: mailroom.Inclusions, exclude: mailroom.Exclusions) -> tuple[str, int]:
        """
        Requests a preview of the recipients of a broadcast created with the given inclusions/exclusions, returning a
        tuple of the canonical query and the total count of contacts.
        """
        preview = mailroom.get_client().msg_broadcast_preview(org, include=include, exclude=exclude)

        return preview.query, preview.total

    def has_pending_fire(self):  # pragma: needs cover
        return self.schedule and self.schedule.next_fire is not None

    def get_messages(self):
        return self.msgs.all()

    def get_message_count(self):
        return BroadcastMsgCount.get_count(self)

    def get_translation(self, contact=None) -> dict:
        """
        Gets a translation to use to display this broadcast. If contact is provided and their language is a valid flow
        language and there's a translation for it then that will be used.
        """

        def trans(d):
            # ensure that we have all fields
            return {"text": "", "attachments": [], "quick_replies": []} | d

        if contact and contact.language and contact.language in self.org.flow_languages:  # try contact language
            if contact.language in self.translations:
                return trans(self.translations[contact.language])

        if self.org.flow_languages[0] in self.translations:  # try org primary language
            return trans(self.translations[self.org.flow_languages[0]])

        return trans(self.translations[self.base_language])  # should always be a base language translation

    def interrupt(self, user):
        """
        Interrupts this flow start
        """

        self.status = self.STATUS_INTERRUPTED
        self.modified_by = user
        self.save(update_fields=("status", "modified_by", "modified_on"))

    def delete(self, user, *, soft: bool):
        if soft:
            assert self.schedule, "can only soft delete scheduled broadcasts"
            schedule = self.schedule

            self.schedule = None
            self.modified_by = user
            self.modified_on = timezone.now()
            self.is_active = False
            self.save(update_fields=("schedule", "modified_by", "modified_on", "is_active"))

            schedule.delete()
        else:
            for child in self.children.all():
                child.delete(user, soft=False)

            for msg in self.msgs.all():
                msg.delete()

            BroadcastMsgCount.objects.filter(broadcast=self).delete()

            super().delete()

            if self.schedule:
                self.schedule.delete()

    def update_recipients(self, *, groups=None, contacts=None):
        """
        Only used to update recipients for scheduled / repeating broadcasts
        """
        # clear our current recipients
        self.groups.clear()
        self.contacts.clear()

        if groups:  # pragma: no cover
            self.groups.add(*groups)

        if contacts:
            self.contacts.add(*contacts)

    def get_exclusions_display(self) -> list:
        """
        Human readable descriptions of this broadcast's exclusions - same wording as includes/exclusions.html.
        """
        display = []
        exclusions = self.exclusions or {}
        if exclusions.get("in_a_flow"):
            display.append(_("Not in a flow"))
        if exclusions.get("started_previously"):
            display.append(_("No recent runs"))
        # exclusions is untyped JSON so guard against a non-int creeping into the format below
        days = exclusions.get("not_seen_since_days")
        if isinstance(days, int) and days:
            if days == 365:
                display.append(_("Active in the last year"))
            else:
                display.append(_("Active in the last %(days)d days") % {"days": days})
        return display

    def as_json(self, context=None) -> dict:
        """
        Internal API shape, consumed by the temba-broadcast-list component. Content fields carry the base
        translation; `msg_count` relies on BroadcastMsgCount.bulk_annotate having run for the page (falling back to
        a per-row count).
        """

        translation = self.get_translation()

        # a scheduled broadcast hasn't sent anything itself (its fires spawn child broadcasts), so it carries no
        # count or progress
        msg_count = None
        if not self.schedule:
            msg_count = getattr(self, "msg_count", None)
            if msg_count is None:
                msg_count = self.get_message_count()

        return {
            "uuid": str(self.uuid),
            "status": self.get_status_display().lower(),
            "text": translation["text"],
            "attachments": translation["attachments"],
            "quick_replies": translation["quick_replies"],
            "template": {"uuid": str(self.template.uuid), "name": self.template.name} if self.template else None,
            "groups": [{"uuid": str(g.uuid), "name": g.name} for g in self.groups.all()],
            "contacts": [{"uuid": str(c.uuid), "name": c.name} for c in self.contacts.all()],
            "urns": self.urns or [],
            "query": self.query,
            "exclusions": [str(e) for e in self.get_exclusions_display()],
            "schedule": (
                {
                    "repeat_period": self.schedule.repeat_period,
                    "display": self.schedule.get_display(),
                    # a paused schedule can carry a stale next_fire — null it so the broadcast reads as not
                    # scheduled, same as the trigger list
                    "next_fire": (
                        self.schedule.next_fire.isoformat()
                        if self.schedule.next_fire and not self.schedule.is_paused
                        else None
                    ),
                }
                if self.schedule
                else None
            ),
            "msg_count": msg_count,
            # send progress, matching the v2 API's shape: total is -1 until mailroom resolves the recipient
            # count at queue time
            "progress": (
                None
                if self.schedule
                else {
                    "total": self.contact_count if self.contact_count is not None else -1,
                    "started": msg_count,
                }
            ),
            "created_on": self.created_on.isoformat(),
            "created_by": self.created_by.email if self.created_by else None,
            "modified_on": self.modified_on.isoformat(),
        }

    def __repr__(self):
        return f'<Broadcast: id={self.id} text="{self.get_translation()["text"]}">'

    class Meta:
        indexes = [
            # used by the broadcasts API endpoint
            models.Index(
                name="msgs_broadcasts_api",
                fields=["org", "-created_on", "-id"],
                condition=Q(schedule__isnull=True, is_active=True),
            ),
            # used by the scheduled broadcasts view
            models.Index(
                name="msgs_broadcasts_scheduled",
                fields=["org", "-created_on"],
                condition=Q(schedule__isnull=False, is_active=True),
            ),
        ]


@dataclass
class Attachment:
    """
    Represents a message attachment stored as type:url
    """

    content_type: str
    url: str

    MAX_LEN = 2048
    CONTENT_TYPE_REGEX = re.compile(r"^(image|audio|video|application|geo|unavailable|(\w+/[-+.\w]+))$")

    @classmethod
    def parse(cls, s):
        if ":" in s:
            content_type, url = s.split(":", 1)
            if cls.CONTENT_TYPE_REGEX.match(content_type) and url:
                return cls(content_type, url)

        raise ValueError(f"{s} is not a valid attachment")

    @classmethod
    def parse_all(cls, attachments, ignore_invalid: bool = False) -> list:
        parsed = []
        for s in attachments or []:
            try:
                parsed.append(cls.parse(s))
            except ValueError:
                if not ignore_invalid:
                    raise
        return parsed

    @classmethod
    def bulk_delete(cls, attachments):
        for att in attachments:
            parsed = urlparse(att.url)
            default_storage.delete(unquote(parsed.path))

    def as_json(self) -> dict:
        return {"content_type": self.content_type, "url": self.url}

    def __str__(self) -> str:
        return f"{self.content_type}:{self.url}"


class Msg(models.Model):
    """
    Messages are either inbound or outbound and can have varying statuses depending on their direction. Generally an
    outbound message will go through the following statuses:

      INITIALIZING > QUEUED > WIRED > SENT > DELIVERED
                            |
                            > ERRORED > FAILED

    Though in practice to save a database update, messages are created in the database as QUEUED, and only if queueing
    to courier fails, put back in INITIALIZING. If things go wrong during sending, they can be put into ERRORED where
    they can be retried. Once they've exceeded the allowed number of errored sends, they become FAILED.

    Inbound messages are simpler:

      PENDING > HANDLED

    They are created in the database as PENDING and updated to HANDLED once they've been handled by the flow engine.
    """

    STATUS_PENDING = "P"  # incoming msg created but not yet handled
    STATUS_HANDLED = "H"  # incoming msg handled
    STATUS_INITIALIZING = "I"  # outgoing msg that hasn't yet been queued
    STATUS_QUEUED = "Q"  # outgoing msg queued to courier for sending
    STATUS_WIRED = "W"  # outgoing msg requested to be sent via channel
    STATUS_SENT = "S"  # outgoing msg having received sent confirmation from channel
    STATUS_DELIVERED = "D"  # outgoing msg having received delivery confirmation from channel
    STATUS_READ = "R"  # outgoing msg having received read confirmation from channel
    STATUS_ERRORED = "E"  # outgoing msg which has errored and will be retried
    STATUS_FAILED = "F"  # outgoing msg which has failed permanently
    STATUS_CHOICES = (
        (STATUS_PENDING, _("Pending")),
        (STATUS_HANDLED, _("Handled")),
        (STATUS_INITIALIZING, _("Initializing")),
        (STATUS_QUEUED, _("Queued")),
        (STATUS_WIRED, _("Wired")),
        (STATUS_SENT, _("Sent")),
        (STATUS_DELIVERED, _("Delivered")),
        (STATUS_READ, _("Read")),
        (STATUS_ERRORED, _("Error")),
        (STATUS_FAILED, _("Failed")),
    )

    VISIBILITY_VISIBLE = "V"
    VISIBILITY_DELETED_BY_USER = "D"
    VISIBILITY_DELETED_BY_SENDER = "X"
    VISIBILITY_CHOICES = (
        (VISIBILITY_VISIBLE, "Visible"),
        (VISIBILITY_DELETED_BY_USER, "Deleted by user"),
        (VISIBILITY_DELETED_BY_SENDER, "Deleted by sender"),
    )

    DIRECTION_IN = "I"
    DIRECTION_OUT = "O"
    DIRECTION_CHOICES = ((DIRECTION_IN, "Incoming"), (DIRECTION_OUT, "Outgoing"))

    TYPE_TEXT = "T"
    TYPE_OPTIN = "O"
    TYPE_VOICE = "V"
    TYPE_CHOICES = ((TYPE_TEXT, "Text"), (TYPE_OPTIN, "Opt-In Request"), (TYPE_VOICE, "Interactive Voice Response"))
    TYPE_SLUGS = {TYPE_TEXT: "text", TYPE_OPTIN: "optin", TYPE_VOICE: "voice"}

    # which folder this message belongs to. the first six are the user facing folders defined by MsgFolder - the last
    # two exist so that messages outside the user facing folders still have one.
    FOLDER_INBOX = "I"
    FOLDER_HANDLED = "W"
    FOLDER_ARCHIVED = "A"
    FOLDER_OUTBOX = "O"
    FOLDER_SENT = "S"
    FOLDER_FAILED = "X"
    FOLDER_PENDING = "P"  # incoming and not yet handled
    FOLDER_DELETED = "D"  # deleted by the user or the sender
    FOLDER_CHOICES = (
        (FOLDER_INBOX, "Inbox"),
        (FOLDER_HANDLED, "Handled"),
        (FOLDER_ARCHIVED, "Archived"),
        (FOLDER_OUTBOX, "Outbox"),
        (FOLDER_SENT, "Sent"),
        (FOLDER_FAILED, "Failed"),
        (FOLDER_PENDING, "Pending"),
        (FOLDER_DELETED, "Deleted"),
    )

    FAILED_NO_DESTINATION = "D"
    FAILED_CONTACT = "C"
    FAILED_SUSPENDED = "S"
    FAILED_LOOPING = "L"
    FAILED_ERROR_LIMIT = "E"
    FAILED_TOO_OLD = "O"
    FAILED_CHANNEL_REMOVED = "R"
    FAILED_CHOICES = (
        (FAILED_SUSPENDED, _("Workspace suspended")),
        (FAILED_CONTACT, _("Contact is no longer active")),
        (FAILED_LOOPING, _("Looping detected")),  # mailroom checks for this
        (FAILED_ERROR_LIMIT, _("Retry limit reached")),  # courier tried to send but it errored too many times
        (FAILED_TOO_OLD, _("Too old to send")),  # was queued for too long, would be confusing to send now
        (FAILED_NO_DESTINATION, _("No suitable channel found")),  # no compatible channel + URN destination found
        (FAILED_CHANNEL_REMOVED, _("Channel removed")),  # channel removed by user
    )

    MEDIA_GPS = "geo"
    MEDIA_IMAGE = "image"
    MEDIA_VIDEO = "video"
    MEDIA_AUDIO = "audio"
    MEDIA_TYPES = [MEDIA_AUDIO, MEDIA_GPS, MEDIA_IMAGE, MEDIA_VIDEO]

    MAX_TEXT_LEN = 4096  # max chars allowed in a message
    MAX_ATTACHMENTS = 10  # max attachments allowed on a message
    MAX_QUICK_REPLIES = 10  # max quick replies allowed on a message

    id = models.BigAutoField(primary_key=True)
    uuid = models.UUIDField(unique=True)
    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="msgs", db_index=False)

    # message destination
    channel = models.ForeignKey(Channel, on_delete=models.PROTECT, null=True, related_name="msgs")
    contact = models.ForeignKey(Contact, on_delete=models.PROTECT, related_name="msgs", db_index=False)
    contact_urn = models.ForeignKey(ContactURN, on_delete=models.PROTECT, null=True, related_name="msgs")

    # message origin (note that we don't index or constrain flow/ticket so accessing by these is not supported)
    broadcast = models.ForeignKey(Broadcast, on_delete=models.PROTECT, null=True, related_name="msgs")
    flow = models.ForeignKey("flows.Flow", on_delete=models.DO_NOTHING, null=True, db_index=False, db_constraint=False)
    ticket_uuid = models.UUIDField(null=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, db_index=False)

    # message content
    text = models.TextField()
    attachments = ArrayField(models.URLField(max_length=Attachment.MAX_LEN), null=True)
    quickreplies = models.JSONField(null=True)
    locale = models.CharField(max_length=6, null=True)  # eng, eng-US, por-BR, und etc
    templating = models.JSONField(null=True)

    created_on = models.DateTimeField()
    modified_on = models.DateTimeField()
    sent_on = models.DateTimeField(null=True)

    msg_type = models.CharField(max_length=1, choices=TYPE_CHOICES)
    direction = models.CharField(max_length=1, choices=DIRECTION_CHOICES)
    status = models.CharField(max_length=1, choices=STATUS_CHOICES, default=STATUS_PENDING)
    visibility = models.CharField(max_length=1, choices=VISIBILITY_CHOICES, default=VISIBILITY_VISIBLE)
    # the folder this message is in, derived from direction/visibility/status/flow and maintained by mailroom and
    # courier - every message is in one, including those not in a user facing folder. This is what's read to tell
    # which folder a message is in, including whether it's archived, rather than the state it's derived from.
    folder = models.CharField(max_length=1, choices=FOLDER_CHOICES)

    is_android = models.BooleanField()
    labels = models.ManyToManyField("Label", related_name="msgs", through="MsgLabel")

    # the number of actual messages the channel sent this as (outgoing only)
    msg_count = models.IntegerField(default=1)

    # sending (outgoing only)
    high_priority = models.BooleanField(null=True)
    error_count = models.IntegerField(default=0)  # number of times this message has errored
    next_attempt = models.DateTimeField(null=True)  # when we'll next retry
    failed_reason = models.CharField(null=True, max_length=1, choices=FAILED_CHOICES)  # why we've failed

    # the id of this message on the other side of its channel
    external_identifier = models.CharField(max_length=255, null=True)

    log_uuids = ArrayField(models.UUIDField(), null=True)

    def as_json(self, context=None) -> dict:
        """
        Internal API shape, consumed by the temba-msg-list component. The channel is included so the component can
        link to the message's channel logs, which the page enables when the user can view them.
        """
        return {
            "uuid": str(self.uuid),
            "type": self.TYPE_SLUGS.get(self.msg_type),
            "contact": {"uuid": str(self.contact.uuid), "name": self.contact.get_display(self.org)},
            "text": self.text,
            "attachments": [a.as_json() for a in self.get_attachments()],
            "labels": [{"uuid": str(lb.uuid), "name": lb.name} for lb in self.labels.all()],
            "flow": {"uuid": str(self.flow.uuid), "name": self.flow.name} if self.flow else None,
            "channel": {"uuid": str(self.channel.uuid), "name": self.channel.name} if self.channel else None,
            "created_on": self.created_on.isoformat() if self.created_on else None,
        }

    def as_archive_json(self):
        """
        Returns this message in the same format as archived by rp-archiver which is based on the API format
        """
        from temba.api.v2.serializers import MsgReadSerializer

        serializer = MsgReadSerializer()

        return {
            "uuid": str(self.uuid),
            "id": self.id,
            "contact": {"uuid": str(self.contact.uuid), "name": self.contact.name},
            "channel": {"uuid": str(self.channel.uuid), "name": self.channel.name} if self.channel else None,
            "flow": {"uuid": str(self.flow.uuid), "name": self.flow.name} if self.flow else None,
            "urn": self.contact_urn.identity if self.contact_urn else None,
            "direction": serializer.get_direction(self),
            "type": serializer.get_type(self),
            "status": serializer.get_status(self),
            "visibility": serializer.get_visibility(self),
            "text": self.text,
            "attachments": [attachment.as_json() for attachment in self.get_attachments()],
            "labels": [{"uuid": str(lb.uuid), "name": lb.name} for lb in self.labels.all()],
            "created_on": self.created_on.isoformat(),
            "sent_on": self.sent_on.isoformat() if self.sent_on else None,
        }

    def get_attachments(self):
        """
        Gets this message's attachments parsed into objects
        """
        return Attachment.parse_all(self.attachments)

    def get_logs(self) -> list:
        return ChannelLog.get_by_uuid(self.channel, self.log_uuids or [])

    def handle(self):  # pragma: no cover
        """
        Queues this message to be handled. Only used for manual retries of failed handling.
        """

        mailroom.get_client().msg_handle(self.org, [self])

    @classmethod
    def apply_action_label(cls, user, msgs, label):
        label.toggle_label(msgs, add=True)

    @classmethod
    def apply_action_unlabel(cls, user, msgs, label):
        label.toggle_label(msgs, add=False)

    @classmethod
    def apply_action_archive(cls, user, msgs):
        if msgs := list(msgs):
            cls.bulk_archive(msgs[0].org, msgs)

    @classmethod
    def apply_action_restore(cls, user, msgs):
        if msgs := list(msgs):
            cls.bulk_restore(msgs[0].org, msgs)

    @classmethod
    def apply_action_delete(cls, user, msgs):
        if msgs := list(msgs):
            cls.bulk_soft_delete(msgs[0].org, user, msgs)

    @classmethod
    def apply_action_resend(cls, user, msgs):
        if msgs := list(msgs):
            mailroom.get_client().msg_resend(msgs[0].org, user, msgs)

    @classmethod
    def bulk_archive(cls, org, msgs: list):
        """
        Bulk archives the given incoming messages. Messages which aren't currently visible are ignored.
        """

        for msg in msgs:
            assert msg.direction == Msg.DIRECTION_IN, "only incoming messages can be archived"

        if msgs:
            mailroom.get_client().msg_archive(org, msgs)

    @classmethod
    def bulk_restore(cls, org, msgs: list):
        """
        Bulk restores (i.e. un-archives) the given incoming messages. Messages which aren't archived are ignored.
        """

        for msg in msgs:
            assert msg.direction == Msg.DIRECTION_IN, "only incoming messages can be restored"

        if msgs:
            mailroom.get_client().msg_restore(org, msgs)

    @classmethod
    def bulk_soft_delete(cls, org, user, msgs: list):
        """
        Bulk soft deletes the given incoming messages, i.e. clears content and updates its visibility to deleted.
        """

        attachments_to_delete = []

        for msg in msgs:
            assert msg.direction == Msg.DIRECTION_IN, "only incoming messages can be soft deleted"

            attachments_to_delete.extend(Attachment.parse_all(msg.attachments, ignore_invalid=True))

        Attachment.bulk_delete(attachments_to_delete)  # TODO move to mailroom as well

        mailroom.get_client().msg_delete(org, user, list(msgs))

    @classmethod
    def bulk_delete(cls, msgs: list):
        """
        Bulk hard deletes the given messages.
        """

        attachments_to_delete = []

        for msg in msgs:
            if msg.direction == Msg.DIRECTION_IN:
                attachments_to_delete.extend(Attachment.parse_all(msg.attachments, ignore_invalid=True))

        Attachment.bulk_delete(attachments_to_delete)

        cls.objects.filter(id__in=[m.id for m in msgs]).delete()

    def __repr__(self):  # pragma: no cover
        return f'<Msg: id={self.id} text="{self.text}">'

    class Meta:
        indexes = [
            # used by API messages endpoint hence the ordering, and general fetching by org or contact
            models.Index(name="msgs_by_org", fields=["org", "-created_on", "-id"]),
            models.Index(name="msgs_by_contact", fields=["contact", "-created_on", "-id"]),
            # used for finding errored messages to retry. Like the Android index below, the predicate doesn't
            # reference status, so that changing a message's status alone doesn't touch it - next_attempt is only ever
            # set whilst a message is awaiting a retry, which mailroom and courier maintain.
            models.Index(
                name="msgs_outgoing_awaiting_retry",
                fields=["next_attempt", "created_on", "id"],
                condition=Q(direction="O", next_attempt__isnull=False),
            ),
            # used for finding old Android messages to fail. The predicate is on the folder rather than the statuses
            # it's derived from so that changing a message's status doesn't touch this index - outbox membership is
            # exactly the visible outgoing messages still waiting to be sent (the folder derivation lives in mailroom
            # and courier). Postgres can only make a heap-only (HOT) update when no column that actually changed is
            # referenced by any index, and a partial index's predicate counts.
            #
            # Being keyed on the folder makes this narrower than indexing the statuses would: an outgoing message
            # that was deleted whilst still waiting to be sent is in the deleted folder, not the outbox. That's what
            # the query wants - there's nothing to fail on a message the user can no longer see.
            models.Index(
                name="msgs_android_outbox",
                fields=["created_on"],
                condition=Q(direction="O", folder="O", is_android=True),
            ),
            # used by the folder views and API folders, which filter by folder and page by uuid (time ordered as
            # message uuids are v7) - see MsgFolder.get_queryset. Partial on the user facing folders so it doesn't
            # also index every pending and deleted message.
            models.Index(
                name="msgs_by_folder",
                fields=["org", "folder", "-uuid"],
                condition=Q(folder__in=("I", "W", "A", "O", "S", "X")),
            ),
        ]
        constraints = [
            models.CheckConstraint(name="direction_is_in_or_out", condition=Q(direction="I") | Q(direction="O")),
            models.CheckConstraint(
                name="incoming_has_channel_and_urn",
                condition=Q(direction="O") | Q(channel__isnull=False, contact_urn__isnull=False),
            ),
            models.CheckConstraint(
                name="no_sent_status_without_sent_on",
                condition=(~Q(status__in=("W", "S", "D", "R"), sent_on__isnull=True)),
            ),
            # used by courier to lookup messages for status updates and prevent duplicate incoming messages
            models.UniqueConstraint(
                name="unique_msgs_external_identifiers",
                fields=["channel", "external_identifier"],
                condition=Q(external_identifier__isnull=False),
            ),
        ]


class BroadcastMsgCount(BaseSquashableCount):
    """
    Maintains count of how many msgs are tied to a broadcast
    """

    squash_over = ("broadcast_id",)

    broadcast = models.ForeignKey(Broadcast, on_delete=models.PROTECT, related_name="counts", db_index=True)

    @classmethod
    def get_count(cls, broadcast):
        return broadcast.counts.all().sum()

    @classmethod
    def bulk_annotate(cls, broadcasts):
        counts = (
            cls.objects.filter(broadcast_id__in=[b.id for b in broadcasts])
            .values("broadcast_id")
            .order_by("broadcast_id")
            .annotate(count=Sum("count"))
        )
        counts_by_bcast = {c["broadcast_id"]: c["count"] for c in counts}

        for bcast in broadcasts:
            bcast.msg_count = counts_by_bcast.get(bcast.id, 0)


class MsgFolder(Enum):
    """
    A folder of messages owned by an org.
    """

    # each folder's code (the Msg.folder value) and the S3 Select query which selects its messages from archived
    # message records - which have no folder field, so describe messages by state
    INBOX = (
        Msg.FOLDER_INBOX,
        dict(direction="in", visibility="visible", status="handled", flow__isnull=True),
    )
    HANDLED = (
        Msg.FOLDER_HANDLED,
        dict(direction="in", visibility="visible", status="handled", flow__isnull=False),
    )
    ARCHIVED = (
        Msg.FOLDER_ARCHIVED,
        dict(direction="in", visibility="archived", status="handled"),
    )
    OUTBOX = (
        Msg.FOLDER_OUTBOX,
        dict(direction="out", visibility="visible", status__in=("initializing", "queued", "errored")),
    )
    SENT = (
        Msg.FOLDER_SENT,
        dict(direction="out", visibility="visible", status__in=("wired", "sent", "delivered", "read")),
    )
    FAILED = (
        Msg.FOLDER_FAILED,
        dict(direction="out", visibility="visible", status="failed"),
    )

    def __init__(self, code, records_query: dict):
        self.code = code
        self.records_query = records_query

    @classmethod
    def from_code(cls, code):
        return next(f for f in cls if f.code == code)

    def get_queryset(self, org, *, after=None, before=None):
        """
        Returns the messages in this folder, newest first, optionally bounded by created_on (inclusive at both ends).
        The bounds are applied to uuid rather than created_on - message uuids are v7 and so time ordered - so that
        they're conditions on the folder index rather than a filter over everything it yields. A message's uuid can
        be a few milliseconds either side of its created_on - the writers read the clock separately for each, and a
        v7 generator which exhausts its sequence within a millisecond spills into the next - so both bounds are
        padded to cover that, at the cost of a few milliseconds of rows read and discarded at each end of a walk of
        the folder. The bounds are therefore a superset of the messages created in the range, and callers which need
        created_on itself honored filter on it as well.
        """
        # we don't use org.msgs here because it causes problems when the API is using different db connections
        qs = Msg.objects.filter(org=org, folder=self.code)
        if after:
            qs = qs.filter(uuid__gte=uuid7_range(after - self.UUID_PADDING)[0])
        if before:
            qs = qs.filter(uuid__lte=uuid7_range(before + self.UUID_PADDING)[1])

        return qs.order_by("-uuid")

    def get_archive_query(self) -> dict:
        return self.records_query.copy()

    @property
    def _count_scope(self) -> str:
        return f"msgs:folder:{self.code}"

    def get_count(self, org) -> int:
        return org.counts.filter(scope=self._count_scope).sum()

    @classmethod
    def get_counts(cls, org) -> dict:
        counts = org.counts.prefix("msgs:folder:").scope_totals()
        by_folder = {folder: counts.get(folder._count_scope, 0) for folder in cls}

        # TODO stuff counts for scheduled broadcasts and calls until we figure out what to do with them
        by_folder["scheduled"] = counts.get("msgs:folder:E", 0)
        by_folder["calls"] = counts.get("msgs:folder:C", 0)

        return by_folder

    def __repr__(self):  # pragma: no cover
        return f"<MsgFolder.{self.name} code={self.code}>"


# how far the bounds of a folder's uuid range are widened - see MsgFolder.get_queryset. Set outside the class as an
# attribute defined inside it would become a member.
MsgFolder.UUID_PADDING = timedelta(milliseconds=10)


class Label(TembaModel, DependencyMixin):
    """
    Labels represent both user defined labels and folders of labels. User defined labels that can be applied to messages
    much the same way labels or tags apply to messages in web-based email services.
    """

    MAX_ORG_FOLDERS = 250

    org_limit_key = Org.LIMIT_LABELS

    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="msgs_labels")

    @classmethod
    def create(cls, org, user, name: str):
        assert cls.is_valid_name(name), f"'{name}' is not a valid label name"
        assert not org.msgs_labels.filter(name__iexact=name).exists()

        return cls.objects.create(org=org, name=name, created_by=user, modified_by=user)

    @classmethod
    def create_from_import_def(cls, org, user, definition: dict):
        return cls.create(org, user, definition["name"])

    def get_messages(self):
        return self.msgs.all()

    def get_message_count(self):
        """
        Returns the count of messages tagged with this label, whatever folder they're in - a label is the user's own
        tag and is independent of where a message is filed. Deleted messages have their labellings removed so
        contribute nothing.
        """

        return LabelCount.get_totals([self])[self]

    def toggle_label(self, msgs, add: bool):
        """
        Adds or removes this label from the given incoming messages, via mailroom which ignores messages that aren't
        visible or whose labelling wouldn't change.
        """

        for msg in msgs:
            assert msg.direction == Msg.DIRECTION_IN, "only incoming messages can be labelled"

        if msgs:
            mailroom.get_client().msg_label(self.org, self, msgs, add=add)

    def release(self, user):
        super().release(user)  # releases flow dependencies

        # delete labellings of messages with this label (not the actual messages)
        MsgLabel.objects.filter(label=self).delete()

        self.counts.all().delete()

        self.name = self._deleted_name()
        self.is_active = False
        self.modified_by = user
        self.save(update_fields=("name", "is_active", "modified_by", "modified_on"))

    def __str__(self):  # pragma: needs cover
        return self.name

    class Meta:
        constraints = [models.UniqueConstraint("org", Lower("name"), name="unique_label_names")]


class MsgLabel(models.Model):
    """
    The labelling of a message with a label. Rows are written by mailroom - labelling goes through it - and only
    removed here when a label is released. Counts per label are maintained by database triggers (see LabelCount).

    The message's uuid is duplicated here so that a label's messages can be paged and date-bounded by uuid (time
    ordered, as message uuids are v7) the same way the folder views page the msgs_by_folder index - see
    MsgFolder.get_queryset. It's nullable until the services which write labellings are all writing it, after which
    it's backfilled, made required and indexed by (label, -msg_uuid).
    """

    id = models.BigAutoField(primary_key=True)
    msg = models.ForeignKey(Msg, on_delete=models.CASCADE)
    msg_uuid = models.UUIDField(null=True)
    label = models.ForeignKey(Label, on_delete=models.CASCADE)

    class Meta:
        db_table = "msgs_msg_labels"  # the table Django created for Msg.labels before this model was declared
        constraints = [models.UniqueConstraint(name="unique_msg_labels", fields=["msg", "label"])]


class LabelCount(BaseSquashableCount):
    """
    Counts of user labels maintained by database level triggers
    """

    squash_over = ("label_id",)

    label = models.ForeignKey(Label, on_delete=models.PROTECT, related_name="counts")

    @classmethod
    def get_totals(cls, labels):
        """
        Gets total counts for all the given labels
        """
        counts = cls.objects.filter(label__in=labels).values_list("label_id").annotate(count_sum=Sum("count"))
        counts_by_label_id = {c[0]: c[1] for c in counts}
        return {lb: counts_by_label_id.get(lb.id, 0) for lb in labels}


class MsgIterator:
    """
    Queryset wrapper to chunk queries and reduce in-memory footprint
    """

    def __init__(
        self, ids, order_by=None, select_related=None, prefetch_related=None, using="default", max_obj_num=1000
    ):
        self._ids = ids
        self._order_by = order_by
        self._select_related = select_related
        self._prefetch_related = prefetch_related
        self._using = using
        self._generator = self._setup()
        self.max_obj_num = max_obj_num

    def _setup(self):
        for i in range(0, len(self._ids), self.max_obj_num):
            chunk_queryset = Msg.objects.using(self._using).filter(id__in=self._ids[i : i + self.max_obj_num])

            if self._order_by:
                chunk_queryset = chunk_queryset.order_by(*self._order_by)

            if self._select_related:
                chunk_queryset = chunk_queryset.select_related(*self._select_related)

            if self._prefetch_related:
                chunk_queryset = chunk_queryset.prefetch_related(*self._prefetch_related)

            yield chunk_queryset

    def __iter__(self):
        return self

    def __next__(self):
        return next(self._generator)


class MessageExport(ExportType):
    """
    Export of messages
    """

    slug = "message"
    name = _("Messages")
    download_prefix = "messages"
    download_template = "msgs/export_download.html"

    @classmethod
    def create(cls, org, user, start_date, end_date, folder=None, label=None, with_fields=(), with_groups=()):
        export = Export.objects.create(
            org=org,
            export_type=cls.slug,
            start_date=start_date,
            end_date=end_date,
            config={
                "system_label": folder.code if folder else None,
                "label_uuid": str(label.uuid) if label else None,
                "with_fields": [f.id for f in with_fields],
                "with_groups": [g.id for g in with_groups],
            },
            created_by=user,
        )
        return export

    def get_folder(self, export) -> tuple:
        label_uuid = export.config.get("label_uuid")
        folder_code = export.config.get("system_label")
        if label_uuid:
            return None, export.org.msgs_labels.filter(uuid=label_uuid).first()
        elif folder_code:
            return MsgFolder.from_code(folder_code), None
        else:
            return None, None

    def write(self, export):
        folder, label = self.get_folder(export)
        start_date, end_date = export.get_date_range()

        # create our exporter
        exporter = MultiSheetExporter(
            "Messages",
            ["Date"]
            + export.get_contact_headers()
            + ["Flow", "Direction", "Text", "Attachments", "Status", "Channel", "Labels"],
            export.org.timezone,
        )
        num_records = 0
        logger.info(f"starting msgs export #{export.id} for org #{export.org.id}")

        for batch in self._get_msg_batches(export, folder, label, start_date, end_date):
            self._write_msgs(export, exporter, batch)

            num_records += len(batch)

            # update modified_on so we can see if an export hangs
            export.modified_on = timezone.now()
            export.save(update_fields=("modified_on",))

        return *exporter.save_file(), num_records

    def _get_msg_batches(self, export, folder, label, start_date, end_date):
        from temba.archives.models import Archive
        from temba.flows.models import Flow

        # firstly get msgs from archives
        if folder:
            where = folder.get_archive_query()
        elif label:
            # a label's messages are exported regardless of folder, and deleted messages are never archived
            where = {"__raw__": f"'{label.uuid}' IN s.labels[*].uuid"}
        else:
            where = {"visibility": "visible"}

        records = Archive.iter_all_records(export.org, Archive.TYPE_MSG, start_date, end_date, where=where)
        last_created_on = None

        for record_batch in itertools.batched(records, 1000):
            matching = []
            for record in record_batch:
                created_on = iso8601.parse_date(record["created_on"])
                if last_created_on is None or last_created_on < created_on:
                    last_created_on = created_on

                matching.append(record)
            yield matching

        order_by = "created_on"

        if folder:
            # the uuid bounds put the date range on the folder index, and ordering by uuid walks it rather than
            # sorting - they're a superset of the range, which the created_on filter below then makes exact
            messages = folder.get_queryset(export.org, after=start_date, before=end_date)
            order_by = "uuid"
        elif label:
            messages = label.get_messages().exclude(folder=Msg.FOLDER_DELETED)
        else:
            messages = export.org.msgs.exclude(folder__in=(Msg.FOLDER_ARCHIVED, Msg.FOLDER_DELETED))

        messages = messages.filter(created_on__gte=start_date, created_on__lte=end_date)

        messages = messages.order_by(order_by).using("readonly")
        if last_created_on:
            messages = messages.filter(created_on__gt=last_created_on)

        all_message_ids = array(str("l"), messages.values_list("id", flat=True))

        for msg_batch in MsgIterator(
            all_message_ids,
            order_by=("created_on",),
            select_related=("channel", "contact_urn"),
            prefetch_related=(
                Prefetch("contact", queryset=Contact.objects.only("uuid", "name")),
                Prefetch("flow", queryset=Flow.objects.only("uuid", "name")),
                Prefetch("labels", queryset=Label.objects.only("uuid", "name").order_by("name")),
            ),
            using="readonly",
        ):
            # convert this batch of msgs to same format as records in our archives
            yield [msg.as_archive_json() for msg in msg_batch]

    def _write_msgs(self, export, exporter, msgs):
        # get all the contacts referenced in this batch
        contact_uuids = {m["contact"]["uuid"] for m in msgs}
        contacts = (
            Contact.objects.filter(org=export.org, uuid__in=contact_uuids)
            .select_related("org")
            .prefetch_related("groups")
            .using("readonly")
        )
        contacts_by_uuid = {str(c.uuid): c for c in contacts}

        for msg in msgs:
            contact = contacts_by_uuid.get(msg["contact"]["uuid"])
            flow = msg.get("flow")

            exporter.write_row(
                [iso8601.parse_date(msg["created_on"])]
                + export.get_contact_columns(contact, urn=msg["urn"])
                + [
                    flow["name"] if flow else None,
                    msg["direction"].upper() if msg["direction"] else None,
                    msg["text"],
                    ", ".join(attachment["url"] for attachment in msg["attachments"]),
                    msg["status"],
                    msg["channel"]["name"] if msg["channel"] else "",
                    ", ".join(msg_label["name"] for msg_label in msg["labels"]),
                ],
            )

    def get_download_context(self, export) -> dict:
        folder, label = self.get_folder(export)
        return {"label": label} if label else {}
