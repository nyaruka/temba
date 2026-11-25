import itertools
import logging
from array import array
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone as tzone
from uuid import UUID

import iso8601
from dateutil.relativedelta import relativedelta
from django_valkey import get_valkey_connection
from packaging.version import Version

from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.contrib.postgres.indexes import OpClass
from django.db import models, transaction
from django.db.models import Prefetch, Q, Sum
from django.db.models.functions import Lower
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from temba import mailroom
from temba.ai.models import LLM
from temba.channels.models import Channel
from temba.contacts.models import Contact, ContactField, ContactGroup
from temba.globals.models import Global
from temba.msgs.models import Label, OptIn
from temba.orgs.models import DependencyMixin, Export, ExportType, Org
from temba.templates.models import Template
from temba.tickets.models import Topic
from temba.users.models import User
from temba.utils.export.models import MultiSheetExporter
from temba.utils.models import JSONAsTextField, LegacyUUIDMixin, TembaModel, delete_in_batches
from temba.utils.models.counts import BaseScopedCount, BaseSquashableCount
from temba.utils.uuid import uuid4

from . import legacy
from .changes import compute_changes

logger = logging.getLogger(__name__)


class FlowException(Exception):
    pass


class FlowUserConflictException(FlowException):
    def __init__(self, other_user, last_saved_on):
        self.other_user = other_user
        self.last_saved_on = last_saved_on


class FlowVersionConflictException(FlowException):
    def __init__(self, rejected_version):
        self.rejected_version = rejected_version


FLOW_LOCK_TTL = 60  # 1 minute
FLOW_LOCK_KEY = "org:%d:lock:flow:%d:definition"


class Flow(LegacyUUIDMixin, TembaModel, DependencyMixin):
    # items in the flow definition JSON
    DEFINITION_UUID = "uuid"
    DEFINITION_NAME = "name"
    DEFINITION_SPEC_VERSION = "spec_version"
    DEFINITION_TYPE = "type"
    DEFINITION_LANGUAGE = "language"
    DEFINITION_REVISION = "revision"
    DEFINITION_EXPIRE_AFTER_MINUTES = "expire_after_minutes"
    DEFINITION_METADATA = "metadata"
    DEFINITION_NODES = "nodes"
    DEFINITION_UI = "_ui"

    TYPE_MESSAGE = "M"
    TYPE_BACKGROUND = "B"
    TYPE_SURVEY = "S"
    TYPE_VOICE = "V"
    TYPE_USSD = "U"

    TYPE_CHOICES = (
        (TYPE_MESSAGE, _("Messaging")),
        (TYPE_VOICE, _("Phone Call")),
        (TYPE_BACKGROUND, _("Background")),
        (TYPE_SURVEY, _("Surveyor")),
    )

    GOFLOW_TYPES = {
        TYPE_MESSAGE: "messaging",
        TYPE_BACKGROUND: "messaging_background",
        TYPE_SURVEY: "messaging_offline",
        TYPE_VOICE: "voice",
    }
    TYPE_ICONS = {
        TYPE_MESSAGE: "flow_message",
        TYPE_VOICE: "flow_ivr",
        TYPE_BACKGROUND: "flow_background",
        TYPE_SURVEY: "flow_surveyor",
    }

    FINAL_LEGACY_VERSION = legacy.VERSIONS[-1]
    INITIAL_GOFLOW_VERSION = "13.0.0"  # initial version of flow spec to use new engine
    CURRENT_SPEC_VERSION = "14.4.1"  # current flow spec version

    EXPIRES_CHOICES = {
        TYPE_MESSAGE: (
            (5, _("After 5 minutes")),
            (10, _("After 10 minutes")),
            (15, _("After 15 minutes")),
            (30, _("After 30 minutes")),
            (60, _("After 1 hour")),
            (60 * 3, _("After 3 hours")),
            (60 * 6, _("After 6 hours")),
            (60 * 12, _("After 12 hours")),
            (60 * 18, _("After 18 hours")),
            (60 * 24, _("After 1 day")),
            (60 * 24 * 2, _("After 2 days")),
            (60 * 24 * 3, _("After 3 days")),
            (60 * 24 * 7, _("After 1 week")),
            (60 * 24 * 14, _("After 2 weeks")),
        ),
        TYPE_VOICE: (
            (1, _("After 1 minute")),
            (2, _("After 2 minutes")),
            (3, _("After 3 minutes")),
            (4, _("After 4 minutes")),
            (5, _("After 5 minutes")),
            (10, _("After 10 minutes")),
            (15, _("After 15 minutes")),
        ),
    }
    EXPIRES_DEFAULTS = {
        TYPE_MESSAGE: 60 * 24 * 3,  # 3 days
        TYPE_VOICE: 5,  # 5 minutes
        TYPE_BACKGROUND: 0,
        TYPE_SURVEY: 0,
    }

    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="flows")
    labels = models.ManyToManyField("FlowLabel", related_name="flows")
    is_archived = models.BooleanField(default=False)
    flow_type = models.CharField(max_length=1, choices=TYPE_CHOICES, default=TYPE_MESSAGE)
    ignore_triggers = models.BooleanField(default=False, help_text=_("Ignore keyword triggers while in this flow."))
    ivr_retry = models.IntegerField(null=True)

    # properties set from last revision
    expires_after_minutes = models.IntegerField(
        default=EXPIRES_DEFAULTS[TYPE_MESSAGE],
        help_text=_("Minutes of inactivity that will cause expiration from flow."),
    )
    base_language = models.CharField(
        max_length=3,  # ISO-639-3
        help_text=_("The authoring language, additional languages can be added later."),
        default="und",
    )
    version_number = models.CharField(default="0.0.0", max_length=8)  # no actual spec version until there's a revision

    # information from flow inspection
    info = models.JSONField(null=True, default=dict)
    has_issues = models.BooleanField(default=False)

    saved_on = models.DateTimeField(auto_now_add=True)
    saved_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="flow_saves")

    # dependencies on other assets
    channel_dependencies = models.ManyToManyField(Channel, related_name="dependent_flows")
    field_dependencies = models.ManyToManyField(ContactField, related_name="dependent_flows")
    flow_dependencies = models.ManyToManyField("Flow", related_name="dependent_flows")
    global_dependencies = models.ManyToManyField(Global, related_name="dependent_flows")
    group_dependencies = models.ManyToManyField(ContactGroup, related_name="dependent_flows")
    label_dependencies = models.ManyToManyField(Label, related_name="dependent_flows")
    llm_dependencies = models.ManyToManyField(LLM, related_name="dependent_flows")
    optin_dependencies = models.ManyToManyField(OptIn, related_name="dependent_flows")
    template_dependencies = models.ManyToManyField(Template, related_name="dependent_flows")
    topic_dependencies = models.ManyToManyField(Topic, related_name="dependent_flows")
    user_dependencies = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name="dependent_flows")

    soft_dependent_types = {"flow", "campaign_event", "trigger"}  # it's all soft for flows

    @classmethod
    def create(
        cls,
        org,
        user,
        name,
        flow_type=TYPE_MESSAGE,
        expires_after_minutes=0,
        base_language="eng",
        create_revision=False,
        **kwargs,
    ):
        assert cls.is_valid_name(name), f"'{name}' is not a valid flow name"
        assert not expires_after_minutes or cls.is_valid_expires(flow_type, expires_after_minutes)

        flow = cls.objects.create(
            org=org,
            name=name,
            flow_type=flow_type,
            expires_after_minutes=expires_after_minutes or cls.EXPIRES_DEFAULTS[flow_type],
            saved_by=user,
            created_by=user,
            modified_by=user,
            version_number=Flow.CURRENT_SPEC_VERSION,
            **kwargs,
        )

        if create_revision:
            flow.save_revision(
                user,
                {
                    Flow.DEFINITION_NAME: flow.name,
                    Flow.DEFINITION_UUID: flow.uuid,
                    Flow.DEFINITION_SPEC_VERSION: Flow.CURRENT_SPEC_VERSION,
                    Flow.DEFINITION_LANGUAGE: base_language,
                    Flow.DEFINITION_TYPE: Flow.GOFLOW_TYPES[flow_type],
                    Flow.DEFINITION_NODES: [],
                    Flow.DEFINITION_UI: {},
                },
            )

        return flow

    @classmethod
    def import_flows(cls, org, user, export_json, dependency_mapping, same_site=False):
        """
        Import flows from our flow export file
        """

        created_flows = []
        db_types = {value: key for key, value in Flow.GOFLOW_TYPES.items()}

        # fetch or create all the flow db objects
        for flow_def in export_json["flows"]:
            flow_version = Version(flow_def[Flow.DEFINITION_SPEC_VERSION])
            flow_type = db_types[flow_def[Flow.DEFINITION_TYPE]]
            flow_uuid = flow_def[Flow.DEFINITION_UUID]
            flow_name = flow_def[Flow.DEFINITION_NAME]
            flow_expires = flow_def.get(Flow.DEFINITION_EXPIRE_AFTER_MINUTES, 0)

            flow = None
            flow_name = cls.clean_name(flow_name)

            # ensure expires is valid for the flow type
            if not cls.is_valid_expires(flow_type, flow_expires):
                flow_expires = cls.EXPIRES_DEFAULTS[flow_type]

            # check if we can find that flow by UUID first
            if same_site:
                flow = org.flows.filter(is_active=True, uuid=flow_uuid).first()

            # if it's not of our world, let's try by name and type
            if not flow:
                flow = org.flows.filter(is_active=True, name__iexact=flow_name, flow_type=flow_type).first()

            if flow:
                flow.name = Flow.get_unique_name(org, flow_name, ignore=flow)
                flow.version_number = str(flow_version)
                flow.expires_after_minutes = flow_expires
                flow.save(update_fields=("name", "expires_after_minutes"))
            else:
                flow = Flow.create(
                    org,
                    user,
                    Flow.get_unique_name(org, flow_name),
                    flow_type=flow_type,
                    expires_after_minutes=flow_expires,
                )

            # make sure the flow is unarchived
            if flow.is_archived:
                flow.restore(user)

            dependency_mapping[flow_uuid] = str(flow.uuid)
            created_flows.append((flow, flow_def))

        # import each definition (includes re-mapping dependency references)
        for flow, definition in created_flows:
            flow.import_definition(user, definition, dependency_mapping)

        # remap flow UUIDs in any campaign events
        for campaign in export_json.get("campaigns", []):
            for event in campaign["events"]:
                if "flow" in event:
                    flow_uuid = event["flow"]["uuid"]
                    if flow_uuid in dependency_mapping:
                        event["flow"]["uuid"] = dependency_mapping[flow_uuid]

        # remap flow UUIDs in any triggers
        for trigger in export_json.get("triggers", []):
            if "flow" in trigger:
                flow_uuid = trigger["flow"]["uuid"]
                if flow_uuid in dependency_mapping:
                    trigger["flow"]["uuid"] = dependency_mapping[flow_uuid]

        # return the created flows
        return [f[0] for f in created_flows]

    @classmethod
    def is_valid_expires(cls, flow_type: str, expires: int) -> bool:
        valid_expires = {c[0] for c in cls.EXPIRES_CHOICES.get(flow_type, ())}
        return not valid_expires or expires in valid_expires

    def clone(self, user):
        """
        Returns a clone of this flow
        """
        name = self.get_unique_name(self.org, f"Copy of {self.name}"[: self.MAX_NAME_LEN].strip())
        copy = Flow.create(
            self.org,
            user,
            name,
            flow_type=self.flow_type,
            expires_after_minutes=self.expires_after_minutes,
            base_language=self.base_language,
        )

        # import the original's definition into the copy
        flow_json = self.get_definition()
        copy.import_definition(user, flow_json, {})
        return copy

    @classmethod
    def export_translation(cls, org, flows, language):
        return mailroom.get_client().po_export(org, flows, language=language)

    @classmethod
    def import_translation(cls, org, flows, language, po_data):
        response = mailroom.get_client().po_import(org, flows, language=language, po_data=po_data)
        return {d["uuid"]: d for d in response["flows"]}

    @classmethod
    def apply_action_label(cls, user, flows, label):
        label.toggle_label(flows, add=True)

    @classmethod
    def apply_action_unlabel(cls, user, flows, label):
        label.toggle_label(flows, add=False)

    @classmethod
    def apply_action_archive(cls, user, flows):
        from temba.campaigns.models import CampaignEvent

        # single query to get IDs of all flows used by active campaigns
        campaign_flow_ids = set(
            CampaignEvent.objects.filter(is_active=True, flow__in=flows, campaign__is_archived=False).values_list(
                "flow_id", flat=True
            )
        )

        non_campaign_flows = [f for f in flows if f.id not in campaign_flow_ids]

        # single prefetch for run counts
        cls.prefetch_run_counts(non_campaign_flows)

        for flow in non_campaign_flows:
            counts = flow.get_run_counts()
            if counts[FlowRun.STATUS_ACTIVE] + counts[FlowRun.STATUS_WAITING] > 0:
                continue

            flow.archive(user)

    @classmethod
    def apply_action_restore(cls, user, flows):
        for flow in flows:
            try:
                flow.restore(user)
            except FlowException:  # pragma: no cover
                pass

    def get_attrs(self):
        return {"icon": self.TYPE_ICONS.get(self.flow_type, "flow"), "type": self.flow_type, "uuid": self.uuid}

    def get_category_counts(self, result_key=None):
        # get the possible results from the flow metadata
        results_by_key = {r["key"]: r for r in self.info["results"]}

        # if we have a specific result_key, filter to just that result
        if result_key:
            results_by_key = {result_key: results_by_key[result_key]} if result_key in results_by_key else {}

        counts = (
            self.result_counts.filter(result__in=results_by_key)
            .values("result", "category")
            .annotate(total=Sum("count"))
        )

        # organize into dict of results keys to dicts of category names to counts
        counts_by_key = defaultdict(dict)
        for count in counts:
            counts_by_key[count["result"]][count["category"]] = count["total"]

        results = []
        for result_key, result in results_by_key.items():
            category_counts = counts_by_key.get(result_key, {})

            if not category_counts or (len(category_counts) == 1 and "All Responses" in category_counts):
                continue

            result_total = sum(category_counts.values())
            result_categories = []
            for cat_name, cat_count in category_counts.items():
                result_categories.append(
                    {
                        "name": cat_name,
                        "count": cat_count,
                        "pct": (float(cat_count) / float(result_total)) if result_total else 0,
                    }
                )

            result_summary = {
                "key": result_key,
                "name": result["name"],
                "categories": sorted(result_categories, key=lambda c: c["name"]),
                "total": result_total,
            }

            results.append(result_summary)

        return results

    def lock(self):
        """
        Locks on this flow to let us make changes to the definition in a thread safe way
        """
        r = get_valkey_connection()
        lock_key = FLOW_LOCK_KEY % (self.org_id, self.id)
        return r.lock(lock_key, FLOW_LOCK_TTL)

    def get_activity(self) -> tuple:
        """
        Get the activity summary for a flow as a tuple of the number of active runs
        at each step and a map of the previous visits
        """

        counts = self.counts.prefix("node:").scope_totals()
        by_node = {scope[5:]: count for scope, count in counts.items() if count}

        counts = self.counts.prefix("segment:").scope_totals()
        by_segment = {scope[8:]: count for scope, count in counts.items() if count}

        return by_node, by_segment

    def get_active_start(self):
        """
        Returns whether this flow is already being started by a user
        """
        a_week_ago = timezone.now() - timedelta(days=7)
        return (
            self.starts.filter(
                status__in=(FlowStart.STATUS_PENDING, FlowStart.STATUS_STARTED),
                created_on__gte=a_week_ago,
                created_by__isnull=False,
            )
            .order_by("-created_on")
            .first()
        )

    def import_definition(self, user, definition, dependency_mapping):
        """
        Allows setting the definition for a flow from another definition. All UUID's will be remapped.
        """

        definition = Flow.migrate_definition(definition, flow=None)

        info = mailroom.get_client().flow_inspect(self.org, definition)
        dependencies = info["dependencies"]

        # converts a dep ref {uuid|key, name, type, missing} to an importable partial definition {uuid|key, name}
        def ref_to_def(r: dict) -> dict:
            return {k: v for k, v in r.items() if k in ("uuid", "name", "key")}

        def deps_of_type(type_name: str):
            return [ref_to_def(d) for d in dependencies if d["type"] == type_name]

        # ensure all field dependencies exist
        for ref in deps_of_type("field"):
            ContactField.get_or_create(self.org, user, ref["key"], ref["name"])

        # ensure all group dependencies exist
        for ref in deps_of_type("group"):
            if ref["uuid"] not in dependency_mapping:
                group = ContactGroup.get_or_create(self.org, user, ref.get("name"), uuid=ref["uuid"])
                dependency_mapping[ref["uuid"]] = str(group.uuid)

        # ensure any label dependencies exist
        for ref in deps_of_type("label"):
            label, _ = Label.import_def(self.org, user, ref)
            dependency_mapping[ref["uuid"]] = str(label.uuid)

        # ensure any opt-in dependencies exist
        for ref in deps_of_type("optin"):
            optin, _ = OptIn.import_def(self.org, user, ref)
            dependency_mapping[ref["uuid"]] = str(optin.uuid)

        # ensure any topic dependencies exist
        for ref in deps_of_type("topic"):
            topic, _ = Topic.import_def(self.org, user, ref)
            dependency_mapping[ref["uuid"]] = str(topic.uuid)

        # for dependencies we can't create, look for them by UUID (this is a clone in same workspace)
        # or name (this is an import from other workspace)
        dep_types = {
            "channel": self.org.channels.filter(is_active=True),
            "flow": self.org.flows.filter(is_active=True),
            "llm": self.org.llms.filter(is_active=True),
            "template": self.org.templates.all(),
        }
        for dep_type, org_objs in dep_types.items():
            for ref in deps_of_type(dep_type):
                if ref["uuid"] in dependency_mapping:
                    continue

                obj = org_objs.filter(uuid=ref["uuid"]).first()
                if not obj and ref["name"]:
                    name = ref["name"]

                    # migrated legacy flows may have name as <type>: <name>
                    if dep_type == "channel" and ":" in name:
                        name = name.split(":")[-1].strip()

                    obj = org_objs.filter(name=name).first()

                dependency_mapping[ref["uuid"]] = str(obj.uuid) if obj else ref["uuid"]

        # clone definition so that all flow elements get new random UUIDs
        cloned_definition = mailroom.get_client().flow_clone(definition, dependency_mapping)
        if "revision" in cloned_definition:
            del cloned_definition["revision"]

        # save a new revision but we can't validate it just yet because we're in a transaction and mailroom
        # won't see any new database objects
        self.save_revision(user, cloned_definition)

    def archive(self, user, *, interrupt_sessions: bool = True):
        self.is_archived = True
        self.modified_by = user
        self.save(update_fields=("is_archived", "modified_by", "modified_on"))

        # archive our triggers as well
        for trigger in self.triggers.filter(is_active=True):
            trigger.archive(user)

        if interrupt_sessions:
            # call mailroom to interrupt sessions where contact is currently in this flow
            mailroom.get_client().flow_interrupt(self.org, self)

    def restore(self, user):
        self.is_archived = False
        self.modified_by = user
        self.save(update_fields=("is_archived", "modified_by", "modified_on"))

    @classmethod
    def prefetch_run_counts(cls, flows, *, using="default"):
        """
        Prefetches the counts required by get_run_counts
        """

        FlowActivityCount.prefetch_by_scope(flows, prefix="status:", to_attr="_status_counts", using=using)

    def get_run_counts(self) -> dict[str, int]:
        """
        Gets the counts of runs by status
        """

        if hasattr(self, "_status_counts"):
            counts = self._status_counts
        else:
            counts = self.counts.prefix("status:").scope_totals()

        return defaultdict(int, {scope[7:]: count for scope, count in counts.items()})

    def get_recent_contacts(self, exit_uuid: str, dest_uuid: str) -> list[dict]:
        r = get_valkey_connection()
        key = f"recent_contacts:{exit_uuid}:{dest_uuid}"

        # fetch members of the sorted set from valkey and save as tuples of (contact_id, operand, time)
        contact_ids = set()
        raw = []
        for member, score in r.zrange(key, start=0, end=-1, desc=True, withscores=True):
            rand, contact_id, operand = member.decode().split("|", maxsplit=2)
            contact_ids.add(int(contact_id))
            raw.append((int(contact_id), operand, datetime.fromtimestamp(score, tzone.utc)))

        # lookup all the referenced contacts
        contacts_by_id = {c.id: c for c in self.org.contacts.filter(id__in=contact_ids, is_active=True)}

        # if contact still exists, include in results
        recent = []
        for r in raw:
            if contact := contacts_by_id.get(r[0]):
                recent.append(
                    {
                        "contact": {"uuid": str(contact.uuid), "name": contact.get_display(org=self.org)},
                        "operand": r[1],
                        "time": r[2].isoformat(),
                    }
                )

        return recent

    def start(self, user, groups, contacts, query=None, exclude=None):
        """
        Starts this flow (asynchronously via mailroom).
        """

        assert not self.org.is_flagged and not self.org.is_suspended, "flagged and suspended orgs can't start flows"

        return FlowStart.create(
            self,
            user,
            start_type=FlowStart.TYPE_MANUAL,
            groups=groups,
            contacts=contacts,
            query=query,
            exclude=exclude,
        )

    def get_export_dependencies(self):
        """
        Get the dependencies of this flow that should be exported with it
        """
        dependencies = set()
        dependencies.update(self.flow_dependencies.all())
        dependencies.update(self.field_dependencies.all())
        dependencies.update(self.group_dependencies.all())
        return dependencies

    def get_dependencies_metadata(self, type_name):
        """
        Get the dependencies of the given type from the flow metadata
        """
        deps = self.info["dependencies"]
        return [d for d in deps if d["type"] == type_name]

    def is_legacy(self) -> bool:
        """
        Returns whether this flow still uses a legacy definition
        """
        return Version(self.version_number) < Version(Flow.INITIAL_GOFLOW_VERSION)

    def ensure_current_version(self):
        """
        Makes sure the flow is at the latest spec version
        """

        # nothing to do if flow is already at the target version
        if Version(self.version_number) >= Version(Flow.CURRENT_SPEC_VERSION):
            return

        with self.lock():
            revision = self.get_current_revision()
            flow_def = revision.get_migrated_definition()

            self.save_revision(user=None, definition=flow_def)
            self.refresh_from_db()

    def get_definition(self) -> dict:
        """
        Returns the current definition of this flow
        """
        rev = self.get_current_revision()

        assert rev, "can't get definition of flow with no revisions"

        # update metadata in definition from database object as it may be out of date
        definition = rev.definition

        if self.is_legacy():
            if "metadata" not in definition:
                definition["metadata"] = {}
            definition["metadata"]["uuid"] = self.uuid
            definition["metadata"]["name"] = self.name
            definition["metadata"]["revision"] = rev.revision
            definition["metadata"]["expires"] = self.expires_after_minutes
        else:
            definition[Flow.DEFINITION_UUID] = self.uuid
            definition[Flow.DEFINITION_NAME] = self.name
            definition[Flow.DEFINITION_REVISION] = rev.revision
            definition[Flow.DEFINITION_EXPIRE_AFTER_MINUTES] = self.expires_after_minutes
        return definition

    def get_current_revision(self):
        """
        Returns the last saved revision for this flow if any
        """
        return self.revisions.order_by("revision").last()

    def save_revision(self, user, definition) -> tuple:
        """
        Saves a new revision for this flow, validation will be done on the definition first
        """
        if Version(definition.get(Flow.DEFINITION_SPEC_VERSION)) < Version(Flow.INITIAL_GOFLOW_VERSION):
            raise FlowVersionConflictException(definition.get(Flow.DEFINITION_SPEC_VERSION))

        current_revision = self.get_current_revision()

        if current_revision:
            # check we aren't walking over someone else
            definition_revision = definition.get(Flow.DEFINITION_REVISION)
            if definition_revision is not None and definition_revision < current_revision.revision:
                raise FlowUserConflictException(self.saved_by, self.saved_on)

            revision = current_revision.revision + 1
        else:
            revision = 1

        # update metadata from database object; normalize spec_version to CURRENT
        # since that's what we persist on the new revision row, so the saved row
        # and the diff input agree
        definition[Flow.DEFINITION_UUID] = self.uuid
        definition[Flow.DEFINITION_NAME] = self.name
        definition[Flow.DEFINITION_REVISION] = revision
        definition[Flow.DEFINITION_EXPIRE_AFTER_MINUTES] = self.expires_after_minutes
        definition[Flow.DEFINITION_SPEC_VERSION] = Flow.CURRENT_SPEC_VERSION

        # diff against prior revision so we can skip no-op saves and later collapse
        # like-for-like edits; done outside the transaction below because
        # get_migrated_definition() may call mailroom (HTTP) and we don't want that
        # holding row locks
        changes = None
        if current_revision:
            prior_def = current_revision.definition
            if current_revision.spec_version != Flow.CURRENT_SPEC_VERSION:
                # migrate the prior forward so the schemas align; accepting that name/expire
                # then come from the live flow (get_migrated_definition rewrites them) — fine
                # because cross-spec saves are rare and not where metadata diffs matter
                try:
                    prior_def = current_revision.get_migrated_definition()
                    # get_migrated_definition rewrites spec_version to CURRENT, but we
                    # want compute_changes to see the original spec so it can tag "spec"
                    prior_def[Flow.DEFINITION_SPEC_VERSION] = current_revision.spec_version
                except Exception:
                    # don't block a valid save just because the legacy migration failed
                    logger.warning("could not migrate prior revision for flow %s", self.uuid, exc_info=True)
                    prior_def = None
            if prior_def is not None:
                changes = compute_changes(prior_def, definition)

        # if the definition is unchanged from the current revision, don't create a
        # new one — author-only changes shouldn't produce revision churn
        if changes is not None and not changes["tags"]:
            return current_revision, (self.info or {}).get("issues", [])

        # inspect the flow (with optional validation)
        info = mailroom.get_client().flow_inspect(self.org, definition)

        if user is None:
            is_system_rev = True
            user = User.get_system_user()
        else:
            is_system_rev = False

        with transaction.atomic():
            # update our flow fields
            self.base_language = definition.get(Flow.DEFINITION_LANGUAGE, None)
            self.version_number = Flow.CURRENT_SPEC_VERSION
            self.has_issues = len(info["issues"]) > 0
            self.info = info
            self.modified_by = user
            self.modified_on = timezone.now()
            fields = ["base_language", "version_number", "has_issues", "info", "modified_by", "modified_on"]

            if not is_system_rev:
                self.saved_by = user
                self.saved_on = timezone.now()
                fields += ["saved_by", "saved_on"]

            self.save(update_fields=fields)

            # create our new revision
            revision = self.revisions.create(
                definition=definition,
                changes=changes,
                created_by=user,
                spec_version=Flow.CURRENT_SPEC_VERSION,
                revision=revision,
            )

            self.update_dependencies(info["dependencies"])

        # cap the revision history inline so it doesn't pile up between cron runs;
        # best-effort and outside the save transaction so a trim failure can neither
        # roll back nor surface as a save failure (the cron task is the safety net)
        try:
            FlowRevision.trim_for_flow(self.id)
        except Exception:
            logger.warning("failed to trim revisions for flow %s", self.uuid, exc_info=True)

        return revision, info["issues"]

    @classmethod
    def migrate_definition(cls, flow_def, flow, to_version=None):
        if not to_version:
            to_version = cls.CURRENT_SPEC_VERSION

        if "version" in flow_def:
            flow_def = legacy.migrate_definition(flow_def, flow=flow)

        # migrate using goflow for anything newer
        if Version(to_version) >= Version(Flow.INITIAL_GOFLOW_VERSION):
            flow_def = mailroom.get_client().flow_migrate(flow_def, to_version)

        return flow_def

    @classmethod
    def migrate_export(cls, org, exported_json, same_site, version):
        # use legacy migrations to get export to final legacy version
        if version < Version(Flow.FINAL_LEGACY_VERSION):
            from temba.flows.legacy import exports

            exported_json = exports.migrate(org, exported_json, same_site, version)

        migrated_flows = []
        for flow_def in exported_json["flows"]:
            migrated_def = Flow.migrate_definition(flow_def, flow=None)
            migrated_flows.append(migrated_def)

        exported_json["flows"] = migrated_flows

        return exported_json

    def update_dependencies(self, dependencies):
        # build a lookup of types to identifier lists
        identifiers = defaultdict(list)
        for dep in dependencies:
            identifier = dep.get("uuid", dep.get("key"))
            identifiers[dep["type"]].append(identifier)

        # globals aren't included in exports so they're created here too if they don't exist, with blank values
        if identifiers["global"]:
            org_globals = set(self.org.globals.filter(is_active=True).values_list("key", flat=True))

            globals_to_create = set(identifiers["global"]).difference(org_globals)
            for g in globals_to_create:
                Global.get_or_create(self.org, self.modified_by, g, name="", value="")

        # find all the dependencies in the database
        dep_objs = {
            "channel": self.org.channels.filter(is_active=True, uuid__in=identifiers["channel"]),
            "field": self.org.fields.filter(is_active=True, is_proxy=False, key__in=identifiers["field"]),
            "flow": self.org.flows.filter(is_active=True, uuid__in=identifiers["flow"]),
            "global": self.org.globals.filter(is_active=True, key__in=identifiers["global"]),
            "group": ContactGroup.get_groups(self.org).filter(uuid__in=identifiers["group"]),
            "label": Label.get_active_for_org(self.org).filter(uuid__in=identifiers["label"]),
            "llm": self.org.llms.filter(is_active=True, uuid__in=identifiers["llm"]),
            "optin": OptIn.get_active_for_org(self.org).filter(uuid__in=identifiers["optin"]),
            "template": self.org.templates.filter(uuid__in=identifiers["template"]),
            "topic": self.org.topics.filter(is_active=True, uuid__in=identifiers["topic"]),
            "user": self.org.users.filter(is_active=True, email__in=identifiers["user"]),
        }

        # reset the m2m for each type
        for type_name, objects in dep_objs.items():
            m2m = getattr(self, f"{type_name}_dependencies")
            m2m.clear()
            m2m.add(*objects)

    def get_dependents(self):
        dependents = super().get_dependents()
        dependents["campaign_event"] = self.campaign_events.filter(is_active=True)
        dependents["trigger"] = self.triggers.filter(is_active=True)
        return dependents

    def get_engagement_start(self) -> date:
        """
        Gets earliest date of recorded engagement (i.e. messages in) for this flow.
        """
        first = self.counts.prefix("msgsin:date:").order_by("scope").first()

        utc_timezone = tzone.utc

        return datetime.fromisoformat(first.scope[12:]).replace(tzinfo=utc_timezone).date() if first else None

    def get_engagement_timeline(self, since, until) -> dict:
        rollup_by = "day"

        # bucket dates into months or weeks depending on the range
        if since < until - relativedelta(years=3):
            rollup_by = "month"
        elif since < until - relativedelta(years=1):
            rollup_by = "week"

        dates = (
            self.counts.prefix("msgsin:date:")
            .extra({"date": f"date_trunc('{rollup_by}', split_part(scope, ':', 3)::date)"})
            .values("date")
            .annotate(count=Sum("count"))
            .order_by("date")
        )

        since = dates[0]["date"].date() if len(dates) > 0 else since

        all_dates = []
        counts = []

        for d in dates:
            all_dates.append(d["date"].date())
            counts.append(d["count"])

        return {"dates": all_dates, "counts": counts, "rollup_by": rollup_by}

    def get_engagement_by_weekday(self) -> dict[int, int]:
        """
        Gets engagement counts (i.e. messages in) by day of the week.
        """

        def parse(scope: str) -> int:
            """
            e.g. "msgsin:dow:3" -> 3, "msgsin:dow:7" -> 0
            """
            iso_dow = int(scope[11:])  # 1-7 Mon-Sun
            return 0 if iso_dow == 7 else iso_dow  # 0-6 Sun-Sat

        counts = self.counts.prefix("msgsin:dow:").scope_totals()
        return {parse(scope): count for scope, count in counts.items()}

    def get_engagement_by_hour(self, tz) -> dict[int, int]:
        """
        Gets engagement counts (i.e. messages in) by hour of the day.
        """

        offset = tz.utcoffset(timezone.now()).total_seconds() // 3600  # hour counts are stored in UTC

        def parse(scope: str) -> int:
            """
            e.g. "msgsin:hour:7" -> 7
            """
            return (int(scope[12:]) + offset) % 24

        counts = self.counts.prefix("msgsin:hour:").scope_totals()
        return {parse(scope): count for scope, count in counts.items()}

    def release(self, user, *, interrupt_sessions: bool = True):
        """
        Releases this flow, marking it inactive. We interrupt all flow runs in a background process.
        We keep FlowRevisions and FlowStarts however.
        """

        from temba.campaigns.models import CampaignEvent

        super().release(user)

        self.name = self._deleted_name()
        self.is_active = False
        self.modified_by = user
        self.save(update_fields=("name", "is_active", "modified_by", "modified_on"))

        # release any campaign events that depend on this flow
        for event in CampaignEvent.objects.filter(flow=self, is_active=True):
            event.release(user)

        # release any triggers that depend on this flow
        for trigger in self.triggers.filter(is_active=True):
            trigger.release(user)

        self.channel_dependencies.clear()
        self.field_dependencies.clear()
        self.flow_dependencies.clear()
        self.global_dependencies.clear()
        self.group_dependencies.clear()
        self.label_dependencies.clear()
        self.template_dependencies.clear()
        self.topic_dependencies.clear()
        self.user_dependencies.clear()

        self.counts.all().delete()

        # call mailroom to interrupt sessions where contact is currently in this flow
        if interrupt_sessions:
            mailroom.get_client().flow_interrupt(self.org, self)

    def delete(self):
        """
        Does actual deletion of this flow during org deletion.
        """

        assert not self.is_active, "can't delete flow which hasn't been released"

        delete_in_batches(self.revisions.all())

        for trigger in self.triggers.all():
            trigger.delete()

        for start in self.starts.all():
            start.delete()

        self.labels.clear()

        delete_in_batches(self.counts.all())
        delete_in_batches(self.result_counts.all())

        super().delete()

    class Meta:
        ordering = ("-modified_on",)
        verbose_name = _("Flow")
        verbose_name_plural = _("Flows")

        constraints = [models.UniqueConstraint("org", Lower("name"), name="unique_flow_names")]


class FlowSession(models.Model):
    """
    A contact's session with the flow engine
    """

    STATUS_WAITING = "W"
    STATUS_COMPLETED = "C"
    STATUS_INTERRUPTED = "I"
    STATUS_EXPIRED = "X"
    STATUS_FAILED = "F"
    STATUS_CHOICES = (
        (STATUS_WAITING, "Waiting"),
        (STATUS_COMPLETED, "Completed"),
        (STATUS_INTERRUPTED, "Interrupted"),
        (STATUS_EXPIRED, "Expired"),
        (STATUS_FAILED, "Failed"),
    )

    id = models.BigAutoField(primary_key=True)
    uuid = models.UUIDField(unique=True)
    contact_uuid = models.UUIDField()
    status = models.CharField(max_length=1, choices=STATUS_CHOICES)
    last_sprint_uuid = models.UUIDField(null=True)  # last sprint in this session
    current_flow_uuid = models.UUIDField(null=True)  # the flow of the waiting run
    call_uuid = models.UUIDField(null=True)  # the call used for sessions over IVR

    session_type = models.CharField(max_length=1, choices=Flow.TYPE_CHOICES, default=Flow.TYPE_MESSAGE)  # flow type
    output = JSONAsTextField(default=dict)  # the engine output

    # when this session was created and ended
    created_on = models.DateTimeField(default=timezone.now)
    ended_on = models.DateTimeField(null=True)

    def __repr__(self):  # pragma: no cover
        return f"<FlowSession: uuid={self.uuid} contact={self.contact_uuid}>"

    class Meta:
        indexes = [
            # for trimming ended sessions
            models.Index(name="flowsessions_ended", fields=("ended_on",), condition=Q(ended_on__isnull=False)),
        ]
        constraints = [
            # ensure that non-waiting sessions have an ended_on
            models.CheckConstraint(
                condition=Q(status="W") | Q(ended_on__isnull=False), name="flows_session_non_waiting_has_ended_on"
            ),
        ]


class FlowRun(models.Model):
    """
    A single contact's journey through a flow. It records the path taken, results collected etc.
    """

    STATUS_ACTIVE = "A"
    STATUS_WAITING = "W"
    STATUS_COMPLETED = "C"
    STATUS_INTERRUPTED = "I"
    STATUS_EXPIRED = "X"
    STATUS_FAILED = "F"
    STATUS_CHOICES = (
        (STATUS_ACTIVE, "Active"),
        (STATUS_WAITING, "Waiting"),
        (STATUS_COMPLETED, "Completed"),
        (STATUS_INTERRUPTED, "Interrupted"),
        (STATUS_EXPIRED, "Expired"),
        (STATUS_FAILED, "Failed"),
    )

    EXIT_TYPE_COMPLETED = "C"
    EXIT_TYPE_INTERRUPTED = "I"
    EXIT_TYPE_EXPIRED = "E"
    EXIT_TYPE_FAILED = "F"
    EXIT_TYPE_CHOICES = (
        (EXIT_TYPE_COMPLETED, "Completed"),
        (EXIT_TYPE_INTERRUPTED, "Interrupted"),
        (EXIT_TYPE_EXPIRED, "Expired"),
        (EXIT_TYPE_FAILED, "Failed"),
    )

    id = models.BigAutoField(primary_key=True)
    uuid = models.UUIDField(unique=True, default=uuid4)
    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="runs", db_index=False)
    flow = models.ForeignKey(Flow, on_delete=models.PROTECT, related_name="runs")
    status = models.CharField(max_length=1, choices=STATUS_CHOICES)
    session_uuid = models.UUIDField()

    # contact isn't an index because we have flows_flowrun_contact_inc_flow below
    contact = models.ForeignKey(Contact, on_delete=models.PROTECT, related_name="runs", db_index=False)

    # when this run was created, last modified and exited
    created_on = models.DateTimeField(default=timezone.now)
    modified_on = models.DateTimeField(default=timezone.now)
    exited_on = models.DateTimeField(null=True)

    # true if the contact has responded in this run
    responded = models.BooleanField(default=False)

    # flow start which started the session this run belongs to
    start = models.ForeignKey("flows.FlowStart", on_delete=models.PROTECT, null=True, related_name="runs")

    # results collected in this run keyed by snakified result name
    results = JSONAsTextField(null=True, default=dict)

    # path taken by this run through the flow
    path_nodes = ArrayField(models.UUIDField(), null=True)
    path_times = ArrayField(models.DateTimeField(), null=True)

    # current node location of this run in the flow
    current_node_uuid = models.UUIDField(null=True)

    @dataclass
    class Step:
        node: UUID
        time: datetime

    def get_path(self):
        return [self.Step(node=n, time=t) for n, t in zip(self.path_nodes or [], self.path_times or [])]

    def as_archive_json(self):
        from temba.api.v2.views import FlowRunReadSerializer

        def convert_result(result):
            return {
                "name": result.get("name"),
                "node": result.get("node_uuid"),
                "time": result["created_on"],
                "value": result["value"],
                "category": result.get("category"),
                "input": result.get("input"),
            }

        return {
            "id": self.id,
            "uuid": str(self.uuid),
            "flow": {"uuid": str(self.flow.uuid), "name": self.flow.name},
            "contact": {"uuid": str(self.contact.uuid), "name": self.contact.name},
            "responded": self.responded,
            "path": [{"node": str(s.node), "time": s.time.isoformat()} for s in self.get_path()],
            "values": {k: convert_result(r) for k, r in self.results.items()} if self.results else {},
            "created_on": self.created_on.isoformat(),
            "modified_on": self.modified_on.isoformat(),
            "exited_on": self.exited_on.isoformat() if self.exited_on else None,
            "exit_type": FlowRunReadSerializer.EXIT_TYPES.get(self.status),
        }

    def __repr__(self):  # pragma: no cover
        return f"<FlowRun: id={self.id} flow={self.flow.name}>"

    class Meta:
        indexes = [
            # for API endpoint access
            models.Index(name="flowruns_api_by_flow", fields=("flow", "-modified_on", "-id")),
            models.Index(
                name="flowruns_api_responded_by_flow",
                fields=("flow", "-modified_on", "-id"),
                condition=Q(responded=True),
            ),
            models.Index(name="flowruns_api_by_org", fields=("org", "-modified_on", "-id")),
            models.Index(
                name="flowruns_api_responded_by_org", fields=("org", "-modified_on", "-id"), condition=Q(responded=True)
            ),
            # for finding and messaging all contacts at a given node
            models.Index(
                name="flows_flowrun_contacts_at_node",
                fields=("org", "current_node_uuid"),
                condition=Q(status__in=("A", "W")),
                include=("contact",),
            ),
            # for indexing contacts with their flow history
            models.Index(name="flows_flowrun_contact_inc_flow", fields=("contact",), include=("flow",)),
            # for interrupts
            models.Index(name="flowruns_by_session", fields=("session_uuid",), condition=Q(status__in=("A", "W"))),
        ]
        constraints = [
            # all non-active/waiting runs must have an exited_on
            models.CheckConstraint(
                condition=Q(status__in=("A", "W")) | Q(exited_on__isnull=False),
                name="flows_run_inactive_has_exited_on",
            ),
        ]


class FlowRevision(models.Model):
    """
    Each version of a flow's definition.
    """

    LAST_TRIM_KEY = "temba:last_flow_revision_trim"
    MAX_REVISIONS = 500

    flow = models.ForeignKey(Flow, on_delete=models.PROTECT, related_name="revisions")
    definition = JSONAsTextField(default=dict)
    spec_version = models.CharField(default=Flow.FINAL_LEGACY_VERSION, max_length=8)
    revision = models.IntegerField()

    # categorized record of what changed since the previous revision; null for legacy
    # revisions that pre-date this field.
    changes = models.JSONField(null=True, default=None)

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="revisions")
    created_on = models.DateTimeField(default=timezone.now)

    @classmethod
    def trim(cls, since):
        """
        For any flow that has a new revision since the passed in date, trim revisions
        :param since: datetime of when to trim
        :return: The number of trimmed revisions
        """
        count = 0

        # find all flows with revisions since the passed in date
        for fr in FlowRevision.objects.filter(created_on__gt=since).distinct("flow_id").only("flow_id"):
            # trim that flow
            count += FlowRevision.trim_for_flow(fr.flow_id)

        return count

    @classmethod
    def trim_for_flow(cls, flow_id):
        """
        Keeps the MAX_REVISIONS most recent revisions for this flow and deletes the rest.

        :param flow: the id of the flow to trim revisions for
        :return: the number of trimmed revisions
        """
        keepers = list(
            FlowRevision.objects.filter(flow=flow_id)
            .order_by("-created_on", "-id")
            .values_list("id", flat=True)[: cls.MAX_REVISIONS]
        )
        return FlowRevision.objects.filter(flow=flow_id).exclude(id__in=keepers).delete()[0]

    @classmethod
    def validate_legacy_definition(cls, definition):
        if definition["flow_type"] not in (Flow.TYPE_MESSAGE, Flow.TYPE_VOICE, Flow.TYPE_SURVEY, "F"):
            raise ValueError("unsupported flow type")

        # should always have a base_language
        if "base_language" not in definition or not definition["base_language"]:
            raise ValueError("non-localized flow definition")

        # language should match values in definition
        base_language = definition["base_language"]

        def validate_localization(lang_dict):
            # must be a dict
            if not isinstance(lang_dict, dict):
                raise ValueError("non-localized flow definition")

            # and contain the base_language
            if base_language not in lang_dict:  # pragma: needs cover
                raise ValueError("non-localized flow definition")

        for actionset in definition["action_sets"]:
            for action in actionset["actions"]:
                if "msg" in action and action["type"] != "email":
                    validate_localization(action["msg"])

        for ruleset in definition["rule_sets"]:
            for rule in ruleset["rules"]:
                validate_localization(rule["category"])

    def get_migrated_definition(self, to_version: str = Flow.CURRENT_SPEC_VERSION) -> dict:
        definition = self.definition

        # if it's previous to version 6, wrap the definition to
        # mirror our exports for those versions
        if Version(self.spec_version) < Version("6"):
            definition = dict(
                definition=self.definition,
                flow_type=self.flow.flow_type,
                expires=self.flow.expires_after_minutes,
                id=self.flow.pk,
                revision=self.revision,
                uuid=self.flow.uuid,
            )

        # make sure old revisions migrate properly
        if Version(self.spec_version) <= Version(Flow.FINAL_LEGACY_VERSION):
            definition["version"] = self.spec_version

            if "metadata" not in definition:
                definition["metadata"] = {}
            definition["metadata"]["revision"] = self.revision

        # migrate our definition if necessary
        if self.spec_version != to_version:
            definition = Flow.migrate_definition(definition, self.flow, to_version)

        # update variables from our db into our revision
        flow = self.flow
        definition[Flow.DEFINITION_NAME] = flow.name
        definition[Flow.DEFINITION_UUID] = flow.uuid
        definition[Flow.DEFINITION_REVISION] = self.revision
        definition[Flow.DEFINITION_EXPIRE_AFTER_MINUTES] = flow.expires_after_minutes

        return definition

    def as_json(self):
        return {
            "id": self.id,
            "user": {"email": self.created_by.email, "name": self.created_by.name},
            "created_on": self.created_on.isoformat(),
            "version": self.spec_version,
            "revision": self.revision,
            "changes": self.changes or {},
        }


class FlowActivityCount(BaseScopedCount):
    """
    Flow-level counts of activity.
    """

    squash_over = ("flow_id", "scope")

    flow = models.ForeignKey(Flow, on_delete=models.PROTECT, related_name="counts", db_index=False)  # indexed below

    @classmethod
    def prefetch_by_scope(cls, flows, *, prefix: str, to_attr: str, using: str):
        counts = (
            cls.objects.using(using)
            .filter(flow__in=flows)
            .prefix(prefix)
            .values_list("flow_id", "scope")
            .annotate(total=Sum("count"))
        )
        by_flow = defaultdict(dict)
        for count in counts:
            by_flow[count[0]][count[1]] = count[2]

        for flow in flows:
            setattr(flow, to_attr, by_flow[flow.id])

    class Meta:
        indexes = [
            models.Index("flow", OpClass("scope", name="varchar_pattern_ops"), name="flowactivitycount_flow_scope"),
            # for squashing task
            models.Index(name="flowactivitycount_unsquashed", fields=("flow", "scope"), condition=Q(is_squashed=False)),
        ]


class FlowResultCount(BaseSquashableCount):
    """
    Maintains counts for categories across results in a flow.
    """

    squash_over = ("flow_id", "result", "category")

    flow = models.ForeignKey(Flow, on_delete=models.PROTECT, related_name="result_counts")
    result = models.CharField(max_length=64)
    category = models.CharField(max_length=64)

    class Meta:
        indexes = [
            # for squashing task
            models.Index(
                name="flowresultcount_unsquashed",
                fields=("flow", "result", "category"),
                condition=Q(is_squashed=False),
            ),
        ]


class ResultsExport(ExportType):
    """
    Export of flow results
    """

    slug = "results"
    name = _("Flow Results")
    download_prefix = "flow_results"
    download_template = "flows/export_download.html"

    @classmethod
    def create(
        cls,
        org,
        user,
        start_date,
        end_date,
        flows=[],
        with_fields=[],
        with_groups=[],
        responded_only=True,
        extra_urns=[],
    ):
        export = Export.objects.create(
            org=org,
            export_type=cls.slug,
            start_date=start_date,
            end_date=end_date,
            config={
                "flow_ids": [f.id for f in flows],
                "with_fields": [f.id for f in with_fields],
                "with_groups": [g.id for g in with_groups],
                "responded_only": responded_only,
                "extra_urns": extra_urns,
            },
            created_by=user,
        )
        return export

    def get_flows(self, export):
        flow_ids = export.config.get("flow_ids")

        return export.org.flows.filter(id__in=flow_ids, is_active=True)

    def get_runs_columns(self, export, extra_urn_columns, result_fields):
        columns = export.get_contact_headers()

        for extra_urn in extra_urn_columns:
            columns.append(extra_urn["label"])

        columns.append("Started")
        columns.append("Modified")
        columns.append("Exited")
        columns.append("Run UUID")

        for result_field in result_fields:
            field_name, flow_name = result_field["name"], result_field["flow_name"]
            columns.append(f"{field_name} (Category) - {flow_name}")
            columns.append(f"{field_name} (Value) - {flow_name}")
            columns.append(f"{field_name} (Text) - {flow_name}")

        return columns

    def write(self, export) -> tuple:
        flows = self.get_flows(export)
        start_date, end_date = export.get_date_range()
        responded_only = export.config.get("responded_only", True)
        extra_urns = export.config.get("extra_urns", [])

        result_fields = []
        for flow in flows:
            for result_field in flow.info["results"]:
                if not result_field["name"].startswith("_"):
                    result_field = result_field.copy()
                    result_field["flow_uuid"] = flow.uuid
                    result_field["flow_name"] = flow.name
                    result_fields.append(result_field)

        extra_urn_columns = []
        if not export.org.is_anon:
            for extra_urn in extra_urns:
                label = f"URN:{extra_urn.capitalize()}"
                extra_urn_columns.append(dict(label=label, scheme=extra_urn))

        runs_columns = self.get_runs_columns(export, extra_urn_columns, result_fields)

        # create our exporter
        exporter = MultiSheetExporter("Runs", runs_columns, export.org.timezone)
        num_records = 0

        for batch in self._get_run_batches(export, start_date, end_date, flows, responded_only):
            self._write_runs(export, exporter, batch, extra_urn_columns, result_fields)

            num_records += len(batch)

            export.modified_on = timezone.now()
            export.save(update_fields=("modified_on",))

        return *exporter.save_file(), num_records

    def _get_run_batches(self, export, start_date, end_date, flows, responded_only: bool):
        logger.info(f"Results export #{export.id} for org #{export.org.id}: fetching runs from archives to export...")

        # firstly get runs from archives
        from temba.archives.models import Archive

        # get the earliest created date of the flows being exported
        earliest_created_on = None
        for flow in flows:
            if earliest_created_on is None or flow.created_on < earliest_created_on:
                earliest_created_on = flow.created_on

        flow_uuids = [str(flow.uuid) for flow in flows]
        where = {"flow__uuid__in": flow_uuids}
        if responded_only:
            where["responded"] = True
        records = Archive.iter_all_records(
            export.org, Archive.TYPE_FLOWRUN, after=max(earliest_created_on, start_date), before=end_date, where=where
        )
        seen = set()

        for record_batch in itertools.batched(records, 1000):
            matching = []
            for record in record_batch:
                seen.add(record["id"])
                matching.append(record)
            yield matching

        # secondly get runs from database
        runs = (
            FlowRun.objects.filter(created_on__gte=start_date, created_on__lte=end_date, flow__in=flows)
            .order_by("modified_on")
            .using("readonly")
        )
        if responded_only:
            runs = runs.filter(responded=True)
        run_ids = array(str("l"), runs.values_list("id", flat=True))

        logger.info(
            f"Results export #{export.id} for org #{export.org.id}: found {len(run_ids)} runs in database to export"
        )

        for id_batch in itertools.batched(run_ids, 1000):
            run_batch = (
                FlowRun.objects.filter(id__in=id_batch)
                .order_by("modified_on", "id")
                .prefetch_related(
                    Prefetch("contact", Contact.objects.only("uuid", "name")),
                    Prefetch("flow", Flow.objects.only("uuid", "name")),
                )
                .using("readonly")
            )

            # convert this batch of runs to same format as records in our archives
            yield [run.as_archive_json() for run in run_batch if run.id not in seen]

    def _write_runs(self, export, exporter, runs, extra_urn_columns, result_fields):
        """
        Writes a batch of run JSON blobs to the export
        """
        # get all the contacts referenced in this batch
        contact_uuids = {r["contact"]["uuid"] for r in runs}
        contacts = (
            Contact.objects.filter(org=export.org, uuid__in=contact_uuids)
            .select_related("org")
            .prefetch_related("groups")
            .using("readonly")
        )
        contacts_by_uuid = {str(c.uuid): c for c in contacts}

        Contact.bulk_urn_cache_initialize(contacts, using="readonly")

        for run in runs:
            contact = contacts_by_uuid.get(run["contact"]["uuid"])

            # get this run's results by node name(ruleset label)
            run_values = run["values"]
            if isinstance(run_values, list):
                results_by_key = {key: result for item in run_values for key, result in item.items()}
            else:
                results_by_key = {key: result for key, result in run_values.items()}

            # generate contact info columns
            contact_values = export.get_contact_columns(contact)

            for extra_urn_column in extra_urn_columns:
                urn_display = contact.get_urn_display(
                    org=export.org, formatted=False, scheme=extra_urn_column["scheme"]
                )
                contact_values.append(urn_display)

            # generate result columns for each ruleset
            result_values = []
            for result_field in result_fields:
                node_result = {}
                # check the result by ruleset label if the flow is the same
                if result_field["flow_uuid"] == run["flow"]["uuid"]:
                    node_result = results_by_key.get(result_field["key"], {})
                node_category = node_result.get("category", "")
                node_value = node_result.get("value", "")
                node_input = node_result.get("input", "")
                result_values += [node_category, node_value, node_input]

            # build the whole row
            runs_sheet_row = contact_values
            runs_sheet_row += [
                iso8601.parse_date(run["created_on"]),
                iso8601.parse_date(run["modified_on"]),
                iso8601.parse_date(run["exited_on"]) if run["exited_on"] else None,
                run["uuid"],
            ]
            runs_sheet_row += result_values

            exporter.write_row(runs_sheet_row)

    def get_download_context(self, export) -> dict:
        flows = self.get_flows(export)
        responded_only = export.config.get("responded_only", True)
        return {
            "responded_only": responded_only,
            "flows": [dict(uuid=f.uuid, name=f.name) for f in flows],
        }


class FlowStart(models.Model):
    """
    A queuable request to start contacts and groups in a flow
    """

    EXCLUSION_NON_ACTIVE = "non_active"  # contacts blocked, stopped or archived
    EXCLUSION_IN_A_FLOW = "in_a_flow"  # contacts currently in a flow (including this one)
    EXCLUSION_STARTED_PREVIOUSLY = "started_previously"  # contacts been in this flow in the last 90 days
    EXCLUSION_NOT_SEEN_SINCE_DAYS = "not_seen_since_days"  # contacts not seen for more than this number of days

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

    TYPE_MANUAL = "M"
    TYPE_API = "A"
    TYPE_API_ZAPIER = "Z"
    TYPE_TRIGGER = "T"
    TYPE_CHOICES = (
        (TYPE_MANUAL, "Manual"),
        (TYPE_API, "API"),
        (TYPE_API_ZAPIER, "Zapier"),
        (TYPE_TRIGGER, "Trigger"),
    )

    uuid = models.UUIDField(unique=True, default=uuid4)
    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="flow_starts")
    flow = models.ForeignKey(Flow, on_delete=models.PROTECT, related_name="starts")
    start_type = models.CharField(max_length=1, choices=TYPE_CHOICES)
    status = models.CharField(max_length=1, choices=STATUS_CHOICES, default=STATUS_PENDING)
    contact_count = models.IntegerField(default=0, null=True)  # null until status is QUEUED

    # who to start
    groups = models.ManyToManyField(ContactGroup)
    contacts = models.ManyToManyField(Contact)
    urns = ArrayField(models.TextField(), null=True)
    query = models.TextField(null=True)
    exclusions = models.JSONField(default=dict, null=True)

    params = models.JSONField(null=True, default=dict)

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name="+")
    created_on = models.DateTimeField(default=timezone.now)
    modified_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name="+")
    modified_on = models.DateTimeField(default=timezone.now)

    @classmethod
    def create(
        cls,
        flow,
        user,
        *,
        start_type=TYPE_MANUAL,
        groups=(),
        contacts=(),
        urns=(),
        query=None,
        exclude=None,
        params=None,
    ):
        return mailroom.get_client().flow_start(
            flow.org,
            user,
            typ=start_type,
            flow=flow,
            groups=list(groups),
            contacts=list(contacts),
            urns=list(urns),
            query=query,
            exclude=exclude,
            params=params or {},
        )

    @classmethod
    def preview(cls, flow, *, include: mailroom.Inclusions, exclude: mailroom.Exclusions) -> tuple[str, int]:
        """
        Requests a preview of the recipients of a start created with the given inclusions/exclusions, returning a tuple
        of the canonical query and the total count of contacts.
        """
        preview = mailroom.get_client().flow_start_preview(flow.org, flow, include=include, exclude=exclude)

        return preview.query, preview.total

    def is_starting(self) -> bool:
        return self.status in (self.STATUS_PENDING, self.STATUS_STARTED)

    @classmethod
    def has_unfinished(cls, org) -> bool:
        a_week_ago = timezone.now() - timedelta(days=7)
        return org.flow_starts.filter(
            status__in=(cls.STATUS_PENDING, cls.STATUS_STARTED), created_on__gte=a_week_ago
        ).exists()

    def interrupt(self, user):
        """
        Interrupts this flow start
        """

        self.status = self.STATUS_INTERRUPTED
        self.modified_by = user
        self.save(update_fields=("status", "modified_by", "modified_on"))

    def delete(self):
        """
        Deletes this flow start - called during org deletion or trimming task.
        """

        self.groups.clear()
        self.contacts.clear()
        self.counts.all().delete()

        FlowRun.objects.filter(start=self).update(start=None)

        super().delete()

    def __repr__(self):
        return f'<FlowStart: id={self.id} flow="{self.flow.uuid}">'

    class Meta:
        indexes = [
            # used for the flow start log page
            models.Index(
                name="flows_flowstarts_org_created",
                fields=["org", "-created_on"],
                condition=Q(created_by__isnull=False),
            ),
            # used by the flow_starts API endpoint
            models.Index(
                name="flows_flowstarts_org_modified",
                fields=["org", "-modified_on"],
                condition=Q(created_by__isnull=False),
            ),
            # used by the flow_starts type filters page
            models.Index(name="flows_flowstart_org_start_type", fields=["org", "start_type", "-created_on"]),
            # used by get_active_start
            models.Index(
                name="flows_flowstarts_flow_active",
                fields=["flow", "-created_on"],
                condition=Q(status__in=("P", "S")),
            ),
        ]


class FlowStartCount(BaseSquashableCount):
    """
    Maintains count of how many runs a FlowStart has created.
    """

    squash_over = ("start_id",)

    start = models.ForeignKey(FlowStart, on_delete=models.PROTECT, related_name="counts", db_index=True)

    @classmethod
    def get_count(cls, start):
        return start.counts.all().sum()

    @classmethod
    def bulk_annotate(cls, starts):
        counts = (
            cls.objects.filter(start_id__in=[s.id for s in starts])
            .values("start_id")
            .order_by("start_id")
            .annotate(count=Sum("count"))
        )
        counts_by_start = {c["start_id"]: c["count"] for c in counts}

        for start in starts:
            start.run_count = counts_by_start.get(start.id, 0)

    class Meta:
        indexes = [models.Index(fields=("start",), condition=Q(is_squashed=False), name="flowstartcounts_unsquashed")]


class FlowLabel(TembaModel):
    """
    A label applied to a flow rather than a message
    """

    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="flow_labels")

    @classmethod
    def create(cls, org, user, name: str):
        assert cls.is_valid_name(name), f"'{name}' is not a valid flow label name"
        assert not org.flow_labels.filter(name__iexact=name).exists()

        return cls.objects.create(org=org, name=name, created_by=user, modified_by=user)

    def get_flow_count(self):
        """
        Returns the count of flows tagged with this label or one of its children
        """
        return self.get_flows().count()

    def get_flows(self):
        return self.flows.filter(is_active=True, is_archived=False)

    def toggle_label(self, flows, *, add: bool):
        changed = []

        for flow in flows:
            # if we are adding the flow label and this flow doesn't have it, add it
            if add:
                if not flow.labels.filter(pk=self.id):
                    flow.labels.add(self)
                    changed.append(flow.id)

            # otherwise, remove it if not already present
            else:
                if flow.labels.filter(pk=self.id):
                    flow.labels.remove(self)
                    changed.append(flow.id)

        return changed

    def __str__(self):  # pragma: needs cover
        return self.name

    class Meta:
        constraints = [models.UniqueConstraint("org", Lower("name"), name="unique_flowlabel_names")]
