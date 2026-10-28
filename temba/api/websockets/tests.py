from django_valkey import get_valkey_connection

from django.conf import settings
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone

from temba.api.tests.mixins import APITestMixin
from temba.api.websockets.views import SUBSCRIPTION_TTL
from temba.orgs.models import OrgRole
from temba.tests import TembaTest
from temba.tickets.models import Team, Topic
from temba.utils.uuid import uuid4

SECRET = "topsecret"


@override_settings(INTERNAL_AUTH_TOKEN=SECRET)
class EndpointsTest(APITestMixin, TembaTest):
    # these endpoints are only served on the internal port
    INTERNAL = {"SERVER_PORT": str(settings.INTERNAL_PORT)}

    def post(self, name, data=None, *, client=None, secret=SECRET, origin=None):
        headers = {"HTTP_AUTHORIZATION": f"Token {secret}"} if secret is not None else {}
        if origin is not None:  # the realtime server forwarding the browser's Origin header
            headers["HTTP_ORIGIN"] = origin
        return (client or self.client).post(
            reverse(name), data or {}, content_type="application/json", **self.INTERNAL, **headers
        )

    def assertExpiry(self, expire_at):
        self.assertIsInstance(expire_at, int)
        self.assertGreater(expire_at, int(timezone.now().timestamp()))

    def assertConnect(self, response, *, user, meta):
        self.assertEqual(200, response.status_code)
        result = response.json()["result"]
        self.assertExpiry(result.pop("expire_at"))
        # connect attaches no server-side subscriptions - the browser subscribes to the sockets it wants itself
        self.assertEqual({"user": str(user.uuid), "channels": [], "meta": meta}, result)

    def assertAnonymousConnect(self, response):
        self.assertEqual(200, response.status_code)
        # an anonymous connection has an empty user, no identity meta, and no expire_at - it never needs re-validating
        # at the connection level, so the refresh proxy is never called for it
        self.assertEqual({"result": {"user": "", "channels": [], "meta": {}}}, response.json())

    def test_connect(self):
        endpoint_url = reverse("api.websockets.connect")

        # GET isn't supported - this endpoint only answers the realtime server's connect POST
        self.login(self.admin)
        self.assertEqual(
            405, self.client.get(endpoint_url, HTTP_AUTHORIZATION=f"Token {SECRET}", **self.INTERNAL).status_code
        )

        # an authenticated user gets no server-side subscriptions (the browser subscribes to its own notifications and
        # any history sockets itself), but their identity is attached to the connection meta
        self.login(self.admin)
        self.assertConnect(
            self.post("api.websockets.connect"),
            user=self.admin,
            meta={
                "user_id": self.admin.id,
                "user_uuid": str(self.admin.uuid),
                "org_id": self.org.id,
                "org_uuid": str(self.org.uuid),
            },
        )

        # meta is scoped per (org, user) - a different user in a different workspace gets their own identity
        self.login(self.admin2, choose_org=self.org2)
        self.assertConnect(
            self.post("api.websockets.connect"),
            user=self.admin2,
            meta={
                "user_id": self.admin2.id,
                "user_uuid": str(self.admin2.uuid),
                "org_id": self.org2.id,
                "org_uuid": str(self.org2.uuid),
            },
        )

        # a user with no current workspace connects as anonymous
        self.login(self.admin)
        session = self.client.session
        del session["org_id"]
        session.save()
        self.assertAnonymousConnect(self.post("api.websockets.connect"))

        # as does a request with no session at all - e.g. a webchat visitor
        self.client.logout()
        self.assertAnonymousConnect(self.post("api.websockets.connect"))

        # because it's a server-to-server POST with no CSRF token, it still works when CSRF checks are enforced
        csrf_client = self.client_class(enforce_csrf_checks=True)
        csrf_client.login(username=self.admin.email, password=self.default_password)
        session = csrf_client.session
        session["org_id"] = self.org.id
        session.save()
        self.assertConnect(
            self.post("api.websockets.connect", client=csrf_client),
            user=self.admin,
            meta={
                "user_id": self.admin.id,
                "user_uuid": str(self.admin.uuid),
                "org_id": self.org.id,
                "org_uuid": str(self.org.uuid),
            },
        )

    @override_settings(ALLOWED_HOSTS=["testserver", ".rapidpro.io"])
    def test_connect_origin(self):
        admin_meta = {
            "user_id": self.admin.id,
            "user_uuid": str(self.admin.uuid),
            "org_id": self.org.id,
            "org_uuid": str(self.org.uuid),
        }

        self.login(self.admin)

        # a session connecting from an origin the deployment itself serves (wildcard entries included, so whitelabel
        # domains pass) gets its full identity
        self.assertConnect(
            self.post("api.websockets.connect", origin="https://app.rapidpro.io"), user=self.admin, meta=admin_meta
        )

        # as does one with no Origin header at all - a non-browser client, or a proxy config that doesn't forward it
        self.assertConnect(self.post("api.websockets.connect"), user=self.admin, meta=admin_meta)

        # but a session presented from a foreign origin is refused its identity - the connection is accepted as
        # anonymous instead, and the downgrade is warned about since it's either an attack or a misconfiguration
        with self.assertLogs("temba.api.websockets.views", level="WARNING") as logs:
            self.assertAnonymousConnect(self.post("api.websockets.connect", origin="https://attacker.example.com"))
        self.assertIn("foreign origin https://attacker.example.com", logs.output[0])

        # an opaque or unparseable origin is foreign too
        with self.assertLogs("temba.api.websockets.views", level="WARNING"):
            self.assertAnonymousConnect(self.post("api.websockets.connect", origin="null"))
        with self.assertLogs("temba.api.websockets.views", level="WARNING"):
            self.assertAnonymousConnect(self.post("api.websockets.connect", origin="https://[invalid"))

        # anonymous connections are origin-agnostic - e.g. webchat widgets connect from arbitrary sites by design - and
        # nothing is downgraded, so nothing is warned about
        self.client.logout()
        with self.assertNoLogs("temba.api.websockets.views", level="WARNING"):
            self.assertAnonymousConnect(self.post("api.websockets.connect", origin="https://attacker.example.com"))

    def test_refresh(self):
        # a still-authenticated connection with a current workspace is extended with a new expiry
        self.login(self.admin)
        response = self.post("api.websockets.refresh")
        self.assertEqual(200, response.status_code)
        self.assertExpiry(response.json()["result"]["expire_at"])

        # losing the current workspace expires the connection (matches connect requiring one)
        session = self.client.session
        del session["org_id"]
        session.save()
        response = self.post("api.websockets.refresh")
        self.assertEqual(200, response.status_code)
        self.assertEqual({"result": {"expired": True}}, response.json())

        # a connection whose session is gone is told it has expired, which tears the connection down
        self.client.logout()
        response = self.post("api.websockets.refresh")
        self.assertEqual(200, response.status_code)
        self.assertEqual({"result": {"expired": True}}, response.json())

    @override_settings(ALLOWED_HOSTS=["testserver", ".rapidpro.io"])
    def test_refresh_origin(self):
        self.login(self.admin)

        # a refresh from an origin the deployment serves, or with no Origin header, extends the connection as before
        for origin in ("https://app.rapidpro.io", None):
            response = self.post("api.websockets.refresh", origin=origin)
            self.assertEqual(200, response.status_code)
            self.assertExpiry(response.json()["result"]["expire_at"])

        # but a foreign origin gets no session identity, so the connection expires rather than persisting - even one
        # that authenticated at connect (e.g. under a config that didn't yet forward the Origin header)
        with self.assertLogs("temba.api.websockets.views", level="WARNING"):
            response = self.post("api.websockets.refresh", origin="https://attacker.example.com")
        self.assertEqual(200, response.status_code)
        self.assertEqual({"result": {"expired": True}}, response.json())

    def test_subscribe(self):
        contact = self.create_contact("Ann", phone="+1234", org=self.org)
        ticket = self.create_ticket(contact)

        # a second contact + ticket in the same workspace, to prove a ticket must belong to the named contact
        contact2 = self.create_contact("Cat", phone="+1236", org=self.org)
        ticket2 = self.create_ticket(contact2)

        # a contact + ticket in another workspace
        other = self.create_contact("Bob", phone="+1235", org=self.org2)
        other_ticket = self.create_ticket(other)

        def subscribe(socket, client="conn-1"):
            return self.post("api.websockets.subscribe", {"channel": socket, "client": client})

        self.login(self.admin)

        # allowed: a contact's history in the current workspace
        response = subscribe(f"history:{contact.uuid}")
        self.assertEqual(200, response.status_code)
        self.assertExpiry(response.json()["result"]["expire_at"])

        # allowed: a ticket's history for that contact
        response = subscribe(f"history:{contact.uuid}:{ticket.uuid}")
        self.assertEqual(200, response.status_code)
        self.assertExpiry(response.json()["result"]["expire_at"])

        def assertForbidden(socket):
            response = subscribe(socket)
            self.assertEqual(200, response.status_code)
            self.assertEqual({"error": {"code": 403, "message": "forbidden"}}, response.json())

        assertForbidden(f"history:{other.uuid}")  # contact in another workspace
        assertForbidden(f"history:{uuid4()}")  # contact not found
        assertForbidden(f"history:{contact.uuid}:{uuid4()}")  # ticket not found for the contact
        assertForbidden(f"history:{contact.uuid}:{ticket2.uuid}")  # ticket belongs to a different contact, same org
        assertForbidden(f"history:{contact.uuid}:{other_ticket.uuid}")  # ticket in another workspace
        assertForbidden(f"history:{other.uuid}:{other_ticket.uuid}")  # both in another workspace
        assertForbidden({"not": "a string"})  # non-string socket is a clean deny, not a 500
        assertForbidden("history:not-a-uuid")  # malformed contact uuid
        assertForbidden(f"history:{contact.uuid}:not-a-uuid")  # malformed ticket uuid
        assertForbidden(f"history:{contact.uuid}\n")  # trailing newline isn't part of the canonical name
        assertForbidden(f"history:{str(contact.uuid).upper()}")  # nor is an uppercase uuid encoding
        assertForbidden(f"history:{contact.uuid}:{ticket.uuid}:extra")  # too many segments
        assertForbidden("history")  # too few segments
        assertForbidden(f"presence:{contact.uuid}")  # unknown namespace

        # an inactive contact is denied
        contact.is_active = False
        contact.save(update_fields=("is_active",))
        assertForbidden(f"history:{contact.uuid}")
        contact.is_active = True
        contact.save(update_fields=("is_active",))

        # a user with no current workspace is forbidden
        session = self.client.session
        del session["org_id"]
        session.save()
        assertForbidden(f"history:{contact.uuid}")

        # an unauthenticated request - e.g. from an anonymous connection - is forbidden: sockets that anonymous
        # connections may subscribe to are authorized elsewhere, never here
        self.client.logout()
        assertForbidden(f"history:{contact.uuid}")

    def test_subscribe_notifications(self):
        def subscribe(socket, client="conn-1"):
            return self.post("api.websockets.subscribe", {"channel": socket, "client": client})

        def assertAllowed(socket):
            response = subscribe(socket)
            self.assertEqual(200, response.status_code)
            self.assertExpiry(response.json()["result"]["expire_at"])

        def assertForbidden(socket):
            response = subscribe(socket)
            self.assertEqual(200, response.status_code)
            self.assertEqual({"error": {"code": 403, "message": "forbidden"}}, response.json())

        self.login(self.admin)

        # a user may watch their own notifications socket for their current workspace
        assertAllowed(f"notifications:{self.org.uuid}:{self.admin.uuid}")

        # but not another user's, even in the same workspace
        assertForbidden(f"notifications:{self.org.uuid}:{self.editor.uuid}")

        # nor their own notifications in a workspace that isn't their current one
        assertForbidden(f"notifications:{self.org2.uuid}:{self.admin.uuid}")

        # malformed: too few or too many segments
        assertForbidden(f"notifications:{self.org.uuid}")
        assertForbidden(f"notifications:{self.org.uuid}:{self.admin.uuid}:extra")

        # a user with no current workspace is forbidden (request.org is None)
        session = self.client.session
        del session["org_id"]
        session.save()
        assertForbidden(f"notifications:{self.org.uuid}:{self.admin.uuid}")

    def test_subscribe_flow(self):
        flow = self.create_flow("Test Flow")
        other_flow = self.create_flow("Other Flow", org=self.org2)

        def subscribe(socket, client="conn-1"):
            return self.post("api.websockets.subscribe", {"channel": socket, "client": client})

        def assertAllowed(socket):
            response = subscribe(socket)
            self.assertEqual(200, response.status_code)
            self.assertExpiry(response.json()["result"]["expire_at"])

        def assertForbidden(socket):
            response = subscribe(socket)
            self.assertEqual(200, response.status_code)
            self.assertEqual({"error": {"code": 403, "message": "forbidden"}}, response.json())

        self.login(self.editor)

        # a user with the flow editor permission may watch a flow in their current workspace
        assertAllowed(f"flow:{flow.uuid}")

        assertForbidden(f"flow:{other_flow.uuid}")  # flow in another workspace
        assertForbidden(f"flow:{uuid4()}")  # flow not found
        assertForbidden("flow:not-a-uuid")  # malformed flow uuid
        assertForbidden(f"flow:{flow.uuid}:extra")  # too many segments
        assertForbidden("flow")  # too few segments

        # an inactive flow is denied
        flow.is_active = False
        flow.save(update_fields=("is_active",))
        assertForbidden(f"flow:{flow.uuid}")
        flow.is_active = True
        flow.save(update_fields=("is_active",))

        # sub_refresh applies the same authorization, so revoked access expires on the next refresh
        response = self.post("api.websockets.sub_refresh", {"channel": f"flow:{flow.uuid}", "client": "conn-1"})
        self.assertEqual(200, response.status_code)
        self.assertExpiry(response.json()["result"]["expire_at"])

        response = self.post("api.websockets.sub_refresh", {"channel": f"flow:{other_flow.uuid}", "client": "conn-1"})
        self.assertEqual(200, response.status_code)
        self.assertEqual({"result": {"expired": True}}, response.json())

        # an agent's role lacks the flow editor permission, so they can't watch any flow
        self.login(self.agent)
        assertForbidden(f"flow:{flow.uuid}")

    def test_subscribe_org(self):
        def subscribe(socket):
            return self.post("api.websockets.subscribe", {"channel": socket, "client": "conn-1"})

        self.login(self.agent)

        response = subscribe(f"org:{self.org.uuid}")
        self.assertEqual(200, response.status_code)
        self.assertExpiry(response.json()["result"]["expire_at"])

        for socket in (
            f"org:{self.org2.uuid}",
            "org:not-a-uuid",
            f"org:{self.org.uuid}:extra",
            "org",
        ):
            response = subscribe(socket)
            self.assertEqual(200, response.status_code)
            self.assertEqual({"error": {"code": 403, "message": "forbidden"}}, response.json())

    @override_settings(ALLOWED_HOSTS=["testserver", ".rapidpro.io"])
    def test_subscribe_origin(self):
        contact = self.create_contact("Ann", phone="+1234", org=self.org)

        def subscribe(socket, origin):
            return self.post("api.websockets.subscribe", {"channel": socket, "client": "conn-1"}, origin=origin)

        self.login(self.admin)

        # a session subscribing from an origin the deployment serves, or with no Origin header, is authorized as usual
        for origin in ("https://app.rapidpro.io", None):
            response = subscribe(f"history:{contact.uuid}", origin)
            self.assertEqual(200, response.status_code)
            self.assertExpiry(response.json()["result"]["expire_at"])

        # but a foreign-origin request gets no session identity here either - a page the connect proxy would only
        # accept as anonymous can't reach session-based sockets by subscribing with the same forwarded cookie
        response = subscribe(f"history:{contact.uuid}", "https://attacker.example.com")
        self.assertEqual(200, response.status_code)
        self.assertEqual({"error": {"code": 403, "message": "forbidden"}}, response.json())

        # and sub_refresh applies the same rule, so such a subscription expires rather than being re-armed
        response = self.post(
            "api.websockets.sub_refresh",
            {"channel": f"history:{contact.uuid}", "client": "conn-1"},
            origin="https://attacker.example.com",
        )
        self.assertEqual(200, response.status_code)
        self.assertEqual({"result": {"expired": True}}, response.json())

    def test_subscribe_ticket_topic_access(self):
        # an agent restricted to a team's topics can only watch the history of tickets they're allowed to view - the
        # same scoping the ticketing UI applies, not just "the ticket exists for this contact"
        sales = Topic.create(self.org, self.admin, "Sales")
        support = Topic.create(self.org, self.admin, "Support")
        sales_team = Team.create(self.org, self.admin, "Sales Team", topics=[sales])
        self.org.add_user(self.agent, OrgRole.AGENT, team=sales_team)

        contact = self.create_contact("Ann", phone="+1234", org=self.org)
        sales_ticket = self.create_ticket(contact, topic=sales)
        support_ticket = self.create_ticket(contact, topic=support, closed_on=timezone.now())
        assigned_ticket = self.create_ticket(contact, topic=support, assignee=self.agent, closed_on=timezone.now())

        def subscribe(socket, *, client="conn-1"):
            return self.post("api.websockets.subscribe", {"channel": socket, "client": client})

        def assertAllowed(socket):
            response = subscribe(socket)
            self.assertEqual(200, response.status_code)
            self.assertExpiry(response.json()["result"]["expire_at"])

        def assertForbidden(socket):
            response = subscribe(socket)
            self.assertEqual(200, response.status_code)
            self.assertEqual({"error": {"code": 403, "message": "forbidden"}}, response.json())

        def sub_refresh(socket, *, client="conn-1"):
            return self.post("api.websockets.sub_refresh", {"channel": socket, "client": client})

        self.login(self.agent)

        # the contact's own history is still allowed (not topic-scoped)
        assertAllowed(f"history:{contact.uuid}")

        # a ticket in the agent's team topic is allowed
        assertAllowed(f"history:{contact.uuid}:{sales_ticket.uuid}")

        # a ticket in a topic outside the agent's team is forbidden - including one assigned to them, because access
        # is decided purely by topic
        assertForbidden(f"history:{contact.uuid}:{support_ticket.uuid}")
        assertForbidden(f"history:{contact.uuid}:{assigned_ticket.uuid}")

        # sub_refresh applies the same topic scoping: a foreign-topic ticket the agent can't view expires rather than
        # being re-armed, so losing access (or never having had it) tears the subscription down on the next refresh
        response = sub_refresh(f"history:{contact.uuid}:{support_ticket.uuid}")
        self.assertEqual(200, response.status_code)
        self.assertEqual({"result": {"expired": True}}, response.json())

        # while a ticket the agent can view is re-armed with a fresh expiry
        response = sub_refresh(f"history:{contact.uuid}:{sales_ticket.uuid}")
        self.assertEqual(200, response.status_code)
        self.assertExpiry(response.json()["result"]["expire_at"])

        # an admin (no team restriction) can watch any of the workspace's tickets
        self.login(self.admin)
        assertAllowed(f"history:{contact.uuid}:{sales_ticket.uuid}")
        assertAllowed(f"history:{contact.uuid}:{support_ticket.uuid}")
        assertAllowed(f"history:{contact.uuid}:{assigned_ticket.uuid}")

    def test_sub_refresh(self):
        contact = self.create_contact("Ann", phone="+1234", org=self.org)
        socket = f"history:{contact.uuid}"

        def sub_refresh(ch=socket, client="conn-1"):
            return self.post("api.websockets.sub_refresh", {"channel": ch, "client": client})

        # still authorized -> the subscription is extended
        self.login(self.admin)
        response = sub_refresh()
        self.assertEqual(200, response.status_code)
        self.assertExpiry(response.json()["result"]["expire_at"])

        # a socket the user may no longer access -> let the subscription expire
        response = sub_refresh(f"history:{uuid4()}")
        self.assertEqual(200, response.status_code)
        self.assertEqual({"result": {"expired": True}}, response.json())

        # access revoked since subscribe (contact deactivated) -> expired
        contact.is_active = False
        contact.save(update_fields=("is_active",))
        response = sub_refresh()
        self.assertEqual(200, response.status_code)
        self.assertEqual({"result": {"expired": True}}, response.json())
        contact.is_active = True
        contact.save(update_fields=("is_active",))

        # losing the current workspace -> expired
        session = self.client.session
        del session["org_id"]
        session.save()
        response = sub_refresh()
        self.assertEqual(200, response.status_code)
        self.assertEqual({"result": {"expired": True}}, response.json())

        # no session at all -> expired (sub_refresh never disconnects)
        self.client.logout()
        response = sub_refresh()
        self.assertEqual(200, response.status_code)
        self.assertEqual({"result": {"expired": True}}, response.json())

    def test_subscription_index(self):
        contact = self.create_contact("Ann", phone="+1234", org=self.org)
        socket = f"history:{contact.uuid}"
        key = f"socket-subs:{socket}"

        r = get_valkey_connection()
        r.delete(key)

        self.login(self.admin)

        # a denied subscription records nothing
        denied = f"history:{uuid4()}"
        denied_key = f"socket-subs:{denied}"
        r.delete(denied_key)
        response = self.post("api.websockets.subscribe", {"channel": denied, "client": "conn-1"})
        self.assertEqual(200, response.status_code)
        self.assertEqual({"error": {"code": 403, "message": "forbidden"}}, response.json())
        self.assertEqual(0, r.exists(denied_key))

        # subscribe sets a per-socket presence flag with a TTL backstop
        response = self.post("api.websockets.subscribe", {"channel": socket, "client": "conn-1"})
        self.assertEqual(200, response.status_code)
        self.assertEqual(b"1", r.get(key))
        self.assertGreater(r.ttl(key), 0)
        self.assertLessEqual(r.ttl(key), SUBSCRIPTION_TTL)

        # sub_refresh re-arms the key's TTL - after it has aged, a refresh sets it back toward the full TTL
        r.expire(key, 5)
        self.assertLessEqual(r.ttl(key), 5)
        response = self.post("api.websockets.sub_refresh", {"channel": socket, "client": "conn-1"})
        self.assertEqual(200, response.status_code)
        self.assertGreater(r.ttl(key), 5)

    def test_secret(self):
        self.login(self.admin)

        # a wrong secret is rejected for the whole API (by the middleware, see its tests), even for an authenticated
        # user, and so is a missing one
        self.assertEqual(403, self.post("api.websockets.connect", secret="open").status_code)
        self.assertEqual(403, self.post("api.websockets.connect", secret=None).status_code)

        # a correct secret doesn't grant an identity - a browser with no session still only connects as anonymous
        self.client.logout()
        self.assertAnonymousConnect(self.post("api.websockets.connect"))

    def test_paths(self):
        # these live under the internal prefix, which is what the URLs reverse to
        self.assertEqual("/ti/websockets/connect", reverse("api.websockets.connect"))
        self.assertEqual("/ti/websockets/sub_refresh", reverse("api.websockets.sub_refresh"))

        self.assertEqual(200, self.post("api.websockets.connect").status_code)
