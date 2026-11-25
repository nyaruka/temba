import logging
from dataclasses import asdict

import requests

from django.conf import settings

from temba.contacts.models import Contact
from temba.flows.models import FlowStart
from temba.msgs.models import Broadcast
from temba.utils import json

from ..modifiers import Modifier
from .exceptions import (
    AIServiceException,
    FlowValidationException,
    QueryValidationException,
    RequestException,
    URNValidationException,
)
from .types import (
    ContactSpec,
    Exclusions,
    Inclusions,
    ParsedQuery,
    QueryMetadata,
    RecipientsPreview,
    ScheduleSpec,
    SearchResults,
    URNResult,
)

logger = logging.getLogger(__name__)


class MailroomClient:
    """
    Client for mailroom HTTP endpoints
    """

    default_headers = {"User-Agent": "Temba"}

    def __init__(self, base_url, auth_token):
        self.base_url = base_url
        self.headers = self.default_headers.copy()
        if auth_token:
            self.headers["Authorization"] = "Token " + auth_token

    def android_event(self, org, channel, phone: str, event_type: str, extra: dict, occurred_on):
        return self._request(
            "android/event",
            {
                "org_id": org.id,
                "channel_id": channel.id,
                "phone": phone,
                "event_type": event_type,
                "extra": extra,
                "occurred_on": occurred_on.isoformat(),
            },
        )

    def android_message(self, org, channel, phone: str, text: str, received_on):
        return self._request(
            "android/message",
            {
                "org_id": org.id,
                "channel_id": channel.id,
                "phone": phone,
                "text": text,
                "received_on": received_on.isoformat(),
            },
        )

    def android_sync(self, channel):
        return self._request("android/sync", {"channel_id": channel.id})

    def campaign_schedule(self, org, event):
        self._request("campaign/schedule", {"org_id": org.id, "point_id": event.id})

    def channel_interrupt(self, org, channel):
        self._request("channel/interrupt", {"org_id": org.id, "channel_id": channel.id})

    def contact_create(self, org, user, contact: ContactSpec, via: str) -> Contact:
        resp = self._request(
            "contact/create", {"org_id": org.id, "user_id": user.id, "contact": asdict(contact), "via": via}
        )

        return Contact.objects.get(id=resp["contact"]["id"])

    def contact_deindex(self, org, contacts):
        return self._request(
            "contact/deindex",
            {
                "org_id": org.id,
                "contact_uuids": [str(c.uuid) for c in contacts],
            },
        )

    def contact_reindex(self, org, contacts):
        return self._request(
            "contact/reindex",
            {
                "org_id": org.id,
                "contact_uuids": [str(c.uuid) for c in contacts],
            },
        )

    def contact_export(self, org, group, query: str) -> list[str]:
        resp = self._request("contact/export", {"org_id": org.id, "group_id": group.id, "query": query})

        return resp["contact_uuids"]

    def contact_export_preview(self, org, group, query: str) -> int:
        resp = self._request("contact/export_preview", {"org_id": org.id, "group_id": group.id, "query": query})

        return resp["total"]

    def contact_import(self, org, imp) -> int:
        resp = self._request("contact/import", {"org_id": org.id, "import_id": imp.id})

        return resp["batches"]

    def contact_inspect(self, org, contacts) -> dict:
        resp = self._request("contact/inspect", {"org_id": org.id, "contact_ids": [c.id for c in contacts]})

        return {c: resp[str(c.id)] for c in contacts}

    def contact_interrupt(self, org, user, contacts) -> int:
        self._request(
            "contact/interrupt", {"org_id": org.id, "user_id": user.id, "contact_ids": [c.id for c in contacts]}
        )

    def contact_modify(self, org, user, contacts, modifiers: list[Modifier], via: str):
        return self._request(
            "contact/modify",
            {
                "org_id": org.id,
                "user_id": user.id,
                "contact_ids": [c.id for c in contacts],
                "modifiers": [asdict(m) for m in modifiers],
                "via": via,
            },
        )

    def contact_parse_query(self, org, query: str, parse_only: bool = False) -> ParsedQuery:
        resp = self._request("contact/parse_query", {"org_id": org.id, "query": query, "parse_only": parse_only})

        return ParsedQuery(query=resp["query"], metadata=QueryMetadata(**resp.get("metadata", {})))

    def contact_populate_group(self, org, group):
        self._request("contact/populate_group", {"org_id": org.id, "group_id": group.id})

    def contact_search(self, org, group, query: str, sort: str, offset=0, limit=50, exclude=()) -> SearchResults:
        resp = self._request(
            "contact/search",
            {
                "org_id": org.id,
                "group_id": group.id,
                "exclude_uuids": [str(c.uuid) for c in exclude],
                "query": query,
                "sort": sort,
                "offset": offset,
                "limit": limit,
            },
        )

        return SearchResults(
            query=resp["query"],
            total=resp["total"],
            contact_uuids=resp["contact_uuids"],
            metadata=QueryMetadata(**resp.get("metadata", {})),
        )

    def contact_urns(self, org, urns: list[str]):
        resp = self._request("contact/urns", {"org_id": org.id, "urns": urns})

        return [URNResult(**ur) for ur in resp["urns"]]

    def flow_change_language(self, definition: dict, language):
        return self._request("flow/change_language", {"flow": definition, "language": language}, encode_json=True)

    def flow_clone(self, definition: dict, dependency_mapping):
        return self._request("flow/clone", {"flow": definition, "dependency_mapping": dependency_mapping})

    def flow_inspect(self, org, definition: dict, is_import=False):
        payload = {"flow": definition, "is_import": is_import}

        # can't do dependency checking during tests because mailroom can't see unit test data created in a transaction
        if not settings.TESTING:
            payload["org_id"] = org.id

        return self._request("flow/inspect", payload, encode_json=True)

    def flow_interrupt(self, org, flow):
        self._request("flow/interrupt", {"org_id": org.id, "flow_id": flow.id})

    def flow_migrate(self, definition: dict, to_version=None):
        """
        Migrates a flow definition to the specified spec version
        """
        from temba.flows.models import Flow

        if not to_version:  # pragma: no cover
            to_version = Flow.CURRENT_SPEC_VERSION

        return self._request("flow/migrate", {"flow": definition, "to_version": to_version}, encode_json=True)

    def flow_start(
        self,
        org,
        user,
        typ: str,
        flow,
        groups,
        contacts,
        urns: list,
        query: str,
        exclude: Exclusions,
        params: dict,
    ):
        resp = self._request(
            "flow/start",
            {
                "org_id": org.id,
                "user_id": user.id,
                "type": typ,
                "flow_id": flow.id,
                "group_ids": [g.id for g in groups],
                "contact_ids": [c.id for c in contacts],
                "urns": urns,
                "query": query,
                "exclude": asdict(exclude) if exclude else None,
                "params": params,
            },
        )

        return FlowStart.objects.get(id=resp["id"])

    def flow_start_preview(self, org, flow, include: Inclusions, exclude: Exclusions) -> RecipientsPreview:
        resp = self._request(
            "flow/start_preview",
            {
                "org_id": org.id,
                "flow_id": flow.id,
                "include": asdict(include),
                "exclude": asdict(exclude),
            },
        )

        return RecipientsPreview(query=resp["query"], total=resp["total"])

    def llm_translate(self, llm, source: str, target: str, items: dict[str, list[str]]) -> dict[str, list[str]]:
        resp = self._request(
            "llm/translate",
            {
                "org_id": llm.org_id,
                "llm_id": llm.id,
                "source": source,
                "target": target,
                "items": items,
            },
        )
        return resp["items"]

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
        node_uuid: str,
        exclude: Exclusions,
        optin,
        template,
        template_variables: list,
        schedule: ScheduleSpec,
    ):
        resp = self._request(
            "msg/broadcast",
            {
                "org_id": org.id,
                "user_id": user.id,
                "translations": translations,
                "base_language": base_language,
                "group_ids": [g.id for g in groups],
                "contact_ids": [c.id for c in contacts],
                "urns": urns,
                "query": query,
                "node_uuid": node_uuid,
                "exclude": asdict(exclude) if exclude else None,
                "optin_id": optin.id if optin else None,
                "template_id": template.id if template else None,
                "template_variables": template_variables,
                "schedule": asdict(schedule) if schedule else None,
            },
        )

        return Broadcast.objects.get(id=resp["id"])

    def msg_broadcast_preview(self, org, include: Inclusions, exclude: Exclusions) -> RecipientsPreview:
        resp = self._request(
            "msg/broadcast_preview",
            {
                "org_id": org.id,
                "include": asdict(include),
                "exclude": asdict(exclude),
            },
        )

        return RecipientsPreview(query=resp["query"], total=resp["total"])

    def msg_delete(self, org, user, msgs):
        return self._request(
            "msg/delete", {"org_id": org.id, "user_id": user.id, "msg_uuids": [str(m.uuid) for m in msgs]}
        )

    def msg_handle(self, org, msgs):
        return self._request("msg/handle", {"org_id": org.id, "msg_uuids": [str(m.uuid) for m in msgs]})

    def msg_resend(self, org, user, msgs):
        return self._request(
            "msg/resend",
            {"org_id": org.id, "user_id": user.id, "msg_uuids": [str(m.uuid) for m in msgs]},
        )

    def msg_search(self, org, text: str, contact=None, in_ticket=False) -> list[tuple[Contact, dict]]:
        resp = self._request(
            "msg/search",
            {
                "org_id": org.id,
                "text": text,
                "contact_uuid": str(contact.uuid) if contact else None,
                "in_ticket": in_ticket,
            },
        )

        contact_uuids = {r["contact"]["uuid"] for r in resp["results"]}
        contacts_by_uuid = {
            str(c.uuid): c for c in Contact.objects.filter(org=org, uuid__in=contact_uuids, is_active=True)
        }

        results = []
        for r in resp["results"]:
            if contact := contacts_by_uuid.get(r["contact"]["uuid"]):
                results.append((contact, r["event"]))

        return results

    def msg_send(self, org, user, contact, text: str, attachments: list[str], quick_replies: list[dict], ticket=None):
        return self._request(
            "msg/send",
            {
                "org_id": org.id,
                "user_id": user.id,
                "contact_id": contact.id,
                "text": text,
                "attachments": attachments,
                "quick_replies": quick_replies,
                "ticket_uuid": str(ticket.uuid) if ticket else None,
            },
        )

    def org_deindex(self, org):
        return self._request("org/deindex", {"org_id": org.id})

    def po_export(self, org, flows, language: str):
        return self._request(
            "po/export",
            {
                "org_id": org.id,
                "flow_ids": [f.id for f in flows],
                "language": language,
            },
        )

    def po_import(self, org, flows, language: str, po_data):
        return self._request(
            "po/import",
            {
                "org_id": org.id,
                "flow_ids": [f.id for f in flows],
                "language": language,
            },
            files={"po": po_data},
        )

    def sim_start(self, payload: dict):
        return self._request("sim/start", payload, encode_json=True)

    def sim_resume(self, payload: dict):
        return self._request("sim/resume", payload, encode_json=True)

    def ticket_add_note(self, org, user, tickets, note: str, via: str):
        return self._request(
            "ticket/add_note",
            {
                "org_id": org.id,
                "user_id": user.id,
                "ticket_uuids": [str(t.uuid) for t in tickets],
                "note": note,
                "via": via,
            },
        )

    def ticket_change_assignee(self, org, user, tickets, assignee, via: str):
        return self._request(
            "ticket/change_assignee",
            {
                "org_id": org.id,
                "user_id": user.id,
                "ticket_uuids": [str(t.uuid) for t in tickets],
                "assignee_id": assignee.id if assignee else None,
                "via": via,
            },
        )

    def ticket_change_topic(self, org, user, tickets, topic, via: str):
        return self._request(
            "ticket/change_topic",
            {
                "org_id": org.id,
                "user_id": user.id,
                "ticket_uuids": [str(t.uuid) for t in tickets],
                "topic_uuid": str(topic.uuid),
                "via": via,
            },
        )

    def ticket_close(self, org, user, tickets, via: str):
        return self._request(
            "ticket/close",
            {
                "org_id": org.id,
                "user_id": user.id,
                "ticket_uuids": [str(t.uuid) for t in tickets],
                "via": via,
            },
        )

    def ticket_reopen(self, org, user, tickets, via: str):
        return self._request(
            "ticket/reopen",
            {
                "org_id": org.id,
                "user_id": user.id,
                "ticket_uuids": [str(t.uuid) for t in tickets],
                "via": via,
            },
        )

    def system_errors(self, log, ret, panic):  # pragma: no cover
        return self._request("system/errors", {"log": log, "ret": ret, "panic": panic})

    def system_latency(self) -> list:  # pragma: no cover
        return self._request("system/latency", {}, post=False)

    def system_queues(self) -> dict:  # pragma: no cover
        return self._request("system/queues", {}, post=False)

    def _request(self, endpoint, payload=None, files=None, post=True, encode_json=False):
        if logger.isEnabledFor(logging.DEBUG):  # pragma: no cover
            logger.debug("=============== %s request ===============" % endpoint)
            logger.debug(json.dumps(payload, indent=2))
            logger.debug("=============== /%s request ===============" % endpoint)

        headers = self.headers.copy()
        if files:
            kwargs = dict(data=payload, files=files)
        elif encode_json:
            # do the JSON encoding ourselves - required when the json is something we've loaded with our decoder
            # which could contain non-standard types
            headers["Content-Type"] = "application/json"
            kwargs = dict(data=json.dumps(payload))
        else:
            kwargs = dict(json=payload)

        req_fn = requests.post if post else requests.get
        response = req_fn("%s/mi/%s" % (self.base_url, endpoint), headers=headers, **kwargs)

        if response.headers.get("Content-Type") == "application/json":
            resp_body = response.json()
        else:
            # not all endpoints return JSON, e.g. po file export
            resp_body = response.content

        if response.status_code == 422:
            error = resp_body["error"]
            domain, code = resp_body["code"].split(":")
            extra = resp_body.get("extra", {})

            if domain == "flow":
                raise FlowValidationException(error)
            elif domain == "query":
                raise QueryValidationException(error, code, extra)
            elif domain == "urn":
                raise URNValidationException(error, code, extra["index"])
            elif domain == "ai":
                raise AIServiceException(error, code, extra["instructions"], extra["input"])

        elif 400 <= response.status_code < 600:
            raise RequestException(endpoint, payload, response)

        return resp_body
