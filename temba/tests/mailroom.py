import copy
import functools
import re
from collections import defaultdict
from dataclasses import asdict
from decimal import Decimal
from functools import wraps
from unittest.mock import call

from django.conf import settings
from django.db import connection
from django.utils import timezone

from temba import mailroom
from temba.campaigns.models import CampaignEvent
from temba.contacts.models import URN, Contact, ContactField, ContactGroup, ContactURN
from temba.flows.models import Flow, FlowRun, FlowSession, FlowStart
from temba.locations.models import AdminBoundary
from temba.mailroom.client.client import MailroomClient
from temba.mailroom.modifiers import Modifier
from temba.msgs.models import Broadcast, Msg
from temba.schedules.models import Schedule
from temba.tests.dates import parse_datetime
from temba.tickets.models import Ticket
from temba.utils import json
from temba.utils.uuid import is_uuid, uuid7

event_units = {
    CampaignEvent.UNIT_MINUTES: "minutes",
    CampaignEvent.UNIT_HOURS: "hours",
    CampaignEvent.UNIT_DAYS: "days",
    CampaignEvent.UNIT_WEEKS: "weeks",
}


def clone_flow_definition(definition: dict, dependency_mapping: dict) -> dict:
    """
    Python port of goflow's flow clone (flows/definition/migrations.Clone) for tests. It walks the definition and
    remaps dependency UUIDs - in "uuid"/"*_uuid" properties, UUID-named keys, and UUID strings in arrays - using
    the given mapping, so an imported flow references the objects resolved for the target org.

    Unlike goflow it leaves the flow's own element UUIDs untouched rather than assigning fresh random ones: that
    uniqueness step isn't needed in tests and stable UUIDs are much easier to assert against.
    """

    def remap(node):
        if isinstance(node, dict):
            for key in list(node.keys()):
                value = node[key]
                if (key == "uuid" or key.endswith("_uuid")) and isinstance(value, str):
                    node[key] = dependency_mapping.get(value, value)
                # test cheap O(1) membership before is_uuid()'s try/except, which runs on every key otherwise
                elif key in dependency_mapping and is_uuid(key):
                    node[dependency_mapping[key]] = node.pop(key)
            for value in node.values():
                remap(value)
        elif isinstance(node, list):
            for i, value in enumerate(node):
                if isinstance(value, str) and is_uuid(value):
                    node[i] = dependency_mapping.get(value, value)
                elif isinstance(value, (dict, list)):
                    remap(value)

    clone = copy.deepcopy(definition)
    remap(clone)
    return clone


# maps the action property holding an asset reference to its goflow dependency type. "groups"/"labels" hold lists
# of references, the rest hold a single reference object. mirrors the reference-typed fields on goflow's actions
# (flows/actions/*.go); types not consumed by Flow.update_dependencies (e.g. classifier) are intentionally omitted.
_INSPECT_ACTION_REFS = {
    "groups": "group",
    "labels": "label",
    "field": "field",
    "flow": "flow",
    "channel": "channel",
    "llm": "llm",
    "topic": "topic",
    "template": "template",
}

# contact field and global references read out of expressions. goflow resolves a field key as the segment after a
# "fields" lookup at any of its context paths (fields/contact.fields/parent.fields/child.fields/...), so the key
# is always what follows "fields." regardless of prefix; "globals.x" is a global. see goflow inspect/templates.go.
_INSPECT_EXPR_REFS = re.compile(r"\b(fields|globals)\.([a-zA-Z][a-zA-Z0-9_]*)")

# matches goflow's utils.Snakify: collapse runs of non-(letter/digit/underscore) to "_", trim, lowercase.
_INSPECT_SNAKE = re.compile(r"[^\w]+", re.UNICODE)


def _snakify(text: str) -> str:
    return _INSPECT_SNAKE.sub("_", text.strip()).lower()


def inspect_flow(definition: dict) -> dict:
    """
    Pragmatic Python stand-in for goflow's flow inspection (flows/inspect), used by TestClient to fake
    flow/inspect during tests. It reproduces the two parts of the analysis that rapidpro consumes or asserts on:

      - dependencies: the typed asset references that goflow's actions/routers enumerate, plus the field/global
        references in expressions (used by Flow.save_revision / Flow.import_definition to wire up dependencies)
      - results: the result specs that save-result actions and routers produce (stored on the flow and exposed
        via the API/editor)

    It is deliberately not a full port: goflow's issue analysis, structural validation, counts and locals aren't
    reproduced. A test that needs those stubs mr_mocks.flow_inspect (or, for validation errors, mr_mocks.exception)
    instead. Every dependency comes back missing=False and no issues are reported, since we don't resolve the
    references we find against the org's actual assets.
    """

    deps = []
    deps_seen = set()
    results = []
    results_by_key = {}

    def add_dep(dep_type: str, *, uuid: str = None, key: str = None, name: str = ""):
        identity = uuid if uuid is not None else key
        if identity is None or (dep_type, identity) in deps_seen:
            return
        deps_seen.add((dep_type, identity))
        ref = {"type": dep_type, "name": name or "", "missing": False}
        ref["uuid" if uuid is not None else "key"] = identity
        deps.append(ref)

    def add_typed_ref(dep_type: str, ref):
        if isinstance(ref, dict):
            add_dep(dep_type, uuid=ref.get("uuid"), key=ref.get("key"), name=ref.get("name", ""))

    def scan_expressions(value):
        if isinstance(value, str):
            for namespace, key in _INSPECT_EXPR_REFS.findall(value):
                add_dep("field" if namespace == "fields" else "global", key=key.lower())
        elif isinstance(value, list):
            for item in value:
                scan_expressions(item)
        elif isinstance(value, dict):
            for item in value.values():
                scan_expressions(item)

    def add_result(node_uuid: str, name: str, categories: list):
        # merge by snakified key, accumulating categories and the nodes that save the result (as goflow does)
        key = _snakify(name)
        spec = results_by_key.get(key)
        if spec is None:
            spec = {"key": key, "name": name, "categories": list(categories), "node_uuids": [node_uuid]}
            results_by_key[key] = spec
            results.append(spec)
        else:
            for category in categories:
                if category not in spec["categories"]:
                    spec["categories"].append(category)
            if node_uuid not in spec["node_uuids"]:
                spec["node_uuids"].append(node_uuid)

    for node in definition.get("nodes", []):
        node_uuid = node.get("uuid")
        for action in node.get("actions", []):
            for prop, dep_type in _INSPECT_ACTION_REFS.items():
                if prop in action:
                    value = action[prop]
                    refs = value if isinstance(value, list) else [value]
                    for ref in refs:
                        add_typed_ref(dep_type, ref)
            if action.get("type") == "set_run_result":
                category = action.get("category")
                add_result(node_uuid, action["name"], [category] if category else [])
            scan_expressions(action)

        router = node.get("router")
        if router:
            scan_expressions(router.get("operand"))
            # only a has_group router test produces a dependency: arguments are [group_uuid] or [group_uuid, name]
            for case in router.get("cases", []):
                if case.get("type") == "has_group" and case.get("arguments"):
                    args = case["arguments"]
                    add_dep("group", uuid=args[0], name=args[1] if len(args) > 1 else "")
            if router.get("result_name"):
                add_result(node_uuid, router["result_name"], [c["name"] for c in router.get("categories", [])])

    return {"dependencies": deps, "issues": [], "results": results, "parent_refs": [], "counts": {}, "locals": []}


class LiveMailroomError(BaseException):
    """
    Raised when a test reaches a live mailroom instead of mocking it. Deliberately subclasses BaseException, not
    Exception, so that application code wrapping mailroom calls in `except Exception` (e.g. smartmin action
    handlers) can't swallow it and mask the violation.
    """


_current_mocks = None


def set_mocks(mocks):
    """
    Sets the mocks that the test client returned by mailroom.get_client() will use. Called by TembaTest.setUp so
    that every test gets its own.
    """

    global _current_mocks

    _current_mocks = mocks


def mock_inspect_query(org, query: str, fields=None) -> mailroom.QueryMetadata:
    def field_ref(f):
        return {"key": f.key, "name": f.name} if isinstance(f, ContactField) else {"key": f}

    tokens = [t.lower() for t in re.split(r"\W+", query) if t]
    attributes = list(sorted({"id", "uuid", "flow", "group", "created_on"}.intersection(tokens)))
    fields = fields if fields is not None else org.fields.filter(is_system=False, key__in=tokens)
    schemes = list(sorted(URN.VALID_SCHEMES.intersection(tokens)))

    return mailroom.QueryMetadata(
        attributes=attributes,
        fields=[field_ref(f) for f in fields],
        groups=[],
        schemes=schemes,
        allow_as_group=not {"id", "flow", "group", "history", "status"}.intersection(tokens),
    )


class Mocks:
    def __init__(self):
        self.calls = defaultdict(list)
        self._contact_export = []
        self._contact_export_preview = []
        self._contact_parse_query = {}
        self._contact_search = {}
        self._contact_urns = []
        self._flow_change_language = []
        self._flow_inspect = []
        self._flow_migrate = []
        self._flow_start_preview = []
        self._llm_translate = []
        self._msg_broadcast_preview = []
        self._msg_search = []
        self._exceptions = []

    def contact_parse_query(self, query, *, cleaned=None, fields=None):
        def mock(org):
            return mailroom.ParsedQuery(
                query=cleaned or query,
                metadata=mock_inspect_query(org, cleaned or query, fields),
            )

        self._contact_parse_query[query] = mock

    def contact_search(self, query, *, cleaned=None, contacts=(), total=0, fields=()):
        def mock(org, offset, sort):
            return mailroom.SearchResults(
                query=cleaned or query,
                total=total or len(contacts),
                contact_uuids=[str(c.uuid) for c in contacts],
                metadata=mock_inspect_query(org, cleaned or query, fields),
            )

        self._contact_search[query] = mock

    def contact_export(self, contact_uuids: list[str]):
        self._contact_export.append(contact_uuids)

    def contact_export_preview(self, total: int):
        self._contact_export_preview.append(total)

    def contact_urns(self, urns: dict):
        self._contact_urns.append(urns)

    def flow_change_language(self, definition: dict):
        """
        Queues the re-based definition that mailroom should return for the next flow_change_language call.
        """

        self._flow_change_language.append(definition)

    def flow_inspect(self, *, dependencies=(), issues=(), results=(), parent_refs=(), counts=None, locals=None):
        self._flow_inspect.append(
            {
                "dependencies": dependencies,
                "issues": issues,
                "results": results,
                "parent_refs": parent_refs,
                "counts": counts if counts is not None else {},
                "locals": locals if locals is not None else [],
            }
        )

    def flow_migrate(self, definition: dict):
        """
        Stubs the migrated definition mailroom should return. Only needed for tests that consume the migrated
        content (e.g. importing the flow); otherwise TestClient.flow_migrate just stamps the given definition.
        """

        self._flow_migrate.append(definition)

    def flow_start_preview(self, query, total):
        def mock(org):
            return mailroom.RecipientsPreview(query=query, total=total)

        self._flow_start_preview.append(mock)

    def llm_translate(self, items: dict):
        self._llm_translate.append(items)

    def msg_broadcast_preview(self, query, total):
        def mock(org):
            return mailroom.RecipientsPreview(query=query, total=total)

        self._msg_broadcast_preview.append(mock)

    def msg_search(self, results: list):
        self._msg_search.append(results)

    def exception(self, exp: Exception):
        """
        Queues an enception to be raised on the next client call
        """

        self._exceptions.append(exp)

    def _check_exception(self):
        if self._exceptions:
            raise self._exceptions.pop(0)


def _client_method(func):
    @functools.wraps(func)
    def wrap(self, *args, **kwargs):
        self.mocks.calls[func.__name__].append(call(*args, **kwargs))
        self.mocks._check_exception()

        return func(self, *args, **kwargs)

    return wrap


class TestClient(MailroomClient):
    """
    The client that mailroom.get_client() returns during tests. It fakes mailroom endpoints against the test
    database, and any endpoint it doesn't fake fails loudly rather than reaching a live mailroom.
    """

    def __init__(self):
        # tests get their mocks from TembaTest.setUp - anything else (e.g. a SimpleTestCase) gets an empty set
        self.mocks = _current_mocks or Mocks()

        super().__init__(settings.MAILROOM_URL, settings.MAILROOM_AUTH_TOKEN)

    def _request(self, endpoint, payload=None, post=True, encode_json=False):
        # reaching here means a client method we haven't faked above, which in production would be an HTTP call
        raise LiveMailroomError(
            f"test reached un-faked mailroom endpoint /mi/{endpoint}; add a fake for it to TestClient"
        )

    @_client_method
    def android_sync(self, channel):
        return {"id": channel.id}

    @_client_method
    def campaign_schedule(self, org, event):
        pass

    @_client_method
    def channel_interrupt(self, org, channel):
        pass

    @_client_method
    def contact_create(self, org, user, contact: mailroom.ContactSpec, via: str):
        status = {v: k for k, v in Contact.ENGINE_STATUSES.items()}[contact.status]
        return create_contact_locally(
            org,
            user,
            name=contact.name,
            language=contact.language,
            status=status,
            urns=contact.urns,
            fields=contact.fields,
            group_uuids=contact.groups,
        )

    @_client_method
    def contact_deindex(self, org, contacts):
        return {"deindexed": len(contacts)}

    @_client_method
    def contact_reindex(self, org, contacts):
        return {"indexed": len(contacts)}

    @_client_method
    def contact_export(self, org, group, query: str) -> list[str]:
        if self.mocks._contact_export:
            return self.mocks._contact_export.pop(0)

        return [str(u) for u in group.contacts.order_by("id").values_list("uuid", flat=True)]

    @_client_method
    def contact_export_preview(self, org, group, query: str) -> int:
        if self.mocks._contact_export_preview:
            return self.mocks._contact_export_preview.pop(0)

        return group.get_member_count()

    @_client_method
    def contact_import(self, org, imp) -> int:
        return imp.batches.count()

    @_client_method
    def contact_modify(self, org, user, contacts, modifiers: list[Modifier], via: str) -> dict:
        apply_modifiers(org, user, contacts, modifiers)

        return {"events": {str(c.uuid): [] for c in contacts}, "skipped": []}

    @_client_method
    def contact_inspect(self, org, contacts) -> dict:
        def inspect(c) -> dict:
            sendable = []
            unsendable = []
            for urn in c.get_urns():
                channel = urn.channel or org.channels.filter(schemes__contains=[urn.scheme]).first()
                if channel:
                    sendable.append(
                        {
                            "channel": {"uuid": str(channel.uuid), "name": channel.name},
                            "scheme": urn.scheme,
                            "path": urn.path,
                            "display": urn.display or "",
                        }
                    )
                else:
                    unsendable.append(
                        {"channel": None, "scheme": urn.scheme, "path": urn.path, "display": urn.display or ""}
                    )

            return {"urns": sendable + unsendable}

        return {c: inspect(c) for c in contacts}

    @_client_method
    def contact_interrupt(self, org, user, contacts):
        # get the waiting session UUIDs
        session_uuids = []
        for contact in contacts:
            if contact.current_session_uuid:
                session = FlowSession.objects.filter(
                    uuid=contact.current_session_uuid, status=FlowSession.STATUS_WAITING
                ).first()
                if session:
                    session_uuids.append(session.uuid)

        exit_sessions(session_uuids, FlowSession.STATUS_INTERRUPTED)

    @_client_method
    def contact_parse_query(self, org, query: str, parse_only: bool = False):
        mock = self.mocks._contact_parse_query.get(query)
        if mock:
            return mock(org)

        return mailroom.ParsedQuery(query=query, metadata=mock_inspect_query(org, query))

    @_client_method
    def contact_populate_group(self, org, group):
        pass

    @_client_method
    def contact_search(self, org, group, query: str, sort: str, offset=0, limit=50, exclude=()):
        mock = self.mocks._contact_search.get(query or "")

        assert mock, f"missing contact_search mock for query '{query}'"

        return mock(org, offset, sort)

    @_client_method
    def contact_urns(self, org, urns: list[str]):
        results = [mailroom.URNResult(normalized=urn, e164=True) for urn in urns]

        if self.mocks._contact_urns:
            result_by_urn = self.mocks._contact_urns.pop(0)
            for i, urn in enumerate(urns):
                result = result_by_urn.get(urn)
                if isinstance(result, str):
                    results[i].error = result
                elif isinstance(result, bool):
                    results[i].e164 = result
                elif isinstance(result, int):
                    results[i].contact_id = result

        return results

    @_client_method
    def flow_change_language(self, definition: dict, language):
        assert self.mocks._flow_change_language, "missing flow_change_language mock"
        return self.mocks._flow_change_language.pop(0)

    @_client_method
    def flow_clone(self, definition: dict, dependency_mapping):
        return clone_flow_definition(definition, dependency_mapping)

    @_client_method
    def flow_inspect(self, org, definition: dict, is_import=False):
        if self.mocks._flow_inspect:
            return self.mocks._flow_inspect.pop(0)

        return inspect_flow(definition)

    @_client_method
    def flow_interrupt(self, org, flow):
        pass

    @_client_method
    def flow_migrate(self, definition: dict, to_version=None):
        # migration is goflow's job and we don't reimplement it. by default just stamp the given definition with
        # the requested spec version - enough to verify that rapidpro requests/handles migration without caring
        # how migration itself works. a test that actually consumes the migrated *content* (e.g. importing and
        # saving the resulting flow) can stub a real current-spec definition via mr_mocks.flow_migrate.
        migrated = dict(self.mocks._flow_migrate[-1] if self.mocks._flow_migrate else definition)
        migrated["spec_version"] = to_version or Flow.CURRENT_SPEC_VERSION
        return migrated

    @_client_method
    def flow_start(self, org, user, typ, flow, groups, contacts, urns, query, exclude, params):
        return create_flowstart(org, user, typ, flow, groups, contacts, urns, query, exclude, params)

    @_client_method
    def flow_start_preview(self, org, flow, include, exclude):
        assert self.mocks._flow_start_preview, "missing flow_start_preview mock"

        mock = self.mocks._flow_start_preview.pop(0)

        return mock(org)

    @_client_method
    def llm_translate(self, llm, source: str, target: str, items: dict[str, list[str]]) -> dict[str, list[str]]:
        assert self.mocks._llm_translate, "missing llm_translate mock"

        return self.mocks._llm_translate.pop(0)

    @_client_method
    def msg_broadcast(
        self,
        org,
        user,
        translations: dict,
        base_language: str,
        groups,
        contacts,
        urns: list,
        query: str,
        exclude: mailroom.Exclusions,
        template,
        template_variables: list,
        schedule: mailroom.ScheduleSpec,
    ):
        return create_broadcast(
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

    @_client_method
    def msg_broadcast_preview(self, org, include, exclude):
        assert self.mocks._msg_broadcast_preview, "missing msg_broadcast_preview mock"

        mock = self.mocks._msg_broadcast_preview.pop(0)

        return mock(org)

    @_client_method
    def msg_archive(self, org, msgs):
        update_msgs_visibility(msgs, Msg.VISIBILITY_VISIBLE, Msg.VISIBILITY_ARCHIVED)

        return {}

    @_client_method
    def msg_delete(self, org, user, msgs):
        delete_msgs(msgs)

        return {}

    @_client_method
    def msg_restore(self, org, msgs):
        update_msgs_visibility(msgs, Msg.VISIBILITY_ARCHIVED, Msg.VISIBILITY_VISIBLE)

        return {}

    @_client_method
    def msg_search(self, org, text: str, contact=None, in_ticket=False) -> list[tuple[Contact, dict]]:
        assert self.mocks._msg_search, "missing msg_search mock"

        return self.mocks._msg_search.pop(0)

    @_client_method
    def msg_resend(self, org, user, msgs):
        return {"msg_uuids": [str(m.uuid) for m in msgs]}

    @_client_method
    def msg_send(self, org, user, contact, text: str, attachments: list[str], quick_replies: list[dict], ticket=None):
        msg = send_to_contact(org, contact, text, attachments, quick_replies)
        msg_json = {
            "channel": {"uuid": str(msg.channel.uuid), "name": msg.channel.name} if msg.channel else None,
            "urn": str(msg.contact_urn) if msg.contact_urn else "",
            "text": msg.text,
        }
        if msg.attachments:
            msg_json["attachments"] = msg.attachments
        if msg.quickreplies:
            msg_json["quick_replies"] = msg.quickreplies

        event_json = {
            "uuid": str(msg.uuid),
            "type": "msg_created",
            "created_on": msg.created_on.isoformat(),
            "msg": msg_json,
        }

        if org.users.filter(id=user.id, is_active=True).exists():
            event_json["_user"] = user.as_engine_ref()

        return {
            "event": event_json,
            "contact": {"uuid": str(msg.contact.uuid), "name": msg.contact.name},
            "status": msg.status,
            "created_on": msg.created_on.isoformat(),
            "modified_on": msg.modified_on.isoformat(),
            "id": msg.id,  # deprecated
        }

    @_client_method
    def notification_publish(self, org, notifications: list[dict]):
        return {}

    @_client_method
    def org_deindex(self, org):
        return {}

    @_client_method
    def org_publish(self, org, event: dict):
        return {}

    @_client_method
    def sim_start(self, payload: dict):
        return {"session": {}, "events": []}

    @_client_method
    def sim_resume(self, payload: dict):
        return {"session": {}, "events": []}

    @_client_method
    def ticket_add_note(self, org, user, tickets, note: str, via: str):
        now = timezone.now()
        tickets = list(Ticket.objects.filter(org=org, id__in=[t.id for t in tickets]))

        for ticket in tickets:
            ticket.modified_on = now
            ticket.last_activity_on = now
            ticket.save(update_fields=("modified_on", "last_activity_on"))

        return {"changed_uuids": [str(t.uuid) for t in tickets]}

    @_client_method
    def ticket_change_assignee(self, org, user, tickets, assignee, via: str):
        now = timezone.now()
        tickets = list(Ticket.objects.filter(org=org, id__in=[t.id for t in tickets]).exclude(assignee=assignee))

        for ticket in tickets:
            ticket.assignee = assignee
            ticket.modified_on = now
            ticket.last_activity_on = now
            ticket.save(update_fields=("assignee", "modified_on", "last_activity_on"))

        return {"changed_uuids": [str(t.uuid) for t in tickets]}

    @_client_method
    def ticket_change_topic(self, org, user, tickets, topic, via: str):
        now = timezone.now()
        tickets = list(Ticket.objects.filter(org=org, id__in=[t.id for t in tickets]).exclude(topic=topic))

        for ticket in tickets:
            ticket.topic = topic
            ticket.modified_on = now
            ticket.last_activity_on = now
            ticket.save(update_fields=("topic", "modified_on", "last_activity_on"))

        return {"changed_uuids": [str(t.uuid) for t in tickets]}

    @_client_method
    def ticket_close(self, org, user, tickets, via: str):
        tickets = list(Ticket.objects.filter(org=org, id__in=[t.id for t in tickets], status=Ticket.STATUS_OPEN))

        for ticket in tickets:
            ticket.status = Ticket.STATUS_CLOSED
            ticket.closed_on = timezone.now()
            ticket.save(update_fields=("status", "closed_on"))

        return {"changed_uuids": [str(t.uuid) for t in tickets]}

    @_client_method
    def ticket_reopen(self, org, user, tickets, via: str):
        tickets = list(Ticket.objects.filter(org=org, id__in=[t.id for t in tickets], status=Ticket.STATUS_CLOSED))

        for ticket in tickets:
            ticket.status = Ticket.STATUS_OPEN
            ticket.closed_on = None
            ticket.save(update_fields=("status", "closed_on"))

        return {"changed_uuids": [str(t.uuid) for t in tickets]}


def mock_mailroom(method=None):
    """
    Convenience decorator which passes the test's mailroom mocks to the test method. The mocked client itself is
    installed for every test (see TembaTest.setUp) - this is just how a test gets at its mocks.
    """

    def actual_decorator(f):
        @wraps(f)
        def wrapper(instance, *args, **kwargs):
            return f(instance, instance.mr_mocks, *args, **kwargs)

        return wrapper

    return actual_decorator(method) if method else actual_decorator


def apply_modifiers(org, user, contacts, modifiers: list):
    """
    Approximates mailroom applying modifiers but doesn't do dynamic group re-evaluation.
    """

    for mod in modifiers:
        fields = dict()

        if mod.type == "name":
            fields = dict(name=mod.name)

        if mod.type == "language":
            fields = dict(language=mod.language)

        if mod.type == "field":
            for c in contacts:
                update_field_locally(user, c, mod.field.key, mod.value, name=mod.field.name)

        elif mod.type == "status":
            if mod.status == "blocked":
                fields = dict(status=Contact.STATUS_BLOCKED)
            elif mod.status == "stopped":
                fields = dict(status=Contact.STATUS_STOPPED)
            elif mod.status == "archived":
                fields = dict(status=Contact.STATUS_ARCHIVED)
            else:
                fields = dict(status=Contact.STATUS_ACTIVE)

        elif mod.type == "groups":
            add = mod.modification == "add"
            for contact in contacts:
                update_groups_locally(contact, [g.uuid for g in mod.groups], add=add)

        elif mod.type == "ticket":
            topic = org.topics.get(uuid=mod.topic.uuid, is_active=True)
            assignee = org.users.get(uuid=mod.assignee.uuid, is_active=True) if mod.assignee else None
            for contact in contacts:
                contact.tickets.create(
                    uuid=uuid7(),
                    org=org,
                    topic=topic,
                    status=Ticket.STATUS_OPEN,
                    assignee=assignee,
                )

        elif mod.type == "urns":
            assert len(contacts) == 1, "should never be trying to bulk update contact URNs"
            assert mod.modification == "set", "should only be setting URNs from here"

            update_urns_locally(contacts[0], mod.urns)

        Contact.objects.filter(id__in=[c.id for c in contacts]).update(
            modified_by=user, modified_on=timezone.now(), **fields
        )

        # like mailroom, ensure that non-active contacts belong to no groups after each modifier
        for c in contacts:
            c.refresh_from_db()
            if c.status != Contact.STATUS_ACTIVE:
                for g in c.get_groups():
                    g.contacts.remove(c)


def contact_urn_lookup(org, urn: str):
    return ContactURN.objects.filter(org=org, identity=URN.identity(urn)).first()


def create_contact_locally(
    org, user, name, language, urns, fields, group_uuids, status=Contact.STATUS_ACTIVE, last_seen_on=None, **kwargs
):
    orphaned_urns = {}

    for i, urn in enumerate(urns):
        existing = contact_urn_lookup(org, urn)
        if existing:
            if existing.contact_id:
                raise mailroom.URNValidationException(f"URN {i} in use by other contact", "taken", i)
            else:
                orphaned_urns[urn] = existing

    contact = Contact.objects.create(
        org=org,
        name=name,
        language=language,
        created_by=user,
        modified_by=user,
        status=status,
        last_seen_on=last_seen_on,
        **kwargs,
    )
    update_urns_locally(contact, urns)
    update_fields_locally(user, contact, fields)
    update_groups_locally(contact, group_uuids, add=True)
    return contact


def derive_msg_folder(msg) -> str:
    """
    Derives the folder for a message from its state, as mailroom and courier do when they write it. In particular this
    pins down the precedence, which matters for states that fall outside the user facing folders entirely: a message
    can be archived or deleted while still pending, and such messages must not appear in the Archived folder.
    """

    if msg.visibility in (Msg.VISIBILITY_DELETED_BY_USER, Msg.VISIBILITY_DELETED_BY_SENDER):
        return Msg.FOLDER_DELETED

    if msg.direction == Msg.DIRECTION_IN:
        if msg.status != Msg.STATUS_HANDLED:
            return Msg.FOLDER_PENDING
        if msg.visibility == Msg.VISIBILITY_ARCHIVED:
            return Msg.FOLDER_ARCHIVED
        return Msg.FOLDER_HANDLED if msg.flow_id else Msg.FOLDER_INBOX
    elif msg.visibility == Msg.VISIBILITY_VISIBLE:
        if msg.status in (Msg.STATUS_INITIALIZING, Msg.STATUS_QUEUED, Msg.STATUS_ERRORED):
            return Msg.FOLDER_OUTBOX
        elif msg.status in (Msg.STATUS_WIRED, Msg.STATUS_SENT, Msg.STATUS_DELIVERED, Msg.STATUS_READ):
            return Msg.FOLDER_SENT
        elif msg.status == Msg.STATUS_FAILED:
            return Msg.FOLDER_FAILED

    raise AssertionError(f"unable to derive folder for msg #{msg.id}")


def delete_msgs(msgs):
    """
    Simulates mailroom soft deleting the given incoming messages - clearing their content and labels as well as
    updating their visibility. Messages which aren't visible or archived are ignored. Note that unlike the visibility
    changes below, mailroom doesn't bump modified_on here.
    """

    for msg in msgs:
        if msg.direction != Msg.DIRECTION_IN or msg.visibility not in (
            Msg.VISIBILITY_VISIBLE,
            Msg.VISIBILITY_ARCHIVED,
        ):
            continue

        msg.visibility = Msg.VISIBILITY_DELETED_BY_USER
        msg.folder = derive_msg_folder(msg)
        msg.text = ""
        msg.attachments = []
        msg.save(update_fields=("visibility", "folder", "text", "attachments"))
        msg.labels.clear()


def update_msgs_visibility(msgs, from_visibility: str, to_visibility: str):
    """
    Simulates mailroom changing the visibility of the given messages, and the folder that follows from it. Messages
    which aren't in the visibility we're transitioning from are ignored.
    """

    for msg in msgs:
        if msg.visibility != from_visibility:
            continue

        msg.visibility = to_visibility
        msg.folder = derive_msg_folder(msg)
        msg.modified_on = timezone.now()
        msg.save(update_fields=("visibility", "folder", "modified_on"))


def update_fields_locally(user, contact, fields):
    for key, val in fields.items():
        update_field_locally(user, contact, key, val)


def update_field_locally(user, contact, key, value, name=None):
    field = ContactField.get_or_create(contact.org, user, key, name=name)

    field_uuid = str(field.uuid)
    if contact.fields is None:
        contact.fields = {}

    if not value:
        value = None
        if field_uuid in contact.fields:
            del contact.fields[field_uuid]

    else:
        field_dict = serialize_field_value(contact, field, value)

        if contact.fields.get(field_uuid) != field_dict:
            contact.fields[field_uuid] = field_dict

    # update our JSONB on our contact
    with connection.cursor() as cursor:
        if value is None:
            # delete the field
            cursor.execute("UPDATE contacts_contact SET fields = fields - %s WHERE id = %s", [field_uuid, contact.id])
        else:
            # update the field
            cursor.execute(
                "UPDATE contacts_contact SET fields = COALESCE(fields,'{}'::jsonb) || %s::jsonb WHERE id = %s",
                [json.dumps({field_uuid: contact.fields[field_uuid]}), contact.id],
            )


def update_urns_locally(contact, urns: list[str]):
    country = contact.org.default_country_code
    priority = ContactURN.PRIORITY_HIGHEST

    urns_created = []  # new URNs created
    urns_attached = []  # existing orphan URNs attached
    urns_retained = []  # existing URNs retained

    for urn_as_string in urns:
        normalized = URN.normalize(urn_as_string, country)
        scheme, path, query, display = URN.to_parts(normalized)
        urn = contact_urn_lookup(contact.org, normalized)

        if not urn:
            urn = ContactURN.objects.create(
                org=contact.org,
                contact=contact,
                identity=URN.identity(normalized),
                scheme=scheme,
                path=path,
                display=display,
                priority=priority,
            )
            urns_created.append(urn)

        # unassigned URN or different contact
        elif not urn.contact or urn.contact != contact:
            urn.contact = contact
            urn.priority = priority
            urn.save()
            urns_attached.append(urn)

        else:
            if urn.priority != priority:
                urn.priority = priority
                urn.save()
            urns_retained.append(urn)

        # step down our priority
        priority -= 1

    # detach any existing URNs that weren't included
    urn_ids = [u.pk for u in (urns_created + urns_attached + urns_retained)]
    urns_detached = ContactURN.objects.filter(contact=contact).exclude(id__in=urn_ids)
    urns_detached.update(contact=None)


def update_groups_locally(contact, group_uuids, add: bool):
    groups = ContactGroup.objects.filter(uuid__in=group_uuids)
    for group in groups:
        assert group.group_type == ContactGroup.TYPE_MANUAL, "can only add/remove contacts to/from manual groups"
        if add:
            group.contacts.add(contact)
        else:
            group.contacts.remove(contact)


def serialize_field_value(contact, field, value):
    org = contact.org

    # parse as all value data types
    str_value = str(value)[:640]
    dt_value = parse_datetime(org, value)
    num_value = parse_number(value)
    loc_value = None

    # for locations, if it has a '>' then it is explicit, look it up that way
    if AdminBoundary.PATH_SEPARATOR in str_value:
        loc_value = parse_location_path(contact.org, str_value)

    # otherwise, try to parse it as a name at the appropriate level
    else:
        if field.value_type == ContactField.TYPE_WARD:
            district_field = org.fields.filter(value_type=ContactField.TYPE_DISTRICT).first()
            district_value = contact.get_field_value(district_field)
            if district_value:
                loc_value = parse_location(org, str_value, AdminBoundary.LEVEL_WARD, district_value)

        elif field.value_type == ContactField.TYPE_DISTRICT:
            state_field = org.fields.filter(value_type=ContactField.TYPE_STATE).first()
            if state_field:
                state_value = contact.get_field_value(state_field)
                if state_value:
                    loc_value = parse_location(org, str_value, AdminBoundary.LEVEL_DISTRICT, state_value)

        elif field.value_type == ContactField.TYPE_STATE:
            loc_value = parse_location(org, str_value, AdminBoundary.LEVEL_STATE)

        if loc_value is not None and len(loc_value) > 0:
            loc_value = loc_value[0]
        else:
            loc_value = None

    # all fields have a text value
    field_dict = {"text": str_value}

    # set all the other fields that have a non-zero value
    if dt_value is not None:
        field_dict["datetime"] = timezone.localtime(dt_value, org.timezone).isoformat()

    if num_value is not None:
        num_as_int = num_value.to_integral_value()
        field_dict["number"] = int(num_as_int) if num_value == num_as_int else num_value

    if loc_value:
        if loc_value.level == AdminBoundary.LEVEL_STATE:
            field_dict["state"] = loc_value.path
        elif loc_value.level == AdminBoundary.LEVEL_DISTRICT:
            field_dict["district"] = loc_value.path
            field_dict["state"] = AdminBoundary.strip_last_path(loc_value.path)
        elif loc_value.level == AdminBoundary.LEVEL_WARD:
            field_dict["ward"] = loc_value.path
            field_dict["district"] = AdminBoundary.strip_last_path(loc_value.path)
            field_dict["state"] = AdminBoundary.strip_last_path(field_dict["district"])

    return field_dict


def parse_number(s):
    parsed = None
    try:
        parsed = Decimal(s)

        if not parsed.is_finite() or parsed > Decimal("999999999999999999999999"):
            parsed = None
    except Exception:
        pass
    return parsed


def parse_location(org, location_string, level, parent=None):
    """
    Simplified version of mailroom's location parsing
    """
    # no country? bail
    if not org.root_location_id or not isinstance(location_string, str):
        return []

    boundary = None

    # try it as a path first if it looks possible
    if level == AdminBoundary.LEVEL_COUNTRY or AdminBoundary.PATH_SEPARATOR in location_string:
        boundary = parse_location_path(org, location_string)
        if boundary:
            boundary = [boundary]

    # try to look up it by full name
    if not boundary:
        boundary = find_boundary_by_name(org, location_string, level, parent)

    # try removing punctuation and try that
    if not boundary:
        bare_name = re.sub(r"\W+", " ", location_string, flags=re.UNICODE).strip()
        boundary = find_boundary_by_name(org, bare_name, level, parent)

    return boundary


def parse_location_path(org, location_string):
    """
    Parses a location path into a single location, returning None if not found
    """
    return (
        AdminBoundary.objects.filter(path__iexact=location_string.strip()).first()
        if org.root_location_id and isinstance(location_string, str)
        else None
    )


def find_boundary_by_name(org, name, level, parent):
    # first check if we have a direct name match
    if parent:
        boundary = parent.children.filter(name__iexact=name, level=level)
    else:
        query = dict(name__iexact=name, level=level)
        query["__".join(["parent"] * level)] = org.root_location
        boundary = AdminBoundary.objects.filter(**query)

    return boundary


def exit_sessions(session_uuids: list, status: str):
    FlowRun.objects.filter(session_uuid__in=session_uuids).update(
        status=status, exited_on=timezone.now(), modified_on=timezone.now()
    )

    contact_uuids = set(FlowSession.objects.filter(uuid__in=session_uuids).values_list("contact_uuid", flat=True))

    FlowSession.objects.filter(uuid__in=session_uuids).update(
        status=status,
        ended_on=timezone.now(),
        current_flow_uuid=None,
    )

    Contact.objects.filter(uuid__in=contact_uuids).update(
        current_session_uuid=None,
        current_flow=None,
        modified_on=timezone.now(),
    )


def resolve_destination(org, contact, channel=None) -> tuple:
    for urn in contact.urns.order_by("priority"):
        if channel:
            return channel, urn
        if urn.channel:
            return urn.channel, urn

        channel = org.channels.filter(is_active=True, schemes__contains=[urn.scheme]).first()
        if channel:
            return channel, urn

    return None, None


def send_to_contact(org, contact, text: str, attachments: list[str], quick_replies: list[dict]) -> Msg:
    channel, contact_urn = resolve_destination(org, contact)

    if contact_urn and channel:
        status = Msg.STATUS_QUEUED
        folder = Msg.FOLDER_OUTBOX
        failed_reason = None
    else:
        contact_urn = None
        channel = None
        status = Msg.STATUS_FAILED
        folder = Msg.FOLDER_FAILED
        failed_reason = Msg.FAILED_NO_DESTINATION

    return Msg.objects.create(
        uuid=uuid7(),
        org=org,
        channel=channel,
        contact=contact,
        contact_urn=contact_urn,
        direction=Msg.DIRECTION_OUT,
        status=status,
        folder=folder,
        failed_reason=failed_reason,
        text=text or "",
        attachments=attachments or [],
        quickreplies=quick_replies,
        msg_type=Msg.TYPE_TEXT,
        is_android=False,
        created_on=timezone.now(),
        modified_on=timezone.now(),
    )


def create_broadcast(
    org,
    user,
    *,
    translations: dict,
    base_language: str,
    groups,
    contacts,
    urns: list,
    query: str,
    exclude: mailroom.Exclusions,
    template,
    template_variables: list,
    schedule,
) -> Broadcast:
    if schedule and isinstance(schedule, mailroom.ScheduleSpec):
        schedule = Schedule.objects.create(
            org=org,
            repeat_period=schedule.repeat_period,
            repeat_days_of_week=schedule.repeat_days_of_week,
            next_fire=schedule.start,
        )

    bcast = Broadcast.objects.create(
        uuid=uuid7(),
        org=org,
        translations=translations,
        base_language=base_language,
        urns=urns,
        query=query,
        exclusions=asdict(exclude) if exclude else None,
        template=template,
        template_variables=template_variables,
        schedule=schedule,
        created_by=user,
        modified_by=user,
    )
    if groups:
        bcast.groups.add(*groups)
    if contacts:
        bcast.contacts.add(*contacts)

    return bcast


def create_flowstart(org, user, typ, flow, groups, contacts, urns, query, exclude, params) -> FlowStart:
    start = FlowStart.objects.create(
        org=org,
        flow=flow,
        start_type=typ,
        urns=list(urns),
        query=query,
        exclusions=asdict(exclude) if exclude else None,
        created_by=user,
        params=params,
    )

    for contact in contacts:
        start.contacts.add(contact)

    for group in groups:
        start.groups.add(group)

    return start
