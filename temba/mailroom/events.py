from dataclasses import dataclass
from uuid import UUID

from temba.contacts.models import URN, ContactURN
from temba.orgs.models import Org
from temba.users.models import User
from temba.utils import dynamo


@dataclass
class EventTag:
    event_uuid: str
    tag: str
    data: dict


class Event:
    """
    Utility class for working with engine events.
    """

    # engine events
    TYPE_AIRTIME_TRANSFERRED = "airtime_transferred"
    TYPE_BROADCAST_CREATED = "broadcast_created"
    TYPE_CALL_CREATED = "call_created"
    TYPE_CALL_MISSED = "call_missed"
    TYPE_CALL_RECEIVED = "call_received"
    TYPE_CHAT_STARTED = "chat_started"
    TYPE_CONTACT_FIELD_CHANGED = "contact_field_changed"
    TYPE_CONTACT_GROUPS_CHANGED = "contact_groups_changed"
    TYPE_CONTACT_LANGUAGE_CHANGED = "contact_language_changed"
    TYPE_CONTACT_NAME_CHANGED = "contact_name_changed"
    TYPE_CONTACT_STATUS_CHANGED = "contact_status_changed"
    TYPE_CONTACT_URNS_CHANGED = "contact_urns_changed"
    TYPE_IVR_CREATED = "ivr_created"
    TYPE_MSG_CREATED = "msg_created"
    TYPE_MSG_RECEIVED = "msg_received"
    TYPE_OPTIN_REQUESTED = "optin_requested"
    TYPE_OPTIN_STARTED = "optin_started"
    TYPE_OPTIN_STOPPED = "optin_stopped"
    TYPE_RUN_STARTED = "run_started"
    TYPE_RUN_ENDED = "run_ended"
    TYPE_TICKET_ASSIGNED = "ticket_assignee_changed"
    TYPE_TICKET_CLOSED = "ticket_closed"
    TYPE_TICKET_NOTE_ADDED = "ticket_note_added"
    TYPE_TICKET_OPENED = "ticket_opened"
    TYPE_TICKET_REOPENED = "ticket_reopened"
    TYPE_TICKET_TOPIC_CHANGED = "ticket_topic_changed"

    basic_ticket_types = {TYPE_TICKET_CLOSED, TYPE_TICKET_OPENED, TYPE_TICKET_REOPENED}
    all_ticket_types = basic_ticket_types | {TYPE_TICKET_ASSIGNED, TYPE_TICKET_NOTE_ADDED, TYPE_TICKET_TOPIC_CHANGED}

    @classmethod
    def redact_for_org(cls, org: Org, event: dict) -> dict:
        if not org.is_anon or not isinstance(event, dict):
            return event
        if event.get("type") == cls.TYPE_CONTACT_URNS_CHANGED:
            urns = event.get("urns") or []
            event = {**event, "urns": [cls._redact_urn(urn) for urn in urns]}
        return event

    @classmethod
    def _redact_urn(cls, urn) -> str:
        """
        Mask the path but keep `scheme:********` so temba-contact-chat can parse
        contact_urns_changed events (`urn.split(':')[1]`).
        """
        if not isinstance(urn, str):
            return URN.from_parts(URN.EXTERNAL_SCHEME, ContactURN.ANON_MASK)
        try:
            scheme, _path, _query, _display = URN.to_parts(urn)
            return URN.from_parts(scheme, ContactURN.ANON_MASK)
        except ValueError:
            return URN.from_parts(URN.EXTERNAL_SCHEME, ContactURN.ANON_MASK)

    @classmethod
    def _from_item(cls, contact, item: dict) -> dict:
        assert item["OrgID"] == contact.org_id, "org ID mismatch for contact event"

        data = item.get("Data", {})
        if dataGZ := item.get("DataGZ"):
            data |= dynamo.load_jsongz(dataGZ)

        data["uuid"] = item["SK"][4:]  # remove "evt#" prefix
        return data

    @classmethod
    def _tag_from_item(cls, contact, item: dict) -> EventTag:
        assert item["OrgID"] == contact.org_id, "org ID mismatch for contact event tag"

        return EventTag(event_uuid=item["SK"][4:40], tag=item["SK"][41:], data=item.get("Data", {}))

    @classmethod
    def get_by_contact(cls, contact, user, *, before: UUID, after: UUID, ticket: UUID, limit: int) -> list[dict]:
        """
        Fetches events for the given contact either before or after the given event UUID.
        """
        assert (before or after) and not (before and after), "must provide either before or after"

        pk = f"con#{contact.uuid}"
        before_sk = f"evt#{before}" if before else None
        after_sk = f"evt#{after}" if after else None
        events, tags = [], []

        def _item(item: dict) -> bool:
            if item["SK"].count("#") == 1:  # item is an event rather than a tag
                event = cls._from_item(contact, item)

                if cls._include_event(event, ticket):
                    events.append(event)
            else:
                tags.append(cls._tag_from_item(contact, item))

            # Keep going until we reach the limit. Note that because tags are interspersed with events, the last fetched
            # event might not have all its tags yet.. but we always fetch one more event than what we return so the
            # possibly incomplete event will be discarded anyway.
            return len(events) < limit

        cls._query_history(pk, after_sk=after_sk, before_sk=before_sk, limit=limit, callback=_item)
        cls._postprocess_events(contact.org, user, events, tags)

        return events

    @classmethod
    def _query_history(cls, pk: str, *, after_sk: str, before_sk: str, limit: int, callback):
        num_fetches = 0
        next_start_sk = None
        query = dict(Limit=limit, Select="ALL_ATTRIBUTES")

        if after_sk:
            query.update(
                KeyConditionExpression="PK = :pk AND SK > :after_sk",
                ExpressionAttributeValues={":pk": pk, ":after_sk": after_sk},
                ScanIndexForward=True,
            )
        elif before_sk:
            query.update(
                KeyConditionExpression="PK = :pk AND SK < :before_sk",
                ExpressionAttributeValues={":pk": pk, ":before_sk": before_sk},
                ScanIndexForward=False,
            )

        while True:
            assert num_fetches < 100, "too many fetches for history"

            if next_start_sk:  # pragma: no cover
                query["ExclusiveStartKey"] = {"PK": pk, "SK": next_start_sk}

            response = dynamo.HISTORY.query(**query)
            num_fetches += 1

            for item in response.get("Items", []):
                if not callback(item):
                    return

            next_start_sk = response.get("LastEvaluatedKey", {}).get("SK")
            if not next_start_sk:
                return

    @classmethod
    def _include_event(cls, event, ticket_uuid) -> bool:
        if event["type"] in cls.all_ticket_types:
            if ticket_uuid:
                # if we have a ticket this is for the ticket UI, so we want *all* events for *only* that ticket
                event_ticket_uuid = event.get("ticket_uuid", event.get("ticket", {}).get("uuid"))
                return event_ticket_uuid == str(ticket_uuid)
            else:
                # if not then this for the contact read page so only show ticket opened/closed/reopened events
                return event["type"] in cls.basic_ticket_types

        return True

    @classmethod
    def _postprocess_events(cls, org, user: User, events: list[dict], tags: list[EventTag]):
        """
        Post-processes a list of events in place with up to date information from the database.
        """

        # inject tags into their corresponding events
        events_by_uuid = {event["uuid"]: event for event in events}
        for tag in tags:
            if event := events_by_uuid.get(tag.event_uuid):
                if tag.tag == "del":
                    event["_deleted"] = tag.data
                elif tag.tag == "sts":
                    event["_status"] = tag.data

        user_uuids = {event["_user"]["uuid"] for event in events if event.get("_user")}
        users_by_uuid = {str(u.uuid): u for u in org.get_users().filter(uuid__in=user_uuids)}

        # TODO build a more generic mechanism for refreshing all references to things like users, flows.. or put that
        # somewhere else entirely?
        for event in events:
            if "_user" in event and event["_user"]:
                if user := users_by_uuid.get(event["_user"]["uuid"]):
                    event["_user"] = user.as_chat_ref()
                else:
                    event["_user"] = None  # user no longer exists

        for event in events:
            if event["type"] in [cls.TYPE_MSG_CREATED, cls.TYPE_MSG_RECEIVED, cls.TYPE_IVR_CREATED]:
                # older events may have attachments stored as objects rather than encoded strings
                if attachments := event["msg"].get("attachments"):
                    event["msg"]["attachments"] = [
                        f"{a['content_type']}:{a['url']}" if isinstance(a, dict) else a for a in attachments
                    ]

        if org.is_anon:
            for i, event in enumerate(events):
                events[i] = cls.redact_for_org(org, event)
