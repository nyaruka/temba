"""
A log of security-relevant events - sign-ins and failed attempts, credential changes, and changes to who can access a
workspace - written to the temba.audit logger as one JSON object per line, so that whatever collects the process's
output can retain, search and alert on them apart from the rest of the log.

Each entry says what happened, who did it (the signed-in user of the current request, if any), who or what it was done
to, the workspace, and where the request came from. The client address is recorded as the connection's peer plus any
X-Forwarded-For header verbatim, since only the deployment knows which of its entries its own proxies added.
"""

import json
import logging
from contextvars import ContextVar

from django.utils import timezone

logger = logging.getLogger("temba.audit")
_errors = logging.getLogger(__name__)

_request = ContextVar("audit_request", default=None)


class AuditMiddleware:
    """
    Makes the current request available to audit entries recorded while handling it, wherever they're recorded from.
    """

    def __init__(self, get_response=None):
        self.get_response = get_response

    def __call__(self, request):
        token = _request.set(request)
        try:
            return self.get_response(request)
        finally:
            _request.reset(token)


def record(event: str, *, user=None, org=None, actor=None, request=None, **data):
    """
    Records an audit event. The user is who the event is about, e.g. who signed in or was added to a workspace, and
    the actor is who caused it - the signed-in user of the request, which defaults to the one being handled, or else
    the given actor, e.g. when called from a task. Failing to record never fails what's being recorded.
    """

    try:
        _record(event, user=user, org=org, actor=actor, request=request or _request.get(), data=data)
    except Exception:
        _errors.exception("unable to record audit event %s", event)


def _record(event: str, *, user, org, actor, request, data: dict):
    request_user = getattr(request, "user", None) if request else None
    if request_user and request_user.is_authenticated:
        actor = request_user
    org = org or (getattr(request, "org", None) if request else None)

    entry = {"audit": event, "time": timezone.now().isoformat()}

    if actor and actor.is_authenticated:
        entry["actor"] = _user_ref(actor)
    if user:
        entry["user"] = _user_ref(user)
    if org:
        entry["workspace"] = {"uuid": str(org.uuid), "name": org.name}
    if request:
        entry["client"] = {
            "address": request.META.get("REMOTE_ADDR"),
            "forwarded_for": request.META.get("HTTP_X_FORWARDED_FOR"),
            "user_agent": request.META.get("HTTP_USER_AGENT"),
        }
        entry["path"] = request.path
    if data:
        entry["data"] = data

    logger.info(json.dumps(entry, default=str))


def _user_ref(user) -> dict:
    return {"uuid": str(user.uuid), "email": user.email, "staff": user.is_staff}
