"""
Endpoints called by the realtime messaging server that fronts browser WebSockets - server-to-server, never by
browsers directly.

These handle connection authentication and lifecycle: ``connect`` resolves a new connection's identity from the
forwarded session cookie - accepting connections that don't resolve to a user as anonymous - and ``refresh``
periodically re-validates authenticated connections. The ``subscribe`` and ``sub_refresh`` proxies then authorize
individual socket subscriptions: most sockets against the live Django session, but webchat ``chat`` sockets by
capability - the socket name embeds a secret chat-id, so possession of the name is the credential and anonymous
visitors can subscribe to (only) their own chat. A webchat channel configured with ``allowed_domains`` additionally
pins browser embedding to its operator's own sites: the forwarded ``Origin`` of a chat subscription must then match
one of those domains.

Because the realtime server forwards the browser's session cookie, these cookie-authenticated calls are a CSRF
surface: a WebSocket opened by any page the browser user happens to visit would otherwise ride their session. Two
independent layers prevent that. First, the session cookie is ``SameSite=Lax`` (the Django default), so modern
browsers never attach it to a cross-site WebSocket handshake. Second, the realtime server forwards the browser's
``Origin`` header, and a request that resolves to an authenticated session but originates from a host this
deployment doesn't itself serve (judged against ``ALLOWED_HOSTS``, so whitelabel domains pass) is stripped of that
identity: connect accepts the connection as anonymous, refresh expires it, and the subscription proxies deny its
session-based sockets. Together these mean the realtime server's own allowed-origins whitelist can be relaxed - so
webchat widgets can connect from arbitrary third-party sites - without those pages being able to borrow a
visitor's session. A request with no ``Origin`` header at all (a non-browser client, or a proxy config that
doesn't forward it) is treated as before.

Unlike the rest of the internal API (``/api/internal/``), which is called by the editor running in the user's
browser and so *must* be reachable from the public internet, every endpoint here is only ever called by the
realtime messaging server from inside our own network. That means this API can be made truly internal, which is
why it lives under ``/ti/``: serve that prefix only on an internal-only network path (e.g. behind an internal load
balancer) and refuse it at the public edge, so it's never exposed to the internet at all. Like everything under
``/ti/``, it's also gated on the shared secret in ``INTERNAL_AUTH_TOKEN`` (see ``temba.middleware``) - defense in
depth on top of that network isolation, which lets us reject anything that isn't one of our own services even if the
path is ever reachable, but not a substitute for keeping the API off the public internet.
"""

import logging
import re
from urllib.parse import urlsplit

from django_valkey import get_valkey_connection
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response
from rest_framework.views import APIView

from django.conf import settings
from django.http.request import validate_host
from django.utils import timezone

from temba.channels.models import Channel
from temba.channels.types.webchat.views import CONFIG_ALLOWED_DOMAINS
from temba.contacts.models import URN
from temba.tickets.models import Ticket

from ..support import APISessionAuthentication

logger = logging.getLogger(__name__)

# how long (seconds) a connection stays valid before the realtime server must re-validate it via the refresh proxy
CONNECTION_TTL = 5 * 60

# how far ahead (seconds) we set a subscription's expire_at, scheduling the realtime server to call sub_refresh before
# it lapses so we can re-authorize.
SUBSCRIPTION_WINDOW = 60

# how long (seconds) a socket's presence key survives without a refresh. It must comfortably exceed SUBSCRIPTION_WINDOW
# plus the realtime server's refresh delay: the server drives sub_refresh from the expire_at we return (one window),
# but refresh requests can be delayed up to ~1 minute, so consecutive refreshes can be ~SUBSCRIPTION_WINDOW + 60s apart.
# 150s (60s window + ~60s delay + buffer) keeps the key alive across that gap while still expiring within a couple of
# minutes once the last subscriber stops refreshing (there's no unsubscribe callback, so this TTL is the only GC).
SUBSCRIPTION_TTL = 150


class WebSocketsSessionAuthentication(APISessionAuthentication):
    """
    Session auth for the server-to-server proxy calls. The realtime server forwards the browser's session cookie but
    can't present a CSRF token, so we no-op the CSRF check. Identity still comes from the real, signed session cookie,
    and cross-origin protection comes from the cookie's ``SameSite`` policy plus the forwarded-Origin check the
    endpoints apply (see module docs).
    """

    def enforce_csrf(self, request):
        return


class BaseEndpoint(APIView):
    """
    Base class for all websockets API endpoints.
    """

    authentication_classes = (WebSocketsSessionAuthentication,)
    permission_classes = ()  # the shared secret that gates the whole of /ti/ is checked by the middleware
    renderer_classes = (JSONRenderer,)

    def expire_at(self) -> int:
        """Unix time at which the connection should next be re-validated by the refresh proxy."""
        return int(timezone.now().timestamp()) + CONNECTION_TTL

    def is_foreign_origin(self, request) -> bool:
        """
        Whether the request carries a forwarded browser ``Origin`` header whose host isn't one this deployment itself
        serves. A foreign-origin request must never be granted session identity (see module docs). Origins are judged
        against ``ALLOWED_HOSTS`` - the same configuration that already defines which hosts the deployment answers
        for, wildcard entries included - so whitelabel domains pass without a separate list. That also means a
        deployment running with ``ALLOWED_HOSTS = ["*"]`` disables this check entirely - every origin validates -
        leaving the cookie's ``SameSite`` policy as its only cross-origin defense. An absent header (a non-browser
        client, or a proxy config that doesn't forward it) is not foreign; an unparseable or opaque one (e.g.
        ``null``) is.
        """
        origin = request.headers.get("Origin", "")
        if not origin:
            return False

        try:
            host = urlsplit(origin).hostname
        except ValueError:
            host = None

        allowed_hosts = settings.ALLOWED_HOSTS
        if settings.DEBUG and not allowed_hosts:  # mirror the dev fallback Django's own host validation uses
            allowed_hosts = [".localhost", "127.0.0.1", "[::1]"]

        return not (host and validate_host(host, allowed_hosts))


class ConnectEndpoint(BaseEndpoint):
    """
    Connection proxy called by the realtime messaging server when a browser opens a WebSocket. The browser connects
    with no auth token; the realtime server forwards the browser's session cookie (if any) and we resolve the user.

    For a connection that resolves to an authenticated user with a current workspace, the result carries:
      * ``user`` - the user identifier (uuid);
      * ``channels`` - empty: there are no server-side subscriptions. The browser subscribes to every socket it wants
        - its own ``notifications:<org-uuid>:<user-uuid>`` socket, any contact/ticket ``history`` sockets, and any
        ``flow`` sockets for flows open in the editor - through the subscribe proxy, which authorizes each one
        against the live session;
      * ``meta`` - the user's identity (uuids and ids) attached to the connection so the subscription-authorization
        proxies can act on it without re-reading the session; ``meta`` is server-side only and never sent to the browser;
      * ``expire_at`` - when the realtime server should next call the refresh proxy to re-validate the connection.

    Any other connection - no session at all, or a session without a current workspace - is accepted as *anonymous*:
    an empty-string user, no subscriptions, no identity meta, and no ``expire_at``, so the refresh proxy never fires
    for it - there's no session state to re-validate at the connection level. Anonymous connections exist for webchat
    visitors: the subscribe proxy authorizes their ``chat`` sockets by capability - the socket name embeds a secret
    chat-id - and denies them every session-based socket.

    A connection that *does* resolve to a session but arrives from a foreign origin - a forwarded browser ``Origin``
    header for a host this deployment doesn't serve - is also accepted as anonymous rather than being granted the
    session's identity: a third-party page must never be able to ride a visitor's session (see module docs).
    Anonymous connections are origin-agnostic - webchat widgets connect from arbitrary sites by design.
    """

    def post(self, request, *args, **kwargs):
        user = request.user

        # a connection that doesn't resolve to an authenticated user with a current workspace is anonymous
        if not user.is_authenticated or not request.org:
            return Response({"result": {"user": "", "channels": [], "meta": {}}})

        # so is one that resolves to a session but comes from an origin we don't serve - it gets no session identity.
        # That's either a third-party page trying to ride the session or a misconfigured origin, so warn.
        if self.is_foreign_origin(request):
            logger.warning(
                "websockets connect downgraded to anonymous: session presented from foreign origin %s",
                request.headers.get("Origin"),
            )
            return Response({"result": {"user": "", "channels": [], "meta": {}}})

        org = request.org
        meta = {"user_id": user.id, "user_uuid": str(user.uuid), "org_id": org.id, "org_uuid": str(org.uuid)}

        return Response(
            {"result": {"user": str(user.uuid), "channels": [], "meta": meta, "expire_at": self.expire_at()}}
        )


class RefreshEndpoint(BaseEndpoint):
    """
    Refresh proxy called periodically by the realtime messaging server before a connection's ``expire_at``. Only
    authenticated connections get an ``expire_at`` from connect, so this is never called for anonymous connections. We
    re-check that the connection is still valid - the user is still logged in, still has a current workspace, and the
    connection's forwarded ``Origin`` (if any) is still one we serve, matching what ``connect`` requires of an
    authenticated connection - and either extend it with a new ``expire_at`` or let it expire. This is how a logout,
    session expiry, or losing access to the workspace eventually tears down the WebSocket - and a foreign-origin
    refresh expires the connection too, so an authenticated connection can't outlive a tightening of the origin rules
    that would refuse it identity today.
    """

    def post(self, request, *args, **kwargs):
        # mirror connect: a connection is only kept alive while it has an authenticated user with a current workspace
        if not request.user.is_authenticated or not request.org:
            return Response({"result": {"expired": True}})

        # and, as at connect, a foreign origin gets no session identity - without it the connection can't stay
        # authenticated, so it expires
        if self.is_foreign_origin(request):
            logger.warning(
                "websockets connection expired: session presented from foreign origin %s",
                request.headers.get("Origin"),
            )
            return Response({"result": {"expired": True}})

        return Response({"result": {"expire_at": self.expire_at()}})


class SubscriptionEndpoint(BaseEndpoint):
    """
    Base for the socket-subscription proxies (``subscribe`` and ``sub_refresh``). Both authorize a single
    client-requested socket and, when allowed, record the subscription in a valkey index. Most sockets are authorized
    against the live Django session - ``request.user`` and ``request.org`` - deliberately reading the *current*
    workspace rather than anything carried on the connection, so access that has been revoked since connect stops
    working here. The exception is the webchat ``chat`` socket, whose subscribers are anonymous visitors with no
    session at all: its name embeds a secret chat-id, so it's authorized purely by capability - possession of the
    name - against the database.

    We call these subscribable names "sockets" (matching the services that publish to them) rather than the realtime
    server's own term "channel", which is already taken by messaging channels - the ``channel`` fields in the proxy
    request bodies are the realtime server's protocol and keep its naming.
    """

    def subscription_expire_at(self) -> int:
        """Unix time at which the realtime server should next re-check this subscription via the sub_refresh proxy."""
        return int(timezone.now().timestamp()) + SUBSCRIPTION_WINDOW

    # the socket name patterns we authorize, routed to handler methods below with the named groups as kwargs. Like a
    # URL conf, the pattern does all the shape validation: a socket that doesn't fully match a route - unknown
    # namespace, wrong number of segments, or a segment that isn't a canonical lowercase-dashed uuid - is denied before
    # any handler runs, so handlers never see a malformed value (the uuid columns they query would raise on one). Only
    # canonical uuids are accepted because a socket name is an exact string key: events are published to the canonical
    # form, so a subscription to any other encoding could never receive anything anyway. The third element says whether
    # the route is session-based: those handlers only run for an authenticated user with a current workspace and may
    # rely on request.user / request.org - the chat route is capability-based and never touches the session.
    UUID_PATTERN = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    CHAT_ID_PATTERN = r"[a-zA-Z0-9]{24}"  # the secure-random chat-ids courier generates for webchat URN paths
    SOCKET_ROUTES = (
        (
            re.compile(rf"notifications:(?P<org_uuid>{UUID_PATTERN}):(?P<user_uuid>{UUID_PATTERN})"),
            "_notifications_allowed",
            True,
        ),
        (re.compile(rf"org:(?P<org_uuid>{UUID_PATTERN})"), "_org_allowed", True),
        (re.compile(rf"history:(?P<contact_uuid>{UUID_PATTERN})"), "_contact_history_allowed", True),
        (
            re.compile(rf"history:(?P<contact_uuid>{UUID_PATTERN}):(?P<ticket_uuid>{UUID_PATTERN})"),
            "_ticket_history_allowed",
            True,
        ),
        (re.compile(rf"flow:(?P<flow_uuid>{UUID_PATTERN})"), "_flow_allowed", True),
        (
            re.compile(rf"chat:(?P<channel_uuid>{UUID_PATTERN}):(?P<chat_id>{CHAT_ID_PATTERN})"),
            "_chat_allowed",
            False,
        ),
    )

    def is_allowed(self, request, socket: str) -> bool:
        """
        Default-deny authorization of a client-requested socket, routed by matching the socket name against
        ``SOCKET_ROUTES`` - so adding a new socket type later is one route and one handler. Session-based routes are
        denied outright unless the request has an authenticated user with a current workspace *and* isn't from a
        foreign origin - a request the connect proxy would refuse session identity must be refused session-based
        sockets here too, or a third-party page could bypass the connect-time downgrade by subscribing with the same
        forwarded cookie (see module docs) - so their handlers are never reached by an anonymous or foreign-origin
        request. The capability-based chat route never touches the session and so is exempt from the session-identity
        origin check - though the chat handler applies its own per-channel origin restriction (``allowed_domains``).
        """
        if not isinstance(socket, str):  # malformed payload (e.g. a non-string socket) is just a denial, not a 500
            return False

        for pattern, handler, session_based in self.SOCKET_ROUTES:
            match = pattern.fullmatch(socket)  # unlike $ anchoring, fullmatch won't tolerate a trailing newline
            if match:
                if session_based and (
                    not request.user.is_authenticated or not request.org or self.is_foreign_origin(request)
                ):
                    return False

                return getattr(self, handler)(request, **match.groupdict())

        return False

    def _notifications_allowed(self, request, org_uuid: str, user_uuid: str) -> bool:
        """
        ``notifications:<org-uuid>:<user-uuid>`` - a user's own notifications in their current workspace. There's
        nothing to look up: a user may watch exactly the socket scoped to their current org and their own uuid, so we
        just match the requested segments against the live session rather than touching the database.
        """
        return org_uuid == str(request.org.uuid) and user_uuid == str(request.user.uuid)

    def _org_allowed(self, request, org_uuid: str) -> bool:
        """
        ``org:<org-uuid>`` - shared state changes for the current workspace, i.e. renames of assets referenced across the
        UI. Any member of the workspace may watch it. An agent may therefore learn the UUID and new name of any flow or
        group renamed while subscribed, which we accept: there's no listing, no attributes beyond the UUID and the new
        name, and nothing at all about assets that are never renamed.
        """
        return org_uuid == str(request.org.uuid)

    def _contact_history_allowed(self, request, contact_uuid: str) -> bool:
        """
        ``history:<contact-uuid>`` - a contact's history. The contact must belong to the workspace and be active.
        """
        return request.org.contacts.filter(uuid=contact_uuid, is_active=True).exists()

    def _ticket_history_allowed(self, request, contact_uuid: str, ticket_uuid: str) -> bool:
        """
        ``history:<contact-uuid>:<ticket-uuid>`` - a ticket's history. The contact must belong to the workspace and be
        active, and the ticket must in turn belong to that contact - and so to the same workspace, since a ticket
        always shares its contact's org - and the user must actually be allowed to view it: an agent on a
        topic-restricted team can only see tickets in their team's topics, exactly as the ticketing UI scopes them, so
        we authorize through ``Ticket.get_accessible`` rather than just checking the ticket exists.
        """
        org = request.org
        contact = org.contacts.filter(uuid=contact_uuid, is_active=True).first()
        if not contact:
            return False

        return Ticket.get_accessible(org, request.user).filter(uuid=ticket_uuid, contact=contact).exists()

    def _flow_allowed(self, request, flow_uuid: str) -> bool:
        """
        ``flow:<flow-uuid>`` - realtime events for a flow open in the editor (e.g. activity changes). Access mirrors
        the editor's own read views: the flow must belong to the workspace and be active (archived flows can still be
        opened in the editor, so they aren't excluded), and the user must have the ``flows.flow_editor`` permission in
        the workspace.
        """
        if not request.user.has_org_perm(request.org, "flows.flow_editor"):
            return False

        return request.org.flows.filter(uuid=flow_uuid, is_active=True).exists()

    def _chat_allowed(self, request, channel_uuid: str, chat_id: str) -> bool:
        """
        ``chat:<channel-uuid>:<chat-id>`` - a webchat visitor's own chat on a webchat channel. Visitors are anonymous -
        no session, no user - so authorization is capability-based: the chat-id is a secure-random token courier
        generates when the chat starts and stores as the path of the contact's ``webchat:`` URN, so possession of it
        *is* the credential. We allow the socket iff an active webchat channel with that uuid exists and a webchat URN
        with that chat-id exists on that channel for an active contact - and a URN always shares its channel's org, so
        this also scopes the chat to the channel's own workspace. Requiring an active contact means releasing a
        contact closes their chat immediately, rather than only once their URNs are actually purged.

        On top of that credential, a channel configured with ``allowed_domains`` is pinned to its operator's own
        websites: if the request carries a browser ``Origin`` header (forwarded from the WebSocket handshake by the
        realtime server), its host[:port] must match one of the configured entries or the subscription is denied -
        the same restriction courier applies on its webchat HTTP endpoints. An absent header (a non-browser client,
        or a proxy config that doesn't forward it) or an empty config allows as before.
        """
        channel = Channel.objects.filter(uuid=channel_uuid, channel_type="WCH", is_active=True).first()
        if not channel:
            return False

        allowed_domains = channel.config.get(CONFIG_ALLOWED_DOMAINS) or []
        origin = request.headers.get("Origin", "")
        if allowed_domains and origin:
            try:
                host = urlsplit(origin).netloc.lower()  # an origin's netloc is exactly its host[:port]
            except ValueError:
                return False

            if host not in [d.lower() for d in allowed_domains]:
                return False

        return channel.urns.filter(scheme=URN.WEBCHAT_SCHEME, path=chat_id, contact__is_active=True).exists()

    def record_subscription(self, socket: str):
        """
        Mark a socket as having at least one active subscriber by (re)setting a per-socket presence key in valkey
        with a TTL. We track presence only - whether a socket has any subscribers, not who or how many - because the
        consuming service (which publishes a socket's events) only needs to know whether anyone is watching before it
        bothers publishing, so one key per socket is all we keep. Every subscribe and sub_refresh re-sets the key, so
        it stays present while some subscriber keeps refreshing and expires once the last one stops. The realtime
        server has no unsubscribe or disconnect callback, so this TTL is the only garbage collection.

        The key name (``socket-subs:<socket>``) and the presence-via-``EXISTS`` semantics are a contract shared with
        the consuming service that reads it - keep them in sync.
        """
        r = get_valkey_connection()
        r.set(f"socket-subs:{socket}", "1", ex=SUBSCRIPTION_TTL)


class SubscribeEndpoint(SubscriptionEndpoint):
    """
    Subscribe proxy called by the realtime messaging server when a browser asks to subscribe to a socket. The request
    body carries the requested socket name (in its ``channel`` field), which we authorize per its route: most sockets
    against the live session, chat sockets by capability.

    If the request may access the socket, we record the subscription and return an ``expire_at`` so the realtime
    server schedules a sub_refresh. Anything else is refused with a forbidden error, which Centrifugo surfaces to the
    browser as a failed subscribe without tearing down the whole connection - including any session-based socket
    requested by an anonymous connection, which may only subscribe to a chat socket whose secret chat-id it holds.
    """

    def post(self, request, *args, **kwargs):
        socket = request.data.get("channel", "")

        if self.is_allowed(request, socket):
            self.record_subscription(socket)
            return Response({"result": {"expire_at": self.subscription_expire_at()}})

        return Response({"error": {"code": 403, "message": "forbidden"}})


class SubRefreshEndpoint(SubscriptionEndpoint):
    """
    Sub refresh proxy called periodically by the realtime messaging server before a subscription's ``expire_at``. We
    re-run the same authorization as subscribe (access may have been revoked since), and either re-arm the presence key
    and return a fresh ``expire_at`` or let the subscription expire. Only the ``result`` is acted on for refreshes, so
    every not-allowed case - including a session that's gone - is reported as expired rather than as a disconnect.
    """

    def post(self, request, *args, **kwargs):
        socket = request.data.get("channel", "")

        if self.is_allowed(request, socket):
            self.record_subscription(socket)
            return Response({"result": {"expire_at": self.subscription_expire_at()}})

        return Response({"result": {"expired": True}})
