from collections import defaultdict
from datetime import datetime, timedelta, timezone as tzone

from django_valkey import get_valkey_connection
from smartmin.models import SmartModel

from django.contrib.postgres.fields import ArrayField
from django.db import models
from django.db.models import Sum
from django.utils import timezone
from django.utils.translation import gettext_lazy as _, ngettext

from temba import mailroom
from temba.contacts.models import ContactField, ContactGroup
from temba.flows.models import Flow
from temba.orgs.models import Org
from temba.utils import json, languages, on_transaction_commit
from temba.utils.models import TembaModel, TembaUUIDMixin, delete_in_batches


class Campaign(TembaModel):
    org = models.ForeignKey(Org, related_name="campaigns", on_delete=models.PROTECT)
    group = models.ForeignKey(ContactGroup, on_delete=models.PROTECT, related_name="campaigns")
    is_archived = models.BooleanField(default=False)

    @classmethod
    def create(cls, org, user, name, group):
        assert cls.is_valid_name(name), f"'{name}' is not a valid campaign name"

        return cls.objects.create(org=org, name=name, group=group, created_by=user, modified_by=user)

    def schedule_async(self):
        """
        Schedules or reschedules all the events in this campaign. Required on creation or when group changes.
        """

        for event in self.get_events().order_by("id"):
            event.schedule_async()

    def archive(self, user):
        self.is_archived = True
        self.modified_by = user
        self.modified_on = timezone.now()
        self.save(update_fields=("is_archived", "modified_by", "modified_on"))

    @classmethod
    def import_campaigns(cls, org, user, campaign_defs, same_site=False) -> list:
        """
        Import campaigns from a list of exported campaigns
        """

        imported = []

        for campaign_def in campaign_defs:
            name = cls.clean_name(campaign_def["name"])
            group_ref = campaign_def["group"]
            campaign = None
            group = None

            # if export is from this site, lookup objects by UUID
            if same_site:
                group = ContactGroup.get_or_create(org, user, group_ref["name"], uuid=group_ref["uuid"])

                campaign = Campaign.objects.filter(org=org, uuid=campaign_def["uuid"]).first()
                if campaign:  # pragma: needs cover
                    campaign.name = Campaign.get_unique_name(org, name, ignore=campaign)
                    campaign.save()

            # fall back to lookups by name
            if not group:
                group = ContactGroup.get_or_create(org, user, group_ref["name"])

            if not campaign:
                campaign = Campaign.objects.filter(org=org, name=name).first()

            if not campaign:
                campaign_name = Campaign.get_unique_name(org, name)
                campaign = Campaign.create(org, user, campaign_name, group)
            else:
                campaign.group = group
                campaign.save()

            # deactivate all of our events, we'll recreate these
            for event in campaign.events.all():
                event.release(user)

            # fill our campaign with events
            for event_spec in campaign_def["events"]:
                field_key = event_spec["relative_to"]["key"]

                if field_key in ("created_on", "last_seen_on"):
                    relative_to = org.fields.filter(key=field_key, is_system=True).first()
                else:
                    relative_to = ContactField.get_or_create(
                        org,
                        user,
                        key=field_key,
                        name=event_spec["relative_to"]["label"],
                        value_type=ContactField.TYPE_DATETIME,
                    )

                start_mode = event_spec.get("start_mode", CampaignEvent.MODE_INTERRUPT)

                # create our message flow for message events
                if event_spec["event_type"] == CampaignEvent.TYPE_MESSAGE:
                    message = event_spec["message"]
                    base_language = event_spec.get("base_language")

                    # force the message value into a dict
                    if not isinstance(message, dict):
                        try:
                            message = json.loads(message)
                        except ValueError:
                            # if it's not a language dict, turn it into one
                            message = dict(base=message)
                            base_language = "base"

                    # change base to und
                    if "base" in message:
                        message["und"] = message["base"]
                        del message["base"]
                        base_language = "und"

                    # ensure base language is valid
                    if base_language not in message:  # pragma: needs cover
                        base_language = next(iter(message))

                    CampaignEvent.create_message_event(
                        org,
                        user,
                        campaign,
                        relative_to,
                        event_spec["offset"],
                        event_spec["unit"],
                        {lang: {"text": val} for lang, val in message.items()},
                        base_language=base_language,
                        delivery_hour=event_spec["delivery_hour"],
                        start_mode=start_mode,
                    )
                else:
                    flow = Flow.objects.filter(
                        org=org, is_active=True, is_system=False, uuid=event_spec["flow"]["uuid"]
                    ).first()
                    if flow:
                        CampaignEvent.create_flow_event(
                            org,
                            user,
                            campaign,
                            relative_to,
                            event_spec["offset"],
                            event_spec["unit"],
                            flow,
                            event_spec["delivery_hour"],
                            start_mode=start_mode,
                        )

            imported.append(campaign)

        return imported

    @classmethod
    def apply_action_archive(cls, user, campaigns):
        for campaign in campaigns:
            campaign.archive(user)

    @classmethod
    def apply_action_restore(cls, user, campaigns):
        campaigns.update(is_archived=False, modified_by=user, modified_on=timezone.now())

        for campaign in campaigns:
            # for any flow events, ensure flows are restored as well
            events = (
                campaign.events.filter(is_active=True, event_type=CampaignEvent.TYPE_FLOW)
                .exclude(flow=None)
                .select_related("flow")
            )
            for event in events:
                event.flow.restore(user)

            campaign.schedule_async()

    def get_events(self):
        return self.events.filter(is_active=True).select_related("flow", "relative_to")

    def get_sorted_events(self):
        """
        Gets events sorted by relative_to+offset and with fire counts prefetched.
        """

        events = sorted(self.get_events(), key=lambda e: (e.relative_to.name, e.get_offset()))
        self.prefetch_fire_counts(events)
        return events

    def prefetch_fire_counts(self, events):
        """
        Prefetches contact fire counts for all events
        """

        scopes = [f"campfires:{e.id}:{e.fire_version}" for e in events]
        counts = self.org.counts.filter(scope__in=scopes).values_list("scope").annotate(total=Sum("count"))
        by_event = defaultdict(int)
        for count in counts:
            event_id = int(count[0].split(":")[1])
            by_event[event_id] = count[1]

        for event in events:
            setattr(event, "_fire_count", by_event[event.id])

    def as_export_def(self):
        """
        The definition of this campaign for export. Note this only includes references to the dependent
        flows which will be exported separately.
        """
        events = []

        for event in self.events.filter(is_active=True).order_by("flow__uuid"):
            event_definition = {
                "uuid": str(event.uuid),
                "offset": event.offset,
                "unit": event.unit,
                "event_type": event.event_type,
                "delivery_hour": event.delivery_hour,
                "relative_to": dict(label=event.relative_to.name, key=event.relative_to.key),  # TODO should be key/name
                "start_mode": event.start_mode,
            }

            # only include the flow definition for standalone flows
            if event.event_type == CampaignEvent.TYPE_FLOW:
                event_definition["flow"] = event.flow.as_export_ref()

            # include the translations and base language for message flows
            elif event.event_type == CampaignEvent.TYPE_MESSAGE:
                event_definition["message"] = {lang: t["text"] for lang, t in event.translations.items()}
                event_definition["base_language"] = event.base_language

            events.append(event_definition)

        return {
            "uuid": str(self.uuid),
            "name": self.name,
            "group": self.group.as_export_ref(),
            "events": events,
        }

    def delete(self):
        """
        Deletes this campaign completely
        """

        delete_in_batches(self.events.all())

        super().delete()

    def release(self, user):
        self.is_active = False
        self.modified_by = user
        self.modified_on = timezone.now()
        self.save(update_fields=("is_active", "modified_by", "modified_on"))

        for event in self.get_events():
            event.release(user)

    class Meta:
        verbose_name = _("Campaign")
        verbose_name_plural = _("Campaigns")


class CampaignEvent(TembaUUIDMixin, SmartModel):
    """
    An event within a campaign that can send a message to a contact or start them in a flow
    """

    TYPE_FLOW = "F"
    TYPE_MESSAGE = "M"
    TYPE_CHOICES = ((TYPE_FLOW, "Flow Event"), (TYPE_MESSAGE, "Message Event"))

    STATUS_SCHEDULING = "S"
    STATUS_READY = "R"
    STATUS_CHOICES = ((STATUS_SCHEDULING, _("Scheduling")), (STATUS_READY, _("Ready")))

    UNIT_MINUTES = "M"
    UNIT_HOURS = "H"
    UNIT_DAYS = "D"
    UNIT_WEEKS = "W"
    UNIT_CHOICES = (
        (UNIT_MINUTES, _("Minutes")),
        (UNIT_HOURS, _("Hours")),
        (UNIT_DAYS, _("Days")),
        (UNIT_WEEKS, _("Weeks")),
    )

    MODE_INTERRUPT = "I"
    MODE_SKIP = "S"
    MODE_PASSIVE = "P"
    START_MODES_CHOICES = ((MODE_INTERRUPT, "Interrupt"), (MODE_SKIP, "Skip"), (MODE_PASSIVE, "Passive"))

    campaign = models.ForeignKey(Campaign, on_delete=models.PROTECT, related_name="events")
    event_type = models.CharField(max_length=1, choices=TYPE_CHOICES, default=TYPE_FLOW)
    status = models.CharField(max_length=1, choices=STATUS_CHOICES, default=STATUS_READY)
    fire_version = models.IntegerField(default=0)  # updated when the scheduling values below are changed

    # the schedule: a datetime field and an offset
    relative_to = models.ForeignKey(ContactField, on_delete=models.PROTECT, related_name="campaign_events")
    offset = models.IntegerField(default=0)  # offset from that date value (positive is after, negative is before)
    unit = models.CharField(max_length=1, choices=UNIT_CHOICES, default=UNIT_DAYS)  # the unit for the offset
    delivery_hour = models.IntegerField(default=-1)  # can also specify the hour during the day

    # the content: either a flow or message translations
    flow = models.ForeignKey(Flow, on_delete=models.PROTECT, related_name="campaign_events", null=True, blank=True)
    translations = models.JSONField(null=True)  # text, attachments and quick replies by language
    base_language = models.CharField(max_length=3, null=True)  # ISO-639-3
    template = models.ForeignKey("templates.Template", null=True, blank=True, on_delete=models.PROTECT)
    template_variables = ArrayField(models.TextField(), null=True, blank=True)

    # what should happen to other runs when this event is triggered
    start_mode = models.CharField(max_length=1, choices=START_MODES_CHOICES, default=MODE_INTERRUPT)

    @classmethod
    def create_message_event(
        cls,
        org,
        user,
        campaign,
        relative_to,
        offset,
        unit,
        translations: dict[str, dict],
        *,
        base_language: str,
        delivery_hour=-1,
        start_mode=MODE_INTERRUPT,
        template=None,
        template_variables=(),
    ):
        assert campaign.org == org, "org mismatch"
        assert base_language and languages.get_name(base_language), f"{base_language} is not a valid language code"
        assert base_language in translations, "no translation for base language"

        if relative_to.value_type != ContactField.TYPE_DATETIME:
            raise ValueError(
                f"Contact fields for CampaignEvents must have a datetime type, got {relative_to.value_type}."
            )

        return cls.objects.create(
            campaign=campaign,
            relative_to=relative_to,
            offset=offset,
            unit=unit,
            event_type=cls.TYPE_MESSAGE,
            translations=translations,
            base_language=base_language,
            delivery_hour=delivery_hour,
            start_mode=start_mode,
            template=template,
            template_variables=list(template_variables) if template_variables else None,
            created_by=user,
            modified_by=user,
        )

    @classmethod
    def create_flow_event(
        cls, org, user, campaign, relative_to, offset, unit, flow, delivery_hour=-1, start_mode=MODE_INTERRUPT
    ):
        if campaign.org != org:
            raise ValueError("Org mismatch")

        if relative_to.value_type != ContactField.TYPE_DATETIME:
            raise ValueError(
                f"Contact fields for CampaignEvents must have a datetime type, got '{relative_to.value_type}'."
            )

        return cls.objects.create(
            campaign=campaign,
            relative_to=relative_to,
            offset=offset,
            unit=unit,
            event_type=cls.TYPE_FLOW,
            flow=flow,
            start_mode=start_mode,
            delivery_hour=delivery_hour,
            created_by=user,
            modified_by=user,
        )

    @classmethod
    def get_hour_choices(cls):
        hours = [(-1, "during the same hour"), (0, "at Midnight")]
        period = "a.m."
        for i in range(1, 24):
            hour = i
            if i >= 12:
                period = "p.m."
                if i > 12:
                    hour -= 12
            hours.append((i, "at %s:00 %s" % (hour, period)))
        return hours

    @property
    def name(self):
        return f"{self.campaign.name} ({self.offset_display} {self.relative_to.name})"

    def get_message(self, contact=None) -> dict:
        """
        For message type events returns the message translation
        """
        assert self.event_type == self.TYPE_MESSAGE, "can only call get_message on message type events"

        translation = None
        if contact and contact.language and contact.language in self.translations:
            translation = self.translations[contact.language]

        if not translation:
            translation = self.translations[self.base_language]

        return translation

    def get_offset(self) -> timedelta:
        """
        Converts offset and unit into a timedelta object
        """

        if self.unit == self.UNIT_MINUTES:
            return timedelta(minutes=self.offset)
        if self.unit == self.UNIT_HOURS:
            return timedelta(hours=self.offset)
        elif self.unit == self.UNIT_DAYS:
            return timedelta(days=self.offset)
        elif self.unit == self.UNIT_WEEKS:
            return timedelta(days=7 * self.offset)

    @property
    def offset_display(self):
        """
        Returns the offset and units as a human readable string
        """
        count = abs(self.offset)
        if self.offset < 0:
            if self.unit == "M":
                return ngettext("%d minute before", "%d minutes before", count) % count
            elif self.unit == "H":
                return ngettext("%d hour before", "%d hours before", count) % count
            elif self.unit == "D":
                return ngettext("%d day before", "%d days before", count) % count
            elif self.unit == "W":
                return ngettext("%d week before", "%d weeks before", count) % count
        elif self.offset > 0:
            if self.unit == "M":
                return ngettext("%d minute after", "%d minutes after", count) % count
            elif self.unit == "H":
                return ngettext("%d hour after", "%d hours after", count) % count
            elif self.unit == "D":
                return ngettext("%d day after", "%d days after", count) % count
            elif self.unit == "W":
                return ngettext("%d week after", "%d weeks after", count) % count
        else:
            return _("on")

    def schedule_async(self):
        self.delete_fire_counts()  # new counts will be created with new fire version

        self.fire_version += 1
        self.status = self.STATUS_SCHEDULING
        self.save(update_fields=("fire_version", "status"))

        on_transaction_commit(lambda: mailroom.get_client().campaign_schedule(self.campaign.org, self))

    def get_recent_fires(self) -> list[dict]:
        r = get_valkey_connection()
        key = f"recent_campaign_fires:{self.id}"

        # fetch members of the sorted set from valkey and save as tuples of (contact_id, operand, time)
        contact_ids = set()
        raw = []
        for member, score in r.zrange(key, start=0, end=-1, desc=True, withscores=True):
            rand, contact_id = member.decode().split("|", maxsplit=2)
            contact_ids.add(int(contact_id))
            raw.append((int(contact_id), datetime.fromtimestamp(score, tzone.utc)))

        # lookup all the referenced contacts
        contacts_by_id = {c.id: c for c in self.campaign.org.contacts.filter(id__in=contact_ids, is_active=True)}

        # if contact still exists, include in results
        recent = []
        for r in raw:
            if contact := contacts_by_id.get(r[0]):
                recent.append({"contact": contact, "time": r[1]})

        return recent

    def get_fire_count(self) -> int:
        if hasattr(self, "_fire_count"):  # use prefetched value if available
            return self._fire_count

        return self.campaign.org.counts.filter(scope=f"campfires:{self.id}:{self.fire_version}").sum()

    def delete_fire_counts(self):
        self.campaign.org.counts.filter(scope__startswith=f"campfires:{self.id}:").delete()

    def release(self, user):
        """
        Marks the event inactive and releases flows for single message flows
        """

        self.is_active = False
        self.modified_by = user
        self.modified_on = timezone.now()
        self.save(update_fields=("is_active", "modified_by", "modified_on"))

        self.delete_fire_counts()

    def __repr__(self):
        return f"<Event: id={self.id} relative_to={self.relative_to.key} offset={self.get_offset()}>"

    class Meta:
        verbose_name = _("Campaign Event")
        verbose_name_plural = _("Campaign Events")
