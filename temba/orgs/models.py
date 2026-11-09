import itertools
import logging
import os
from abc import ABCMeta
from collections import defaultdict
from datetime import date, datetime, timedelta
from enum import Enum
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any
from urllib.parse import urlparse

import pycountry
from django_valkey import get_valkey_connection
from packaging.version import Version
from timezone_field import TimeZoneField

from django.conf import settings
from django.contrib.auth.models import Group
from django.contrib.postgres.fields import ArrayField
from django.contrib.postgres.indexes import OpClass
from django.contrib.postgres.validators import ArrayMinLengthValidator
from django.contrib.staticfiles import finders
from django.core.files import File
from django.core.files.storage import default_storage
from django.core.validators import MaxValueValidator
from django.db import connection, models, transaction
from django.db.models import Count, Exists, Prefetch, Q
from django.utils import timezone
from django.utils.encoding import force_str
from django.utils.functional import cached_property
from django.utils.text import slugify
from django.utils.translation import gettext_lazy as _

from temba import mailroom
from temba.archives.models import Archive
from temba.locations.models import AdminBoundary
from temba.users.models import User
from temba.utils import audit, json, languages, on_transaction_commit
from temba.utils.dates import datetime_to_str
from temba.utils.email import EmailSender
from temba.utils.models import (
    CreatedByMixin,
    LegacyIDMixin,
    ModifiedByMixin,
    SoftDeleteMixin,
    UUIDMixin,
    delete_in_batches,
)
from temba.utils.models.counts import BaseDailyCount, BaseScopedCount
from temba.utils.text import generate_secret
from temba.utils.timezones import timezone_to_country_code
from temba.utils.uuid import uuid4

logger = logging.getLogger(__name__)


class DependencyMixin:
    """
    Utility mixin for models which can be flow dependencies
    """

    soft_dependent_types = {"flow"}

    def get_dependents(self):
        return {"flow": self.dependent_flows.filter(is_active=True)}

    @classmethod
    def annotate_usage(cls, queryset):
        return queryset.annotate(usage_count=Count("dependent_flows", distinct=True))

    def release(self, user):
        """
        Mark this dependency's flows as having issues, and then remove the dependencies
        """

        for dep_type, deps in self.get_dependents().items():
            if dep_type not in self.soft_dependent_types and deps.exists():
                raise AssertionError(f"can't delete {self} that still has {dep_type} dependents")

        self.dependent_flows.update(has_issues=True)
        self.dependent_flows.clear()


class IntegrationType(metaclass=ABCMeta):
    """
    IntegrationType is our abstract base type for third party integrations.
    """

    class Category(Enum):
        CHANNELS = 1
        EMAIL = 2
        AIRTIME = 3
        MONITORING = 4

    # the verbose name for this type
    name = None

    # the short code for this type (< 16 chars, lowercase)
    slug = None

    # the icon to show for this type
    icon = "icon-plug"

    # the category of features this integration provides
    category = None

    def is_available_to(self, user) -> bool:
        """
        Determines whether this integration type is available to the given user
        """
        return True

    def is_connected(self, org) -> bool:
        """
        Returns whether the given org is connected to this integration
        """

    def disconnect(self, org, user):
        """
        Disconnects this integration on the given org
        """

    def management_ui(self, org, formax):
        """
        Adds formax sections to provide a UI to manage this integration
        """

    def get_urls(self) -> list:
        """
        Returns the urls and views for this integration
        """

    @classmethod
    def get_all(cls, category: Category = None) -> list:
        """
        Returns all possible types with the given category
        """
        from .integrations import TYPES

        return [t for t in TYPES.values() if not category or t.category == category]


class OrgRole(Enum):
    ADMINISTRATOR = ("A", _("Administrator"), _("Administrators"), "Administrators", "msgs.msg_inbox")
    EDITOR = ("E", _("Editor"), _("Editors"), "Editors", "msgs.msg_inbox")
    AGENT = ("T", _("Agent"), _("Agents"), "Agents", "tickets.ticket_list")

    def __init__(self, code: str, display: str, display_plural: str, group_name: str, start_view: str):
        self.code = code
        self.display = display
        self.display_plural = display_plural
        self.group_name = group_name
        self.start_view = start_view

    @classmethod
    def from_code(cls, code: str):
        for role in cls:
            if role.code == code:
                return role
        return None

    @classmethod
    def from_group(cls, group: Group):
        for role in cls:
            if role.group == group:
                return role
        return None

    @cached_property
    def group(self):
        """
        The auth group which defines the permissions for this role
        """
        return Group.objects.get(name=self.group_name)

    @cached_property
    def permissions(self) -> set:
        perms = self.group.permissions.select_related("content_type")
        return {f"{p.content_type.app_label}.{p.codename}" for p in perms}

    @cached_property
    def api_permissions(self) -> set:
        return set(settings.API_PERMISSIONS.get(self.group_name, ()))

    @classmethod
    def choices(cls):
        return [(r.code, r.display) for r in cls]

    def has_perm(self, permission: str) -> bool:
        """
        Returns whether this role has the given permission
        """
        return permission in self.permissions

    def has_api_perm(self, permission: str) -> bool:
        """
        Returns whether this role has the given permission in the context of an API request.
        """
        return self.has_perm(permission) or permission in self.api_permissions


class Org(LegacyIDMixin, CreatedByMixin, ModifiedByMixin, SoftDeleteMixin):
    """
    An Org can have several users and is the main component that holds all Flows, Messages, Contacts, etc.

    Users will create new Org for Flows that should be kept separate (say for distinct projects), or for
    each country where they are deploying messaging applications.
    """

    DATE_FORMAT_DAY_FIRST = "D"
    DATE_FORMAT_MONTH_FIRST = "M"
    DATE_FORMAT_YEAR_FIRST = "Y"
    DATE_FORMAT_CHOICES = (
        (DATE_FORMAT_DAY_FIRST, "DD-MM-YYYY"),
        (DATE_FORMAT_MONTH_FIRST, "MM-DD-YYYY"),
        (DATE_FORMAT_YEAR_FIRST, "YYYY-MM-DD"),
    )
    DATE_FORMATS_PYTHON = {
        DATE_FORMAT_DAY_FIRST: "%d-%m-%Y",
        DATE_FORMAT_MONTH_FIRST: "%m-%d-%Y",
        DATE_FORMAT_YEAR_FIRST: "%Y-%m-%d",
    }
    DATE_FORMATS_ENGINE = {
        DATE_FORMAT_DAY_FIRST: "DD-MM-YYYY",
        DATE_FORMAT_MONTH_FIRST: "MM-DD-YYYY",
        DATE_FORMAT_YEAR_FIRST: "YYYY-MM-DD",
    }

    COLLATION_DEFAULT = "default"
    COLLATION_CONFUSABLES = "confusables"
    COLLATION_ARABIC_VARIANTS = "arabic_variants"
    COLLATION_CHOICES = (
        (COLLATION_DEFAULT, _("Case insensitive (e.g. A = a)")),
        (COLLATION_CONFUSABLES, _("Visually similiar characters (e.g. 𝓐 = A = a = ⍺)")),
        (COLLATION_ARABIC_VARIANTS, _("Arabic, Farsi and Pashto equivalents (e.g. ي = ی = ۍ)")),
    )

    CONFIG_VERIFIED = "verified"
    CONFIG_TWILIO_SID = "ACCOUNT_SID"
    CONFIG_TWILIO_TOKEN = "ACCOUNT_TOKEN"
    CONFIG_VONAGE_KEY = "NEXMO_KEY"
    CONFIG_VONAGE_SECRET = "NEXMO_SECRET"

    EARLIEST_IMPORT_VERSION = "3"
    CURRENT_EXPORT_VERSION = "13"

    FEATURE_USERS = "users"  # can invite users to this org
    FEATURE_NEW_ORGS = "new_orgs"  # can create new workspace with same login
    FEATURE_CHILD_ORGS = "child_orgs"  # can create child workspaces of this org
    FEATURE_TEAMS = "teams"  # can create teams to organize agent users
    FEATURE_PROMETHEUS = "prometheus"  # can create a prometheus token to access metrics
    FEATURE_SHARED_CHANNELS = "shared_channels"  # can share channels between orgs
    FEATURE_AGENTS = "agents"  # can create AI agents to handle contact conversations
    FEATURE_UNRESTRICTED_WEBHOOKS = "unrestricted_webhooks"  # can call webhooks to otherwise blocked domains
    FEATURE_TICKET_TRIGGERS = "ticket_triggers"  # triggers still fire for contacts with open tickets
    FEATURES_CHOICES = (
        (FEATURE_USERS, _("Users")),
        (FEATURE_NEW_ORGS, _("New Orgs")),
        (FEATURE_CHILD_ORGS, _("Child Orgs")),
        (FEATURE_TEAMS, _("Teams")),
        (FEATURE_PROMETHEUS, _("Prometheus")),
        (FEATURE_SHARED_CHANNELS, _("Shared Channels")),
        (FEATURE_AGENTS, _("Agents")),
        (FEATURE_UNRESTRICTED_WEBHOOKS, _("Unrestricted Webhooks")),
        (FEATURE_TICKET_TRIGGERS, _("Ticket Triggers")),
    )

    LIMIT_CHANNELS = "channels"
    LIMIT_CONTACTS = "contacts"
    LIMIT_FIELDS = "fields"
    LIMIT_FLOWS = "flows"
    LIMIT_GLOBALS = "globals"
    LIMIT_GROUPS = "groups"
    LIMIT_KNOWLEDGE = "knowledge"
    LIMIT_LABELS = "labels"
    LIMIT_LLMS = "llms"
    LIMIT_TOPICS = "topics"
    LIMIT_TEAMS = "teams"
    LIMIT_TRIGGERS = "triggers"

    DELETE_DELAY_DAYS = 7  # how many days after releasing that an org is deleted
    OUTBOX_WARNING_THRESHOLD = 10_000

    BLOCKER_SUSPENDED = _(
        "Sorry, your workspace is currently suspended. To re-enable starting flows and sending messages, please "
        "contact support."
    )
    BLOCKER_FLAGGED = _(
        "Sorry, your workspace is currently flagged. To re-enable starting flows and sending messages, please "
        "contact support."
    )

    uuid = models.UUIDField(unique=True, default=uuid4)
    name = models.CharField(verbose_name=_("Name"), max_length=128)
    parent = models.ForeignKey("orgs.Org", on_delete=models.PROTECT, null=True, related_name="children")
    users = models.ManyToManyField(settings.AUTH_USER_MODEL, through="OrgMembership", related_name="orgs")

    # auth groups whose members have the administrator role in this org without needing a membership
    admin_groups = models.ManyToManyField(Group, related_name="admin_orgs")

    language = models.CharField(
        verbose_name=_("Default Language"),
        max_length=64,
        null=True,
        choices=settings.LANGUAGES,
        default=settings.DEFAULT_LANGUAGE,
        help_text=_("Default website language for new users."),
    )

    # environment for flows and messages
    timezone = TimeZoneField(verbose_name=_("Timezone"))
    date_format = models.CharField(
        verbose_name=_("Date Format"),
        max_length=1,
        choices=DATE_FORMAT_CHOICES,
        default=DATE_FORMAT_DAY_FIRST,
        help_text=_("Default formatting and parsing of dates in flows and messages."),
    )
    root_location = models.ForeignKey("locations.AdminBoundary", null=True, on_delete=models.PROTECT, related_name="+")
    flow_languages = ArrayField(models.CharField(max_length=3), default=list, validators=[ArrayMinLengthValidator(1)])
    input_collation = models.CharField(max_length=32, choices=COLLATION_CHOICES, default=COLLATION_DEFAULT)
    flow_smtp = models.CharField(null=True)  # e.g. smtp://...
    prometheus_token = models.CharField(null=True, max_length=40)

    # how long open tickets can go without activity before being closed automatically, zero to never close them
    max_ticket_idle_days = models.PositiveIntegerField(default=30, validators=[MaxValueValidator(30)])

    config = models.JSONField(default=dict)
    slug = models.SlugField(
        verbose_name=_("Slug"),
        max_length=255,
        null=True,
        blank=True,
        unique=True,
        error_messages=dict(unique=_("This slug is not available")),
    )

    features = ArrayField(models.CharField(max_length=32), default=list)
    limits = models.JSONField(default=dict)
    api_rates = models.JSONField(default=dict)

    is_anon = models.BooleanField(
        default=False, help_text=_("Whether this organization anonymizes the phone numbers of contacts within it")
    )
    is_flagged = models.BooleanField(default=False, help_text=_("Whether this organization is currently flagged."))
    is_suspended = models.BooleanField(default=False, help_text=_("Whether this organization is currently suspended."))

    suspended_on = models.DateTimeField(null=True)
    released_on = models.DateTimeField(null=True)
    deleted_on = models.DateTimeField(null=True)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self._membership_cache = {}
        self._group_admin_cache = {}

    @classmethod
    def get_unique_slug(cls, name):
        slug = slugify(name)

        unique_slug = slug
        if unique_slug:
            existing = Org.objects.filter(slug=unique_slug).exists()
            count = 2
            while existing:
                unique_slug = "%s-%d" % (slug, count)
                existing = Org.objects.filter(slug=unique_slug).exists()
                count += 1

            return unique_slug

    @classmethod
    def create(cls, user, name: str, tz):
        """
        Creates a new workspace.
        """

        is_us = timezone_to_country_code(tz) == "US"
        date_format = Org.DATE_FORMAT_MONTH_FIRST if is_us else cls.DATE_FORMAT_DAY_FIRST

        # use default user language as default flow language too
        default_flow_language = languages.alpha2_to_alpha3(settings.DEFAULT_LANGUAGE)
        flow_languages = [default_flow_language] if default_flow_language else ["eng"]

        org = Org.objects.create(
            name=name,
            timezone=tz,
            date_format=date_format,
            language=settings.DEFAULT_LANGUAGE,
            flow_languages=flow_languages,
            slug=cls.get_unique_slug(name),
            created_by=user,
            modified_by=user,
        )

        org.add_user(user, OrgRole.ADMINISTRATOR)
        org.initialize()
        return org

    def create_new(self, user, name: str, tz, *, as_child: bool):
        """
        Creates a new workspace copying settings from this workspace.
        """

        if as_child:
            assert Org.FEATURE_CHILD_ORGS in self.features, "only orgs with this feature enabled can create child orgs"
            assert not self.is_child, "child orgs can't create children"
        else:
            assert Org.FEATURE_NEW_ORGS in self.features, "only orgs with this feature enabled can create new orgs"

        org = Org.objects.create(
            name=name,
            timezone=tz,
            date_format=self.date_format,
            language=self.language,
            flow_languages=self.flow_languages,
            parent=self if as_child else None,
            slug=self.get_unique_slug(name),
            created_by=user,
            modified_by=user,
        )

        org.add_user(user, OrgRole.ADMINISTRATOR)
        org.initialize()
        return org

    @property
    def is_child(self) -> bool:
        return bool(self.parent_id)

    @property
    def is_verified(self):
        """
        A verified org is not subject to automatic flagging for suspicious activity
        """
        return self.config.get(Org.CONFIG_VERIFIED, False)

    @cached_property
    def branding(self):
        return self.get_brand()

    def get_brand(self):
        return settings.BRAND

    def get_brand_domain(self):
        return self.branding["domain"]

    def get_integrations(self, category: IntegrationType.Category) -> list:
        """
        Returns the connected integrations on this org of the given category
        """

        return [t for t in IntegrationType.get_all(category) if t.is_connected(self)]

    def get_limit(self, limit_type) -> int:
        return int(self.limits.get(limit_type, settings.ORG_LIMIT_DEFAULTS.get(limit_type)))

    def suspend(self):
        """
        Suspends this org and any children.
        """
        from temba.notifications.incidents.builtin import OrgSuspendedIncidentType

        assert not self.is_child

        if not self.is_suspended:
            self.is_suspended = True
            self.suspended_on = timezone.now()
            self.modified_on = timezone.now()
            self.save(update_fields=("is_suspended", "suspended_on", "modified_on"))

            self.children.filter(is_active=True).update(
                is_suspended=True, suspended_on=timezone.now(), modified_on=timezone.now()
            )

            OrgSuspendedIncidentType.get_or_create(self)  # create incident which will notify admins

    def unsuspend(self):
        """
        Unsuspends this org and any children.
        """
        from temba.notifications.incidents.builtin import OrgSuspendedIncidentType

        assert not self.is_child

        if self.is_suspended:
            self.is_suspended = False
            self.suspended_on = None
            self.modified_on = timezone.now()
            self.save(update_fields=("is_suspended", "suspended_on", "modified_on"))

            self.children.filter(is_active=True).update(
                is_suspended=False, suspended_on=None, modified_on=timezone.now()
            )

            OrgSuspendedIncidentType.get_or_create(self).end()

    def flag(self):
        """
        Flags this org for suspicious activity
        """
        from temba.notifications.incidents.builtin import OrgFlaggedIncidentType

        if not self.is_flagged:
            self.is_flagged = True
            self.save(update_fields=("is_flagged", "modified_on"))

            OrgFlaggedIncidentType.get_or_create(self)  # create incident which will notify admins

    def unflag(self):
        """
        Unflags this org if they previously were flagged
        """
        from temba.notifications.incidents.builtin import OrgFlaggedIncidentType

        if self.is_flagged:
            self.is_flagged = False
            self.save(update_fields=("is_flagged", "modified_on"))

            OrgFlaggedIncidentType.get_or_create(self).end()

    def verify(self):
        """
        Unflags org and marks as verified so it won't be flagged automatically in future
        """
        self.unflag()
        self.config[Org.CONFIG_VERIFIED] = True
        self.save(update_fields=("config", "modified_on"))

    def import_app(self, export_json, user, site=None):
        """
        Imports previously exported JSON
        """

        from temba.campaigns.models import Campaign
        from temba.contacts.models import ContactField, ContactGroup
        from temba.flows.models import Flow
        from temba.triggers.models import Trigger

        # only required field is version
        if "version" not in export_json:
            raise ValueError("Export missing version field")

        export_version = Version(str(export_json["version"]))
        export_site = export_json.get("site")

        # determine if this app is being imported from the same site
        same_site = False
        if export_site and site:
            same_site = urlparse(export_site).netloc == urlparse(site).netloc

        # do we have a supported export version?
        if not (Version(Org.EARLIEST_IMPORT_VERSION) <= export_version <= Version(Org.CURRENT_EXPORT_VERSION)):
            raise ValueError(f"Unsupported export version {export_version}")

        # do we need to migrate the export forward?
        if export_version < Version(Flow.CURRENT_SPEC_VERSION):
            export_json = Flow.migrate_export(self, export_json, same_site, export_version)

        self.clean_import(export_json)

        export_fields = export_json.get("fields", [])
        export_groups = export_json.get("groups", [])
        export_campaigns = export_json.get("campaigns", [])
        export_triggers = export_json.get("triggers", [])

        dependency_mapping = {}  # dependency UUIDs in import => new UUIDs

        with transaction.atomic():
            ContactField.import_fields(self, user, export_fields)
            ContactGroup.import_groups(self, user, export_groups, dependency_mapping)

            new_flows = Flow.import_flows(self, user, export_json, dependency_mapping, same_site)

            # these depend on flows so are imported last
            new_campaigns = Campaign.import_campaigns(self, user, export_campaigns, same_site)
            Trigger.import_triggers(self, user, export_triggers, same_site)

        # queue mailroom tasks to schedule campaign events
        for campaign in new_campaigns:
            campaign.schedule_async()

        # with all the flows and dependencies committed, we can now have mailroom do full validation
        for flow in new_flows:
            info = mailroom.get_client().flow_inspect(self, flow.get_definition(), is_import=True)
            flow.has_issues = len(info["issues"]) > 0
            flow.save(update_fields=("has_issues",))

    def clean_import(self, import_def):
        from temba.triggers.models import Trigger

        cleaned_triggers = []

        for trigger_def in import_def.get("triggers", []):
            trigger_type = trigger_def.get("trigger_type", "")

            # TODO need better way to report import results back to users
            # ignore scheduled triggers as they're missing their schedules, and removed trigger types
            if trigger_type in ("S", "I", "O"):
                continue

            Trigger.clean_import_def(trigger_def)
            cleaned_triggers.append(trigger_def)

        import_def["triggers"] = cleaned_triggers

    @classmethod
    def export_definitions(cls, site_link, components, include_fields=True, include_groups=True):
        from temba.campaigns.models import Campaign
        from temba.flows.models import Flow
        from temba.triggers.models import Trigger

        exported_flows = []
        exported_campaigns = []
        exported_triggers = []

        # users can't choose which fields/groups to export - we just include all the dependencies
        fields = set()
        groups = set()

        for component in components:
            if isinstance(component, Flow):
                component.ensure_current_version()  # only export current versions
                exported_flows.append(component.get_definition())

                if include_groups:
                    groups.update(component.group_dependencies.all())
                if include_fields:
                    fields.update(component.field_dependencies.all())

            elif isinstance(component, Campaign):
                exported_campaigns.append(component.as_export_def())

                if include_groups:
                    groups.add(component.group)
                if include_fields:
                    for event in component.events.all():
                        if not event.relative_to.is_system:
                            fields.add(event.relative_to)

            elif isinstance(component, Trigger):
                if component.type.exportable:
                    exported_triggers.append(component.as_export_def())
                    if include_groups:
                        groups.update(component.groups.all())

        return {
            "version": Org.CURRENT_EXPORT_VERSION,
            "site": site_link,
            "flows": exported_flows,
            "campaigns": exported_campaigns,
            "triggers": exported_triggers,
            "fields": [f.as_export_def() for f in sorted(fields, key=lambda f: f.key)],
            "groups": [g.as_export_def() for g in sorted(groups, key=lambda g: g.name)],
        }

    def supports_ivr(self):
        return self.get_call_channel() or self.get_answer_channel()

    def is_outbox_full(self) -> bool:
        from temba.msgs.models import MsgFolder

        return MsgFolder.OUTBOX.get_count(self) >= 1_000_000

    def get_estimated_send_time(self, msg_count):
        """
        Estimates the time it will take to send the given number of messages
        """
        channels = list(self.channels.filter(is_active=True))
        channel_counts = {}
        today = timezone.now().date()
        total_count = 0

        scopes = [f"channels/{c.id}/{s}" for c in channels for s in ("text:in", "text:out")]
        daily_totals = OrgTally.get_daily_totals(self, scopes, today - timedelta(days=30), today + timedelta(days=1))
        counts_by_channel = defaultdict(int)
        for (_day, scope), count in daily_totals.items():
            counts_by_channel[int(scope.split("/")[1])] += count

        for channel in channels:
            channel_count = counts_by_channel[channel.id]
            total_count += channel_count
            channel_counts[channel.uuid] = {"count": channel_count, "tps": channel.tps or 10}

        # balance all channels equally if we have nothing to go on
        if not total_count:
            for channel_uuid in channel_counts:
                channel_counts[channel_uuid]["count"] = 1
            total_count = len(channel_counts)

        # calculate pct of messages that will go to each channel
        for channel_uuid, channel_count in channel_counts.items():
            pct = channel_count["count"] / total_count
            channel_counts[channel_uuid]["time"] = pct * msg_count / channel_count["tps"]

        longest_time = 0
        if channel_counts:
            longest_time = max(
                [channel_count["time"] if "time" in channel_count else 0 for channel_count in channel_counts.values()]
            )

        return timedelta(seconds=longest_time)

    def get_channel(self, role: str, scheme: str):
        """
        Gets a channel for this org which supports the given role and scheme
        """

        channels = self.channels.filter(is_active=True, role__contains=role).order_by("-id")

        if scheme is not None:
            channels = channels.filter(schemes__contains=[scheme])

        return channels.first()

    def get_send_channel(self, scheme=None):
        from temba.channels.models import Channel

        return self.get_channel(Channel.ROLE_SEND, scheme=scheme)

    def get_receive_channel(self, scheme=None):
        from temba.channels.models import Channel

        return self.get_channel(Channel.ROLE_RECEIVE, scheme=scheme)

    def get_call_channel(self):
        from temba.channels.models import Channel
        from temba.contacts.models import URN

        return self.get_channel(Channel.ROLE_CALL, scheme=URN.TEL_SCHEME)

    def get_answer_channel(self):
        from temba.channels.models import Channel
        from temba.contacts.models import URN

        return self.get_channel(Channel.ROLE_ANSWER, scheme=URN.TEL_SCHEME)

    def get_schemes(self, role):
        """
        Gets all URN schemes which this org has org has channels configured for
        """
        cache_attr = "__schemes__%s" % role
        if hasattr(self, cache_attr):
            return getattr(self, cache_attr)

        schemes = set()
        for channel in self.channels.filter(is_active=True, role__contains=role):
            for scheme in channel.schemes:
                schemes.add(scheme)

        setattr(self, cache_attr, schemes)
        return schemes

    @cached_property
    def active_contacts_group(self):
        from temba.contacts.models import ContactGroup

        return self.groups.get(group_type=ContactGroup.TYPE_DB_ACTIVE)

    def get_contact_count(self) -> int:
        from temba.contacts.models import Contact

        return sum(Contact.get_status_counts(self).values())

    @cached_property
    def default_topic(self):
        return self.topics.get(is_default=True)

    @cached_property
    def default_team(self):
        return self.teams.get(is_default=True)

    def get_resthooks(self):
        """
        Returns the resthooks configured on this Org
        """
        return self.resthooks.filter(is_active=True).order_by("slug")

    @classmethod
    def get_possible_countries(cls):
        return AdminBoundary.objects.filter(level=0).order_by("name")

    @property
    def default_country_code(self) -> str:
        """
        Gets the default country as a 2-digit country code, e.g. RW, US
        """

        return self.default_country.alpha_2 if self.default_country else ""

    @cached_property
    def default_country(self):
        """
        Gets the default country as a pycountry country for this org
        """

        # first try the root location boundary field
        if self.root_location:
            if country := pycountry.countries.get(name=self.root_location.name):
                return country

        # next up try timezone
        if code := timezone_to_country_code(self.timezone):
            if country := pycountry.countries.get(alpha_2=code):
                return country

        # if that didn't work (not all timezones have a country) look for channels with countries
        codes = (
            self.channels.filter(is_active=True)
            .exclude(country=None)
            .order_by("country")
            .distinct("country")
            .values_list("country", flat=True)
        )
        if len(codes) == 1:
            if country := pycountry.countries.get(alpha_2=codes[0]):
                return country

        return None

    def set_flow_languages(self, user, codes: list):
        """
        Sets languages used in flows for this org, creating and deleting language objects as necessary
        """

        assert len(codes), "must specify at least one language"
        assert all([languages.get_name(c) for c in codes]), "not a valid or allowed language"
        assert len(set(codes)) == len(codes), "language code list contains duplicates"

        self.flow_languages = codes
        self.modified_by = user
        self.save(update_fields=("flow_languages", "modified_by", "modified_on"))

    def get_datetime_formats(self, *, seconds=False):
        date_format = Org.DATE_FORMATS_PYTHON.get(self.date_format)
        time_format = "%H:%M:%S" if seconds else "%H:%M"
        datetime_format = f"{date_format} {time_format}"
        return date_format, datetime_format

    def format_datetime(self, d, *, show_time=True, seconds=False):
        """
        Formats a datetime with or without time using this org's date format
        """
        formats = self.get_datetime_formats(seconds=seconds)
        format = formats[1] if show_time else formats[0]

        try:
            date_str = datetime_to_str(d, format, self.timezone)
        except OverflowError:
            date_str = ""
        return date_str

    def get_users(self, *, roles: list = None):
        """
        Gets users in this org, filtered by role or permission.
        """
        qs = self.users.filter(is_active=True)

        if roles is not None:
            qs = qs.filter(orgmembership__org=self, orgmembership__role_code__in=[r.code for r in roles])

        return qs

    def get_admins(self):
        """
        Convenience method for getting all org administrators, excluding system users
        """
        return self.get_users(roles=[OrgRole.ADMINISTRATOR]).exclude(is_system=True)

    def has_user(self, user: User) -> bool:
        """
        Returns whether the given user has a role in this org (only explicit roles, so doesn't include staff)
        """
        return self.users.filter(id=user.id).exists()

    def add_user(self, user: User, role: OrgRole, *, team=None, can_assign=True, can_reply_non_own=True):
        """
        Adds the given user to this org with the given role
        """

        assert role in OrgRole, f"invalid role: {role}"
        assert role == OrgRole.AGENT or not team, "only agent users can be assigned to a team"
        assert not team or team.org == self, "team must belong to this org"

        previous = OrgMembership.objects.filter(org=self, user=user).first()
        if previous:  # remove user from any existing roles
            self._remove_user(user)

        if role == OrgRole.AGENT and not team:
            team = self.default_team

        self._membership_cache[user] = OrgMembership.objects.create(
            org=self,
            user=user,
            role_code=role.code,
            team=team,
            can_assign=can_assign,
            can_reply_non_own=can_reply_non_own,
        )

        if not previous:
            audit.record("workspace.member_added", user=user, org=self, role=role.code)
        elif previous.role_code != role.code:
            audit.record(
                "workspace.member_role_changed", user=user, org=self, role=role.code, previous_role=previous.role_code
            )
        else:  # only the team or permissions changed
            audit.record(
                "workspace.member_updated",
                user=user,
                org=self,
                role=role.code,
                team=str(team.uuid) if team else None,
                can_assign=can_assign,
                can_reply_non_own=can_reply_non_own,
            )

    def remove_user(self, user: User):
        """
        Removes the given user from this org by removing them from any roles
        """
        self._remove_user(user)

        audit.record("workspace.member_removed", user=user, org=self)

    def _remove_user(self, user: User):
        self.users.remove(user)
        if user in self._membership_cache:
            del self._membership_cache[user]

    def get_owner(self) -> User:
        # look thru roles in order for the first added user
        for role in OrgRole:
            if user := self.users.filter(orgmembership__role_code=role.code).order_by("id").first():
                return user

        # default to user that created this org (converting to our User proxy model)
        return User.objects.get(id=self.created_by_id)

    def get_membership(self, user: User, *, explicit_only: bool = False):
        """
        Gets the membership of the given user in this org (if any). Members of the org's admin groups get an unsaved
        administrator membership which takes precedence over any explicit membership, unless explicit_only is set for
        places that need the actual membership record.
        """

        def get():
            # fetch the membership along with whether the user is in one of our admin groups so we can cache that too
            # without an extra query
            in_admin_group = Exists(self.admin_groups.filter(user=user))
            membership = (
                OrgMembership.objects.filter(org=self, user=user).annotate(user_in_admin_group=in_admin_group).first()
            )
            if membership:
                self._group_admin_cache[user] = membership.user_in_admin_group
            return membership

        if user not in self._membership_cache:
            self._membership_cache[user] = get()

        if not explicit_only and self.has_group_admin(user):
            return OrgMembership(org=self, user=user, role_code=OrgRole.ADMINISTRATOR.code)

        return self._membership_cache[user]

    def has_group_admin(self, user: User) -> bool:
        """
        Returns whether the given user is an administrator of this org via one of its admin groups.
        """

        if user not in self._group_admin_cache:
            self._group_admin_cache[user] = self.admin_groups.filter(user=user).exists()
        return self._group_admin_cache[user]

    def get_user_role(self, user: User):
        """
        Gets the role of the given user in this org (if any). Members of the org's admin groups always have the
        administrator role regardless of any explicit membership.
        """

        membership = self.get_membership(user)
        return membership.role if membership else None

    def create_sample_flows(self, api_url):
        # use the static finders so that a deployment's static dirs can override the samples
        filename = finders.find("examples/sample_flows.json")
        assert filename, "unable to find examples/sample_flows.json in static files"

        with open(filename, "r") as example_file:
            samples = example_file.read()

        user = self.get_admins().first()
        if user:
            # some some substitutions
            samples = samples.replace("{{EMAIL}}", user.email).replace("{{API_URL}}", api_url)

            try:
                self.import_app(json.loads(samples), user)
            except Exception as e:  # pragma: needs cover
                logger.error(
                    f"Failed creating sample flows: {str(e)}",
                    exc_info=True,
                    extra=dict(definition=json.loads(samples)),
                )

    def generate_dependency_graph(self, include_campaigns=True, include_triggers=False, include_archived=False):
        """
        Generates a dict of all exportable flows and campaigns for this org with each object's immediate dependencies
        """
        from temba.campaigns.models import Campaign, CampaignEvent
        from temba.contacts.models import ContactField, ContactGroup
        from temba.flows.models import Flow

        campaign_prefetches = (
            Prefetch(
                "events",
                queryset=CampaignEvent.objects.filter(event_type=CampaignEvent.TYPE_FLOW, is_active=True),
                to_attr="flow_events",
            ),
            "flow_events__flow",
        )

        all_flows = self.flows.filter(is_active=True).exclude(is_system=True)

        if include_campaigns:
            all_campaigns = (
                self.campaigns.filter(is_active=True).select_related("group").prefetch_related(*campaign_prefetches)
            )
        else:
            all_campaigns = Campaign.objects.none()

        if not include_archived:
            all_flows = all_flows.filter(is_archived=False)
            all_campaigns = all_campaigns.filter(is_archived=False)

        # build dependency graph for all flows and campaigns
        dependencies = defaultdict(set)
        for flow in all_flows:
            dependencies[flow] = flow.get_export_dependencies()
        for campaign in all_campaigns:
            dependencies[campaign] = set([e.flow for e in campaign.flow_events])

        # replace any dependency on a group with that group's associated campaigns - we're not actually interested
        # in flow-group-flow relationships - only relationships that go through a campaign
        campaigns_by_group = defaultdict(list)
        if include_campaigns:
            for campaign in self.campaigns.filter(is_active=True).select_related("group"):
                campaigns_by_group[campaign.group].append(campaign)

        for c, deps in dependencies.items():
            if isinstance(c, Flow):
                for d in list(deps):
                    # not interested in groups or fields for now
                    if isinstance(d, ContactField):
                        deps.remove(d)
                    if isinstance(d, ContactGroup):
                        deps.remove(d)
                        deps.update(campaigns_by_group[d])

        if include_triggers:
            all_triggers = self.triggers.filter(is_archived=False, is_active=True).select_related("flow")
            for trigger in all_triggers:
                dependencies[trigger] = {trigger.flow}

        # make dependencies symmetric, i.e. if A depends on B, B depends on A
        for c, deps in dependencies.copy().items():
            for d in deps:
                dependencies[d].add(c)

        return dependencies

    def resolve_dependencies(
        self, flows, campaigns, include_campaigns=True, include_triggers=False, include_archived=False
    ):
        """
        Given a set of flows and and a set of campaigns, returns a new set including all dependencies
        """
        dependencies = self.generate_dependency_graph(
            include_campaigns=include_campaigns, include_triggers=include_triggers, include_archived=include_archived
        )

        primary_components = set(itertools.chain(flows, campaigns))
        all_components = set()

        def add_component(c):
            if c in all_components:
                return

            all_components.add(c)
            if c in primary_components:
                primary_components.remove(c)

            for d in dependencies[c]:
                add_component(d)

        while primary_components:
            component = next(iter(primary_components))
            add_component(component)

        return all_components

    def initialize(self, sample_flows=True):
        """
        Initializes an organization, creating all the dependent objects we need for it to work properly.
        """
        from temba.contacts.models import ContactField, ContactGroup
        from temba.knowledge.models import KnowledgeSource
        from temba.tickets.models import Team, Topic

        ContactGroup.create_system_groups(self)
        ContactField.create_system_fields(self)
        Team.create_system(self)
        Topic.create_system(self)
        KnowledgeSource.create_system(
            self
        )  # both system sources; MUST be last so seeded UUIDs stay stable in test dumps

        # we should be called within a transaction, create the sample flows when its committed
        if sample_flows:
            on_transaction_commit(lambda: self.create_sample_flows(f"https://{self.get_brand_domain()}"))

    def release(self, user, *, release_users=True):
        """
        Releases this org, marking it as inactive. Actual deletion of org data won't happen until after 7 days.
        """

        if not self.is_active:  # already released, nothing to do here
            return

        # release any child orgs
        for child in self.children.all():
            child.release(user, release_users=release_users)

        audit.record("workspace.released", org=self, actor=user)

        # deactivate ourselves
        self.is_active = False
        self.modified_by = user
        self.released_on = timezone.now()
        self.save(update_fields=("is_active", "released_on", "modified_by", "modified_on"))

        # and immediately release our channels to halt messaging
        for channel in self.channels.filter(is_active=True):
            channel.release(user)

        # release any user that belongs only to us
        if release_users:
            for org_user in self.users.all():
                # check if this user has access to any other org
                other_orgs = org_user.get_orgs().exclude(id=self.id)
                if not other_orgs:
                    org_user.release(user)

        # remove all the org users
        for org_user in self.users.all():
            self.remove_user(org_user)

    def delete(self) -> dict:
        """
        Does an actual delete of this org, returning counts of what was deleted.
        """

        from temba.msgs.models import Msg

        assert not self.is_active and self.released_on, "can't delete org which hasn't been released"
        assert self.released_on < timezone.now() - timedelta(days=7), "can't delete org which was released recently"
        assert not self.deleted_on, "can't delete org twice"

        user = self.modified_by
        counts = defaultdict(int)

        delete_in_batches(self.notifications.all())
        delete_in_batches(self.incidents.all())
        delete_in_batches(self.invitations.all())
        delete_in_batches(self.flow_labels.all())

        for exp in self.exports.all():
            exp.delete()

        for imp in self.contact_imports.all():
            imp.delete()

        for label in self.msgs_labels.all():
            label.release(user)
            label.delete()

        while True:
            msg_batch = list(self.msgs.all()[:1000])
            if not msg_batch:
                break
            Msg.bulk_delete(msg_batch)
            counts["messages"] += len(msg_batch)

        # delete all our campaigns and associated events
        for c in self.campaigns.all():
            c.delete()

        # release flows (actual deletion occurs later after contacts and tickets are gone)
        # we want to manually release runs so we don't fire a mailroom task to do it
        for flow in self.flows.all():
            flow.release(user, interrupt_sessions=False)

        # delete runs and keep the count
        counts["runs"] = delete_in_batches(self.runs.all())

        # delete contact-related data
        delete_in_batches(self.http_logs.all())
        for source in self.sources.all():
            source.delete()  # batched purge of chunks, items, articles, images + their storage objects
        delete_in_batches(self.shortcuts.all())
        delete_in_batches(self.tickets.all())
        delete_in_batches(self.topics.all())
        delete_in_batches(OrgMembership.objects.filter(org=self))  # any added since release would block team deletion
        delete_in_batches(self.teams.all())
        delete_in_batches(self.airtime_transfers.all())

        # delete our contacts
        for contact in self.contacts.all():
            # release synchronously and don't deindex as that will happen for the whole org, or interrupt as we don't
            # want to fire mailroom tasks for flows we've already released
            counts_for_contact = contact.release(user, immediately=True, deindex=False, interrupt=False)
            contact.delete()

            counts.update(counts_for_contact)
            counts["contacts"] += 1

        # delete any remaining orphaned URNs
        self.urns.all().delete()

        # delete our fields
        for field in self.fields.all():
            field.delete()

        # delete our groups
        for group in self.groups.all():
            group.release(user, immediate=True)
            group.delete()

        # delete our channels
        for channel in self.channels.all():
            channel.delete()

        for glob in self.globals.all():
            glob.delete()

        for llm in self.llms.all():
            llm.delete()

        for flow in self.flows.all():
            flow.delete()

        delete_in_batches(self.webhookevent_set.all())

        for resthook in self.resthooks.all():
            resthook.release(user)
            resthook.delete()

        # release our broadcasts
        for bcast in self.broadcasts.filter(parent=None):
            bcast.delete(user, soft=False)

        Archive.delete_for_org(self)

        # delete other related objects
        delete_in_batches(self.api_tokens.all(), pk="key")
        delete_in_batches(self.schedules.all())
        delete_in_batches(self.boundaryalias_set.all())
        delete_in_batches(self.templates.all())

        # needs to come after deletion of other things as those insert new negative counts
        delete_in_batches(self.counts.all())
        delete_in_batches(self.daily_counts.all())

        delete_in_batches(self.org_tallies.all(), pk="pk")

        # now that contacts are no longer in the database, we can start de-indexing them from search
        mailroom.get_client().org_deindex(self)

        # save when we were actually deleted
        self.modified_on = timezone.now()
        self.deleted_on = timezone.now()
        self.config = {}
        self.save()

        return counts

    def __repr__(self):
        return f'<Org: id={self.id} name="{self.name}">'

    def __str__(self):
        return self.name

    class Meta:
        constraints = [
            # suspended_on must be set if and only if org is suspended
            models.CheckConstraint(
                condition=Q(is_suspended=True, suspended_on__isnull=False)
                | Q(is_suspended=False, suspended_on__isnull=True),
                name="orgs_org_suspended_on_consistent",
            )
        ]


class OrgMembership(models.Model):
    org = models.ForeignKey(Org, on_delete=models.CASCADE)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    role_code = models.CharField(max_length=1)
    team = models.ForeignKey("tickets.Team", on_delete=models.PROTECT, null=True)
    can_assign = models.BooleanField(default=True)
    can_reply_non_own = models.BooleanField(default=True)
    last_seen_on = models.DateTimeField(null=True)

    @property
    def role(self):
        return OrgRole.from_code(self.role_code)

    def record_seen(self):
        r = get_valkey_connection()
        r.sadd("org_members_seen", self.id)

    @classmethod
    def get_seen(self) -> list:
        r = get_valkey_connection()
        return [k.decode() for k in r.spop("org_members_seen", r.scard("org_members_seen"))]

    class Meta:
        unique_together = (("org", "user"),)


def get_import_upload_path(instance: Any, filename: str):
    assert instance.org_id and instance.uuid

    ext = Path(filename).suffix.lower()
    return f"orgs/{instance.org_id}/org_imports/{instance.uuid}{ext}"


class OrgImport(CreatedByMixin):
    STATUS_PENDING = "P"
    STATUS_PROCESSING = "O"
    STATUS_COMPLETE = "C"
    STATUS_FAILED = "F"
    STATUS_CHOICES = (
        (STATUS_PENDING, "Pending"),
        (STATUS_PROCESSING, "Processing"),
        (STATUS_COMPLETE, "Complete"),
        (STATUS_FAILED, "Failed"),
    )

    uuid = models.UUIDField(unique=True, default=uuid4)
    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="imports")
    file = models.FileField(upload_to=get_import_upload_path)
    status = models.CharField(max_length=1, default=STATUS_PENDING, choices=STATUS_CHOICES)
    modified_on = models.DateTimeField(default=timezone.now, editable=False)  # when the import finished

    def start(self):
        from .tasks import perform_import

        on_transaction_commit(lambda: perform_import.delay(self.id))

    def perform(self):
        assert self.status == self.STATUS_PENDING, "trying to start an already started import"

        # mark us as processing to prevent double starting
        self.status = self.STATUS_PROCESSING
        self.save(update_fields=("status",))
        try:
            org = self.org
            link = f"https://{org.get_brand_domain()}"
            data = json.loads(force_str(self.file.read()))
            org.import_app(data, self.created_by, link)
        except Exception as e:
            self.status = self.STATUS_FAILED
            self.modified_on = timezone.now()
            self.save(update_fields=("status", "modified_on"))

            # this is an unexpected error, report it to sentry
            logger = logging.getLogger(__name__)
            logger.error("Exception on app import: %s" % str(e), exc_info=True)

        else:
            self.status = self.STATUS_COMPLETE
            self.modified_on = timezone.now()
            self.save(update_fields=("status", "modified_on"))


class Invitation(CreatedByMixin, ModifiedByMixin, SoftDeleteMixin):
    """
    An invitation to an e-mail address to join an org as a specific role.
    """

    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="invitations")
    email = models.EmailField()
    secret = models.CharField(max_length=64, unique=True)
    role_code = models.CharField(max_length=1, choices=OrgRole.choices(), default=OrgRole.EDITOR.code)
    team = models.ForeignKey("tickets.Team", on_delete=models.PROTECT, null=True, related_name="invitations")

    @classmethod
    def create(cls, org, user, email: str, role: OrgRole, *, team=None):
        assert not team or org == team.org

        invitation = cls.objects.create(
            org=org,
            email=User.objects.normalize_email(email),
            role_code=role.code,
            team=team,
            created_by=user,
            modified_by=user,
        )

        audit.record("workspace.invitation_created", org=org, email=invitation.email, role=role.code)
        return invitation

    def save(self, *args, **kwargs):
        if not self.secret:
            self.secret = generate_secret(64)

        return super().save(*args, **kwargs)

    @property
    def role(self):
        return OrgRole.from_code(self.role_code)

    def send(self):
        sender = EmailSender.from_email_type(self.org.branding, "notifications")
        sender.send(
            [self.email],
            "orgs/email/invitation_email",
            {
                "org": self.org,
                "invitation": self,
            },
            _("[%(name)s] Invitation to join workspace") % {"name": self.org.name},
        )

    def accept(self, user):
        from temba.notifications.types.builtin import InvitationAcceptedNotificationType

        self.org.add_user(user, self.role, team=self.team)

        InvitationAcceptedNotificationType.create(self, user)

        self.release()

    def release(self, user=None):
        self.is_active = False
        self.modified_on = timezone.now()
        self.modified_by = user or self.modified_by
        self.save(update_fields=("is_active", "modified_by", "modified_on"))


class ExportType:
    slug: str
    name: str
    download_prefix: str
    download_template = "orgs/export_download.html"

    @classmethod
    def has_recent_unfinished(cls, org) -> bool:
        """
        Checks for unfinished exports created in the last 4 hours for this org
        """

        day_ago = timezone.now() - timedelta(hours=4)

        return Export.get_unfinished(org, cls.slug).filter(created_on__gt=day_ago).order_by("created_on").exists()

    def write(self, export) -> tuple:  # pragma: no cover
        """
        Should return tuple of 1) temporary file handle, 2) file extension, 3) count of items exported
        """
        pass

    def get_download_context(self, export) -> dict:  # pragma: no cover
        return {}


class DefinitionExport(ExportType):
    """
    Export of definitions
    """

    slug = "definition"
    name = _("Definitions")
    download_prefix = "orgs_export"
    download_template = "orgs/definitions_download.html"

    @classmethod
    def create(cls, org, user, flows=[], campaigns=[]):
        export = Export.objects.create(
            org=org,
            export_type=cls.slug,
            config={
                "flow_ids": [f.id for f in flows],
                "campigns_ids": [c.id for c in campaigns],
            },
            created_by=user,
        )
        return export

    def get_flows(self, export):
        flow_ids = export.config.get("flow_ids")

        return export.org.flows.filter(id__in=flow_ids, is_active=True)

    def get_campaigns(self, export):
        campigns_ids = export.config.get("campigns_ids")

        return export.org.campaigns.filter(id__in=campigns_ids, is_active=True)

    def write(self, export) -> tuple:
        org = export.org
        flows = self.get_flows(export)
        campaigns = self.get_campaigns(export)

        components = set(itertools.chain(flows, campaigns))

        # add triggers for the selected flows
        for flow in flows:
            components.update(flow.triggers.filter(is_active=True, is_archived=False))

        export_defs = org.export_definitions(f"https://{org.get_brand_domain()}", components)

        temp_file = NamedTemporaryFile(delete=False, suffix=".json", mode="w+", encoding="utf8")
        json.json.dump(export_defs, temp_file)
        temp_file.flush()

        return temp_file, "json", len(components)

    def get_download_context(self, export) -> dict:
        flows = self.get_flows(export)
        campaigns = self.get_campaigns(export)
        return {
            "campaigns": [dict(uuid=c.uuid, name=c.name) for c in campaigns],
            "flows": [dict(uuid=f.uuid, name=f.name) for f in flows],
        }


class Export(UUIDMixin, CreatedByMixin):
    """
    An export of workspace data initiated by a user
    """

    STATUS_PENDING = "P"
    STATUS_PROCESSING = "O"
    STATUS_COMPLETE = "C"
    STATUS_FAILED = "F"
    STATUS_CHOICES = (
        (STATUS_PENDING, _("Pending")),
        (STATUS_PROCESSING, _("Processing")),
        (STATUS_COMPLETE, _("Complete")),
        (STATUS_FAILED, _("Failed")),
    )

    # log progress after this number of exported objects have been exported
    LOG_PROGRESS_PER_ROWS = 10000

    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="exports")
    export_type = models.CharField(max_length=20)
    status = models.CharField(max_length=1, default=STATUS_PENDING, choices=STATUS_CHOICES)
    num_records = models.IntegerField(null=True)
    path = models.CharField(null=True, max_length=2048)

    # date range (optional depending on type)
    start_date = models.DateField(null=True)
    end_date = models.DateField(null=True)

    # additional type specific filtering and extra columns
    config = models.JSONField(default=dict)

    modified_on = models.DateTimeField(default=timezone.now)

    def start(self):
        from .tasks import perform_export

        audit.record("export.started", user=self.created_by, org=self.org, export=str(self.uuid), type=self.export_type)

        perform_export.delay(self.id)

    def perform(self):
        from temba.notifications.types.builtin import ExportFinishedNotificationType

        assert self.status != self.STATUS_PROCESSING, "can't start an export that's already processing"

        self.status = self.STATUS_PROCESSING
        self.save(update_fields=("status", "modified_on"))

        try:
            temp_file, extension, num_records = self.type.write(self)

            # save file to storage
            path = f"orgs/{self.org.id}/{self.type.slug}_exports/{self.uuid}.{extension}"
            default_storage.save(path, File(temp_file))

            # remove temporary file
            if hasattr(temp_file, "delete"):
                if temp_file.delete is False:  # pragma: no cover
                    os.unlink(temp_file.name)
            else:  # pragma: no cover
                os.unlink(temp_file.name)

        except Exception as e:  # pragma: no cover
            self.status = self.STATUS_FAILED
            self.save(update_fields=("status", "modified_on"))
            raise e
        else:
            self.status = self.STATUS_COMPLETE
            self.num_records = num_records
            self.path = path
            self.save(update_fields=("status", "num_records", "path", "modified_on"))

            ExportFinishedNotificationType.create(self)

    @classmethod
    def get_unfinished(cls, org, export_type: str):
        """
        Returns all unfinished exports
        """
        return cls.objects.filter(
            org=org, export_type=export_type, status__in=(cls.STATUS_PENDING, cls.STATUS_PROCESSING)
        )

    def get_date_range(self) -> tuple:
        """
        Gets the since > until datetimes of items to export.
        """
        tz = self.org.timezone
        start_date = max(datetime.combine(self.start_date, datetime.min.time()).replace(tzinfo=tz), self.org.created_on)
        end_date = datetime.combine(self.end_date, datetime.max.time()).replace(tzinfo=tz)
        return start_date, end_date

    def get_contact_fields(self):
        ids = self.config.get("with_fields", [])
        id_by_order = {id: i for i, id in enumerate(ids)}
        return sorted(self.org.fields.filter(id__in=ids), key=lambda o: id_by_order[o.id])

    def get_contact_groups(self):
        ids = self.config.get("with_groups", [])
        id_by_order = {id: i for i, id in enumerate(ids)}
        return sorted(self.org.groups.filter(id__in=ids), key=lambda o: id_by_order[o.id])

    def get_contact_headers(self) -> list:
        """
        Gets the header values common to exports with contacts.
        """
        cols = ["Contact UUID", "Contact Name", "URN Scheme"]
        if self.org.is_anon:
            cols.append("Anon Value")
        else:
            cols.append("URN Value")

        for cf in self.get_contact_fields():
            cols.append("Field:%s" % cf.name)

        for cg in self.get_contact_groups():
            cols.append("Group:%s" % cg.name)

        return cols

    def get_contact_columns(self, contact, urn: str = "") -> list:
        """
        Gets the column values for the given contact.
        """
        from temba.contacts.models import URN

        if urn == "":
            urn_obj = contact.get_urn()
            urn_scheme, urn_path = (urn_obj.scheme, urn_obj.path) if urn_obj else (None, None)
        elif urn is not None:  # pragma: no cover
            urn_scheme = URN.to_parts(urn)[0]
            urn_path = URN.format(urn, international=False, formatted=False)
        else:
            urn_scheme, urn_path = None, None  # pragma: no cover

        cols = [str(contact.uuid), contact.name, urn_scheme]
        if self.org.is_anon:
            cols.append(contact.ref)
        else:
            cols.append(urn_path)

        for cf in self.get_contact_fields():
            cols.append(contact.get_field_display(cf))

        memberships = set(contact.groups.all())

        for cg in self.get_contact_groups():
            cols.append(cg in memberships)

        return cols

    @classmethod
    def _get_types(cls) -> dict:
        return {t.slug: t() for t in ExportType.__subclasses__()}

    @property
    def type(self):
        return self._get_types()[self.export_type]

    def get_raw_url(self) -> tuple[str]:
        """
        Gets the raw storage URL
        """

        filename = self._get_download_filename()
        url = default_storage.url(
            self.path,
            parameters=dict(ResponseContentDisposition=f"attachment;filename={filename}"),
            http_method="GET",
        )

        return url

    def _get_download_filename(self):
        """
        Create a more user friendly filename for download
        """
        _, extension = self.path.rsplit(".", 1)
        date_str = datetime.today().strftime(r"%Y%m%d")
        return f"{self.type.download_prefix}_{date_str}.{extension}"

    @property
    def notification_export_type(self):
        return self.type.slug

    def get_notification_scope(self) -> str:
        return f"{self.notification_export_type}:{self.id}"

    def delete(self):
        self.notifications.all().delete()

        if self.path:
            default_storage.delete(self.path)

        super().delete()

    def __repr__(self):  # pragma: no cover
        return f'<Export: id={self.id} type="{self.export_type}">'


class ItemCount(BaseScopedCount):
    """
    Org-level counts of things.
    """

    squash_over = ("org_id", "scope")

    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="counts", db_index=False)  # indexed below

    class Meta:
        indexes = [
            models.Index("org", OpClass("scope", name="varchar_pattern_ops"), name="orgcount_org_scope"),
            # for squashing task
            models.Index(name="orgcount_unsquashed", fields=("org", "scope"), condition=Q(is_squashed=False)),
        ]
        constraints = [
            models.UniqueConstraint(name="orgcount_squashed", fields=("org", "scope"), condition=Q(is_squashed=True))
        ]


class DailyCount(BaseDailyCount):
    """
    Org-level daily counts of things.
    """

    squash_over = ("org_id", "day", "scope")

    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="daily_counts", db_index=False)  # indexed below

    class Meta:
        indexes = [
            models.Index("org", "day", OpClass("scope", name="varchar_pattern_ops"), name="orgdailycount_org_scope"),
            # for squashing task
            models.Index(
                name="orgdailycount_unsquashed", fields=("org", "day", "scope"), condition=Q(is_squashed=False)
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                name="orgdailycount_squashed", fields=("org", "day", "scope"), condition=Q(is_squashed=True)
            )
        ]


class BaseTally(models.Model):
    """
    Base for totals keyed by an owner and a scope. Writers increment a global hash in Valkey which mailroom flushes into
    these rows in batches, so a total is the sum of both. Key layout, and how to read both consistently, must match
    gocommon's tallies package. Mailroom drops rows whose total reaches zero, so a missing row means zero.

    Daily totals end their scope with @ and the date, e.g. "emails/shared@2026-11-02", and may be given an expiry by
    mailroom when first flushed. Rows without one are kept forever.

    Scopes use the C collation so that the primary key can serve exact, prefix and range lookups with plain operators.
    """

    KEY_BASE = "tallies"
    LIVE_KEY = "{tallies}:live"
    FLUSHING_KEY = "{tallies}:flushing"
    BATCH_KEY = "{tallies}:batch"
    BATCH_ID_KEY = "{tallies}:batch_id"

    READ_ATTEMPTS = 3

    owner_field: str  # the foreign key leading the primary key
    field_prefix: str  # prefixes the owner id in Valkey hash fields

    scope = models.CharField(max_length=255, db_collation="C")
    count = models.BigIntegerField()
    expires_on = models.DateField(null=True)

    @classmethod
    def _get_totals(cls, owner_ids: list[int], scopes: list[str]) -> dict[tuple[int, str], int]:
        owner_ids = list(dict.fromkeys(owner_ids))
        scopes = list(dict.fromkeys(scopes))
        if not owner_ids or not scopes:
            return {}

        for _attempt in range(cls.READ_ATTEMPTS):
            totals, consistent = cls._read_totals(owner_ids, scopes)
            if consistent:
                return totals

        logger.warning(
            "tally totals may be overcounted after retries",
            extra={"table": cls._meta.db_table, "owner_ids": owner_ids, "scopes": scopes},
        )
        return totals

    @classmethod
    def _read_totals(cls, owner_ids: list[int], scopes: list[str]) -> tuple[dict[tuple[int, str], int], bool]:
        """
        Reads totals from Valkey and then the database, returning them and whether they're consistent, which they aren't
        if a batch was flushed in between, as it may have moved counts we read from Valkey into the rows we read.
        """
        keys = [(owner_id, scope) for owner_id in owner_ids for scope in scopes]
        fields = [f"{cls.field_prefix}{owner_id}|{scope}" for owner_id, scope in keys]

        r = get_valkey_connection()
        with r.pipeline(transaction=True) as pipe:
            for key in (cls.LIVE_KEY, cls.FLUSHING_KEY, cls.BATCH_KEY):
                pipe.hmget(key, fields)
            pipe.exists(cls.BATCH_KEY)
            pipe.get(cls.BATCH_ID_KEY)
            live, flushing, batch, batch_exists, batch_id = pipe.execute()

        # one statement so that the counts and the last batch come from the same snapshot
        owner_col = f"{cls.owner_field}_id"
        with connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT f.last_batch, t.{owner_col}, t.scope, t.count
                  FROM (SELECT (SELECT last_batch FROM orgs_tallyflush WHERE name = %s) AS last_batch) f
             LEFT JOIN {cls._meta.db_table} t ON t.{owner_col} = ANY(%s) AND t.scope = ANY(%s)
                """,
                (cls.KEY_BASE, owner_ids, scopes),
            )
            rows = cursor.fetchall()

        last_batch = rows[0][0] or 0
        batch_id = int(batch_id or 0)
        include_batch = bool(batch_exists) and last_batch < batch_id
        consistent = last_batch <= batch_id

        totals = defaultdict(int)
        for _last_batch, owner_id, scope, count in rows:
            if scope is not None:
                totals[(owner_id, scope)] += count

        for values in (live, flushing, batch if include_batch else []):
            for key, count in zip(keys, values):
                if count is not None:
                    totals[key] += int(count)

        # totals which can go down may be buffered back to zero
        return {k: v for k, v in totals.items() if v != 0}, consistent

    class Meta:
        abstract = True


class OrgTally(BaseTally):
    """
    Org-level totals of things which only go up.
    """

    owner_field = "org"
    field_prefix = ""

    pk = models.CompositePrimaryKey("org", "scope")
    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="org_tallies", db_index=False)  # leads the key

    @classmethod
    def get_totals(cls, org, scopes: list[str]) -> dict[str, int]:
        """
        Gets totals by scope for the given scopes, omitting those with no total.
        """
        return {scope: count for (_, scope), count in cls.get_totals_by_org([org], scopes).items()}

    @classmethod
    def get_totals_by_org(cls, orgs, scopes: list[str]) -> dict[tuple[int, str], int]:
        """
        Gets totals by org id and scope for the given scopes in each of the given orgs, omitting those with no total.
        """
        return cls._get_totals([o.id for o in orgs], scopes)

    @classmethod
    def get_daily_totals(cls, org, scopes: list[str], since: date, until: date) -> dict[tuple[date, str], int]:
        """
        Gets totals by day and scope for the given undated scopes over days from since up to until, omitting those with
        no total.
        """
        totals = cls.get_daily_totals_by_org([org], scopes, since, until)
        return {(day, scope): count for (_, day, scope), count in totals.items()}

    @classmethod
    def get_daily_totals_by_org(
        cls, orgs, scopes: list[str], since: date, until: date
    ) -> dict[tuple[int, date, str], int]:
        """
        Gets totals by org id, day and scope for the given undated scopes in each of the given orgs over days from since
        up to until, omitting those with no total. Only today's are read from Valkey too, as earlier days have been
        flushed.
        """
        org_ids = list(dict.fromkeys(o.id for o in orgs))
        scopes = list(dict.fromkeys(scopes))
        if not org_ids or not scopes:
            return {}

        today = timezone.now().date()
        totals = {}

        # each scope's dated rows are a range of the primary key, as dates are fixed width
        if since < (before := min(until, today)):
            conds = " OR ".join(["(scope >= %s AND scope < %s)"] * len(scopes))
            bounds = [f"{s}@{d.isoformat()}" for s in scopes for d in (since, before)]

            with connection.cursor() as cursor:
                cursor.execute(
                    f"SELECT org_id, scope, count FROM orgs_orgtally WHERE org_id = ANY(%s) AND ({conds})",
                    [org_ids, *bounds],
                )

                for org_id, scope, count in cursor.fetchall():
                    undated, day = scope.rsplit("@", 1)
                    totals[(org_id, date.fromisoformat(day), undated)] = count

        if since <= today < until:
            suffix = f"@{today.isoformat()}"
            for (org_id, scope), count in cls.get_totals_by_org(orgs, [s + suffix for s in scopes]).items():
                totals[(org_id, today, scope.removesuffix(suffix))] = count

        return totals

    class Meta:
        indexes = [
            # for trimming
            models.Index(name="orgorgtally_expires_on", fields=("expires_on",), condition=Q(expires_on__isnull=False))
        ]


class TallyFlush(models.Model):
    """
    The last batch of tallies committed by mailroom's flush, by key base. Mailroom updates it in the same transaction as
    the counts so that flushes are exactly-once, and readers use it to tell whether a batch in Valkey is already here.
    """

    name = models.CharField(max_length=64, primary_key=True)
    last_batch = models.BigIntegerField()
