import json
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import requests

from django.utils import timezone

from temba.channels.models import Channel
from temba.channels.types.external.type import ExternalType
from temba.msgs.models import Msg


class Messenger:
    """
    This test utility installs a EX channel which points to a local server. For message sending and flows to function
    correctly you need to be running both mailroom and courier against the same database and valkey instance, e.g.

    mailroom -db="postgres://temba:temba@localhost:5432/temba?sslmode=disable" -valkey=valkey://localhost:6379/15
    courier -db="postgres://temba:temba@localhost:5432/temba?sslmode=disable" -valkey=valkey://localhost:6379/15 -spool-dir="."

    Outgoing (MT) replies are delivered by courier POSTing to the channel's send URL, so that URL must be reachable
    from wherever courier runs. When courier runs in a different container/host than this server, pass `callback_host`
    as a name courier can resolve (e.g. the container name); it defaults to this host's hostname rather than
    "localhost" so cross-container delivery works out of the box.
    """

    CHANNEL_NAME = "Testing"
    CHANNEL_ROLE = "SR"

    def __init__(self, channel, server, courier_url, callback):
        self.channel = channel
        self.server = server
        self.server.channel = self
        self.courier_url = courier_url
        self.callback = callback

    @classmethod
    def create(
        cls,
        org,
        user,
        courier_url,
        callback,
        country="EC",
        scheme="tel",
        address="123456",
        port=49999,
        callback_host=None,
    ):
        server = cls.Server(port, callback_host or socket.gethostname())

        config = {
            Channel.CONFIG_SEND_URL: f"{server.base_url}/send",
            ExternalType.CONFIG_SEND_METHOD: "POST",
            ExternalType.CONFIG_CONTENT_TYPE: "application/json",
            ExternalType.CONFIG_SEND_BODY: '{"text": "{{text}}"}',
        }

        channel = org.channels.filter(channel_type=ExternalType.code, name=cls.CHANNEL_NAME, is_active=True).first()
        if channel:
            channel.address = address
            channel.config = config
            channel.role = cls.CHANNEL_ROLE
            channel.country = country
            channel.schemes = [scheme]
            channel.save(update_fields=("address", "config", "role", "country", "schemes"))
        else:
            channel = Channel.add_config_external_channel(
                org,
                user,
                country,
                address,
                ExternalType.code,
                config,
                cls.CHANNEL_ROLE,
                [scheme],
                name=cls.CHANNEL_NAME,
            )

        return cls(channel, server, courier_url, callback)

    def incoming(self, sender, text):
        webhook = f"{self.courier_url}/c/ex/{str(self.channel.uuid)}/receive"
        response = requests.post(webhook, data={"from": sender, "text": text, "date": timezone.now().isoformat()})

        if response.status_code != 200:
            raise ValueError(f"courier returned non-200 response: {response.content}")

        payload = response.json()
        return Msg.objects.get(uuid=payload["data"][0]["msg_uuid"])

    def handle_outgoing(self, data):
        return self.callback(data) or "OK"

    def release(self, release_channel=False):
        self.server.shutdown()

        if release_channel:
            self.channel.release(user=self.channel.created_by)

    class Server(ThreadingHTTPServer):
        # Courier sends MT replies from a pool of concurrent workers (its foreman defaults to 32 senders), so this
        # server must handle requests concurrently. A single-threaded HTTPServer processes one send at a time and
        # only backlogs a handful of pending connections, causing courier sends to be refused -> retried with
        # backoff or eventually failed, which shows up as replies arriving delayed or not at all. ThreadingHTTPServer
        # services each send on its own thread; daemon_threads lets those threads die on shutdown.
        daemon_threads = True
        request_queue_size = 64

        def __init__(self, port, host):
            # Bind on all interfaces (not just loopback) so courier can reach the send callback even when it runs
            # in a different container; advertise `host` in base_url so the channel's send URL resolves from there.
            ThreadingHTTPServer.__init__(self, ("0.0.0.0", port), Messenger.Handler)
            self.base_url = f"http://{host}:{port}"
            self.thread = Thread(target=self.serve_forever)
            self.thread.setDaemon(True)
            self.thread.start()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers["content-length"])
            data = json.loads(self.rfile.read(length))

            response = self.server.channel.handle_outgoing(data)
            response = response.encode("utf-8")

            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", len(response))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, format, *args):
            pass
