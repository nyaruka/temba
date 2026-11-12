from datetime import timedelta
from unittest.mock import Mock

from requests import Request, RequestException

from django.urls import reverse
from django.utils import timezone

from temba.tests import CRUDLTestMixin, TembaTest
from temba.utils.views.mixins import TEMBA_MENU_SELECTION

from .models import HTTPLog
from .tasks import trim_http_logs


class HTTPLogTest(TembaTest):
    def test_trim_logs_task(self):
        HTTPLog.objects.create(
            url="http://org1.bar/zap/?text=" + ("0123456789" * 30),
            request="GET /zap",
            response=" OK 200",
            is_error=False,
            log_type=HTTPLog.WEBHOOK_CALLED,
            request_time=10,
            org=self.org,
            created_on=timezone.now() - timedelta(days=7),
        )
        l2 = HTTPLog.objects.create(
            url="http://org2.bar/zap",
            request="GET /zap",
            response=" OK 200",
            is_error=False,
            log_type=HTTPLog.WEBHOOK_CALLED,
            request_time=10,
            org=self.org,
        )

        trim_http_logs()

        # should only have one log remaining and should be l2
        self.assertEqual(1, HTTPLog.objects.all().count())
        self.assertTrue(HTTPLog.objects.filter(id=l2.id))


class HTTPLogCRUDLTest(TembaTest, CRUDLTestMixin):
    def test_webhooks(self):
        flow = self.create_flow("Test")
        l1 = HTTPLog.objects.create(
            org=self.org,
            log_type="webhook_called",
            url="http://org1.bar/",
            request="GET /zap\nHost: org1.bar\n\n",
            response=" OK 200",
            request_time=10,
            is_error=False,
            flow=flow,
        )

        # log with error
        l2 = HTTPLog.objects.create(
            org=self.org,
            log_type="webhook_called",
            url="http://org1.bar/",
            request="GET /zap\nHost: org1.bar\n\n",
            response=" ERROR 400",
            request_time=10,
            is_error=True,
            flow=flow,
        )

        # log from other org
        HTTPLog.objects.create(
            org=self.org2,
            log_type="webhook_called",
            url="http://org1.bar/",
            request="GET /zap\nHost: org1.bar\n\n",
            response=" OK 200",
            request_time=10,
            is_error=False,
            flow=flow,
        )

        # non-webhook log
        HTTPLog.objects.create(
            org=self.org,
            log_type="intents_synced",
            url="http://org1.bar/",
            request="GET /zap\nHost: org1.bar\n\n",
            response=" OK 200",
            request_time=10,
            is_error=False,
        )

        webhooks_url = reverse("request_logs.httplog_webhooks")
        log_url = reverse("request_logs.httplog_read", args=[l1.id])
        error_log_url = reverse("request_logs.httplog_read", args=[l2.id])

        self.assertRequestDisallowed(webhooks_url, [None, self.agent])
        response = self.assertListFetch(webhooks_url, [self.editor, self.admin], context_objects=[l2, l1])
        self.assertContains(response, "Webhooks")
        self.assertContains(response, log_url)
        self.assertContains(response, error_log_url)
        self.assertContentMenu(webhooks_url, self.admin, ["Errors"])

        response = self.assertListFetch(webhooks_url + "?error=1", [self.editor, self.admin], context_objects=[l2])
        self.assertContains(response, "Failed Webhooks")
        self.assertNotContains(response, log_url)
        self.assertContains(response, error_log_url)
        self.assertContentMenu(webhooks_url + "?error=1", self.admin, ["All logs"])

        # view the individual log item
        self.assertRequestDisallowed(log_url, [None, self.agent, self.admin2])
        response = self.assertReadFetch(log_url, [self.editor, self.admin], context_object=l1)
        self.assertContains(response, "200")
        self.assertContains(response, "org1.bar")

        response = self.assertReadFetch(log_url, [self.editor], context_object=l1)
        self.assertEqual("/flow/history/webhooks", response.headers.get(TEMBA_MENU_SELECTION))

    def test_channel(self):
        ch1 = self.create_channel("WAC", "WhatsApp: 1234", "1234")
        ch2 = self.create_channel("WAC", "WhatsApp: 2345", "2345")

        l1 = HTTPLog.objects.create(
            channel=ch1,
            url="http://org1.bar/zap/?text=" + ("0123456789" * 30),
            request="GET /zap\nHost: org1.bar\n\n",
            response=" OK 200",
            is_error=False,
            log_type=HTTPLog.WHATSAPP_TEMPLATES_SYNCED,
            request_time=10,
            org=self.org,
        )
        l2 = HTTPLog.objects.create(
            channel=ch1,
            url="http://org2.bar/zap",
            request="GET /zap\nHost: org2.bar\n\n",
            response=" OK 200",
            is_error=False,
            log_type=HTTPLog.WHATSAPP_CONTACTS_REFRESHED,
            request_time=10,
            org=self.org,
        )
        HTTPLog.objects.create(
            channel=ch2,
            url="http://org2.bar/zap",
            request="GET /zap\nHost: org2.bar\n\n",
            response=" OK 200",
            is_error=False,
            log_type=HTTPLog.WHATSAPP_TOKENS_SYNCED,
            request_time=10,
            org=self.org,
        )

        list_url = reverse("request_logs.httplog_channel", args=[ch1.uuid])

        self.assertRequestDisallowed(list_url, [None, self.editor, self.agent, self.admin2])

        # the page is a shell for the log list, which fetches the channel's logs itself
        response = self.assertListFetch(list_url, [self.admin], context_objects=[])
        self.assertEqual(f"/api/internal/channel_http_logs.json?channel={ch1.uuid}", response.context["list_url"])
        self.assertContains(response, "<temba-log-list")

        # it can open with one of the channel's logs selected, but not another's
        l1_url = reverse("request_logs.httplog_read", args=[l1.id])
        response = self.requestView(list_url + f"?selected={l1_url}", self.admin)
        self.assertEqual(l1_url, response.context["selected"])

        other_url = reverse("request_logs.httplog_read", args=[l2.id + 1])
        response = self.requestView(list_url + f"?selected={other_url}", self.admin)
        self.assertNotIn("selected", response.context)

    def test_http_log(self):
        channel = self.create_channel("WAC", "WhatsApp: 1234", "1234")
        exception = RequestException(
            "Network is unreachable",
            request=Mock(
                Request,
                method="GET",
                url="https://graph.facebook.com/v22.0/1234/message_templates?access_token=MISSING_WHATSAPP_ADMIN_SYSTEM_USER_TOKEN",
                body=b"{}",
                headers={},
            ),
        )
        start = timezone.now()

        log1 = HTTPLog.from_exception(HTTPLog.WHATSAPP_TEMPLATES_SYNCED, exception, start, channel=channel)

        self.login(self.admin)
        log_url = reverse("request_logs.httplog_read", args=[log1.id])
        response = self.client.get(log_url)
        self.assertContains(response, "200")
        self.assertContains(response, "The connection failed before a response was received.")
        self.assertContains(response, "/v22.0/1234/message_templates")

        log2 = HTTPLog.from_exception(HTTPLog.WHATSAPP_TEMPLATES_SYNCED, exception, start, channel=channel)
        log2_url = reverse("request_logs.httplog_read", args=[log2.id])
        response = self.client.get(log2_url)
        self.assertContains(response, "200")
        self.assertContains(response, "The connection failed before a response was received.")
        self.assertContains(response, "/v22.0/1234/message_templates?access_token=********")

        # and can't be from other org
        self.login(self.admin2)
        response = self.client.get(log_url)
        self.assertPermissionDenied(response)
