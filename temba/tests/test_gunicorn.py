import json
import os
from datetime import timedelta
from types import SimpleNamespace

from gunicorn.config import Config

from django.test import SimpleTestCase

from temba.gunicorn import JSONAccessLogger


class JSONAccessLoggerTest(SimpleTestCase):
    def logger(self, **settings) -> JSONAccessLogger:
        cfg = Config()
        for name, value in settings.items():
            cfg.set(name, value)
        return JSONAccessLogger(cfg)

    def log(self, logger, environ: dict, *, status="200 OK", sent=0, headers=(), ms=0.0) -> dict:
        resp = SimpleNamespace(status=status, sent=sent, headers=list(headers))

        with self.assertLogs("gunicorn.access", level="INFO") as captured:
            logger.access(resp, None, environ, timedelta(milliseconds=ms))

        self.assertEqual(1, len(captured.records))
        return json.loads(captured.records[0].getMessage())

    def test_record(self):
        record = self.log(
            self.logger(accesslog="-"),
            {
                "REQUEST_METHOD": "POST",
                "PATH_INFO": "/msg/inbox/",
                "QUERY_STRING": "page=2",
                "SERVER_PROTOCOL": "HTTP/1.1",
                "wsgi.url_scheme": "https",
                "REMOTE_ADDR": "10.0.1.5",
                "HTTP_HOST": "app.example.com",
                "HTTP_X_FORWARDED_FOR": "203.0.113.9, 10.0.1.5",
                "HTTP_USER_AGENT": "Mozilla/5.0",
                "HTTP_REFERER": "https://app.example.com/msg/",
            },
            status="200 OK",
            sent=1512,
            headers=[("Content-Type", "text/html"), ("X-Temba-Workspace", "6f9a1c2e-0000-4000-8000-000000000001")],
            ms=34.7,
        )

        self.assertRegex(record.pop("timestamp"), r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertEqual(
            {
                "http": {
                    "request": {"method": "POST", "header": {"referer": "https://app.example.com/msg/"}},
                    "response": {"status_code": 200, "body": {"size": 1512}},
                },
                "url": {"scheme": "https", "path": "/msg/inbox/", "query": "page=2"},
                "network": {"protocol": {"version": "1.1"}},
                "server": {"address": "app.example.com"},
                "client": {"address": "203.0.113.9"},  # the first forwarded address, not the load balancer's
                "user_agent": {"original": "Mozilla/5.0"},
                "duration_ms": 34.7,
                "process": {"pid": os.getpid()},
                "temba": {"workspace": "6f9a1c2e-0000-4000-8000-000000000001"},
            },
            record,
        )

    def test_absent_fields_are_omitted(self):
        record = self.log(
            self.logger(accesslog="-"),
            {
                "REQUEST_METHOD": "GET",
                "PATH_INFO": "/system/ping/",
                "QUERY_STRING": "",
                "SERVER_PROTOCOL": "HTTP/1.1",
                "wsgi.url_scheme": "http",
                "REMOTE_ADDR": "10.0.1.5",
                "HTTP_HOST": "10.0.1.23:8020",
            },
            status="200 OK",
            sent=2,
        )
        record.pop("timestamp")

        self.assertEqual(
            {
                "http": {"request": {"method": "GET"}, "response": {"status_code": 200, "body": {"size": 2}}},
                "url": {"scheme": "http", "path": "/system/ping/"},
                "network": {"protocol": {"version": "1.1"}},
                "server": {"address": "10.0.1.23:8020"},
                "client": {"address": "10.0.1.5"},  # nothing forwarded, so the peer is the client
                "duration_ms": 0.0,
                "process": {"pid": os.getpid()},
            },
            record,
        )

    def test_client_controlled_values_cant_break_the_line(self):
        hostile = 'Mozilla/5.0" }\n{"http":{"response":{"status_code":200}}, "injected":"yes'

        logger = self.logger(accesslog="-")
        resp = SimpleNamespace(status="404 Not Found", sent=0, headers=[])

        with self.assertLogs("gunicorn.access", level="INFO") as captured:
            logger.access(resp, None, {"REQUEST_METHOD": "GET", "HTTP_USER_AGENT": hostile}, timedelta())

        line = captured.records[0].getMessage()
        self.assertNotIn("\n", line)

        record = json.loads(line)
        self.assertEqual(hostile, record["user_agent"]["original"])
        self.assertEqual(404, record["http"]["response"]["status_code"])
        self.assertNotIn("injected", record)

    def test_nothing_logged_when_access_logging_is_off(self):
        logger = self.logger()
        resp = SimpleNamespace(status="200 OK", sent=0, headers=[])

        with self.assertNoLogs("gunicorn.access"):
            logger.access(resp, None, {"REQUEST_METHOD": "GET"}, timedelta())

    def test_a_bad_record_is_reported_rather_than_raised(self):
        logger = self.logger(accesslog="-")
        resp = SimpleNamespace(status="200 OK", sent=0, headers=[])

        # a duration that isn't one can't be turned into a record
        with self.assertLogs("gunicorn.error", level="ERROR") as captured, self.assertNoLogs("gunicorn.access"):
            logger.access(resp, None, {"REQUEST_METHOD": "GET"}, None)

        self.assertIn("AttributeError", captured.records[0].getMessage())
