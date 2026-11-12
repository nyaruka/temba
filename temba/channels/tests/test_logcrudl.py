from django.conf import settings
from django.urls import reverse

from temba.request_logs.models import HTTPLog
from temba.tests import CRUDLTestMixin, TembaTest

from ..models import ChannelLog


class ChannelLogCRUDLTest(CRUDLTestMixin, TembaTest):
    def assertRedacted(self, response, values: tuple):
        for value in values:
            self.assertNotContains(response, value)

        self.assertContains(response, ChannelLog.REDACT_MASK)

    def assertNotRedacted(self, response, values: tuple):
        for value in values:
            self.assertContains(response, value)

    def test_redaction_for_telegram(self):
        urn = "telegram:3527065"
        contact = self.create_contact("Fred Jones", urns=[urn])
        channel = self.create_channel("TG", "Test TG Channel", "234567")
        log = self.create_channel_log(
            channel,
            ChannelLog.LOG_TYPE_MSG_SEND,
            http_logs=[
                {
                    "url": "https://api.telegram.org/65474/sendMessage",
                    "status_code": 200,
                    "request": "POST /65474/sendMessage HTTP/1.1\r\nHost: api.telegram.org\r\nUser-Agent: Courier/1.2.159\r\nContent-Length: 231\r\nContent-Type: application/x-www-form-urlencoded\r\nAccept-Encoding: gzip\r\n\r\nchat_id=3527065&reply_markup=%7B%22resize_keyboard%22%3Atrue%2C%22one_time_keyboard%22%3Atrue%2C%22keyboard%22%3A%5B%5B%7B%22text%22%3A%22blackjack%22%7D%2C%7B%22text%22%3A%22balance%22%7D%5D%5D%7D&text=Your+balance+is+now+%246.00.",
                    "response": 'HTTP/1.1 200 OK\r\nContent-Length: 298\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length,Content-Type,Date,Server,Connection\r\nConnection: keep-alive\r\nContent-Type: application/json\r\nDate: Tue, 11 Jun 2019 15:33:06 GMT\r\nServer: nginx/1.12.2\r\nStrict-Transport-Security: max-age=31536000; includeSubDomains; preload\r\n\r\n{"ok":true,"result":{"message_id":1440,"from":{"id":678777066,"is_bot":true,"first_name":"textit_staging","username":"textit_staging_bot"},"chat":{"id":3527065,"first_name":"Nic","last_name":"Pottier","username":"Nicpottier","type":"private"},"date":1560267186,"text":"Your balance is now $6.00."}}',
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2022-01-01T00:00:00Z",
                }
            ],
        )
        msg = self.create_incoming_msg(contact, "incoming msg", channel=channel, logs=[log])
        read_url = reverse("channels.channel_logs_read", args=[channel.uuid, "msg", msg.uuid])

        # check read page shows un-redacted content for a regular org
        self.login(self.admin)
        response = self.client.get(read_url)
        self.assertEqual(1, len(response.context["logs"]))
        self.assertNotRedacted(response, ("3527065", "Nic", "Pottier"))

        # but for anon org we see redaction...
        with self.anonymous(self.org):
            response = self.client.get(read_url)
            self.assertRedacted(response, ("3527065", "Nic", "Pottier"))

            # even as customer support
            self.login(self.customer_support, choose_org=self.org)

            response = self.client.get(read_url)
            self.assertRedacted(response, ("3527065", "Nic", "Pottier"))

            # unless we explicitly break out of it
            response = self.client.get(read_url + "?break=1")
            self.assertNotRedacted(response, ("3527065", "Nic", "Pottier"))

    def test_redaction_for_telegram_with_invalid_json(self):
        urn = "telegram:3527065"
        contact = self.create_contact("Fred Jones", urns=[urn])
        channel = self.create_channel("TG", "Test TG Channel", "234567")
        log = self.create_channel_log(
            channel,
            ChannelLog.LOG_TYPE_MSG_SEND,
            http_logs=[
                {
                    "url": "https://api.telegram.org/65474/sendMessage",
                    "status_code": 200,
                    "request": "POST /65474/sendMessage HTTP/1.1\r\nHost: api.telegram.org\r\nUser-Agent: Courier/1.2.159\r\nContent-Length: 231\r\nContent-Type: application/x-www-form-urlencoded\r\nAccept-Encoding: gzip\r\n\r\nchat_id=3527065&reply_markup=%7B%22resize_keyboard%22%3Atrue%2C%22one_time_keyboard%22%3Atrue%2C%22keyboard%22%3A%5B%5B%7B%22text%22%3A%22blackjack%22%7D%2C%7B%22text%22%3A%22balance%22%7D%5D%5D%7D&text=Your+balance+is+now+%246.00.",
                    "response": 'HTTP/1.1 200 OK\r\nContent-Length: 298\r\nContent-Type: application/json\r\n\r\n{"bad_json":true, "first_name": "Nic"',
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2022-01-01T00:00:00Z",
                }
            ],
        )
        msg = self.create_incoming_msg(contact, "incoming msg", channel=channel, logs=[log])
        read_url = reverse("channels.channel_logs_read", args=[channel.uuid, "msg", msg.uuid])

        # check read page shows un-redacted content for a regular org
        self.login(self.admin)
        response = self.client.get(read_url)
        self.assertNotRedacted(response, ("3527065", "Nic"))

        # but for anon org we see redaction...
        with self.anonymous(self.org):
            response = self.client.get(read_url)
            self.assertRedacted(response, ("3527065", "Nic"))

    def test_redaction_for_telegram_when_no_match(self):
        urn = "telegram:3527065"
        contact = self.create_contact("Fred Jones", urns=[urn])
        channel = self.create_channel("TG", "Test TG Channel", "234567")
        log = self.create_channel_log(
            channel,
            ChannelLog.LOG_TYPE_MSG_SEND,
            http_logs=[
                {
                    "url": "https://api.telegram.org/There is no contact identifying information",
                    "status_code": 200,
                    "request": 'POST /65474/sendMessage HTTP/1.1\r\nHost: api.telegram.org\r\nUser-Agent: Courier/1.2.159\r\nContent-Length: 231\r\nContent-Type: application/x-www-form-urlencoded\r\nAccept-Encoding: gzip\r\n\r\n{"json": "There is no contact identifying information"}',
                    "response": 'HTTP/1.1 200 OK\r\nContent-Length: 298\r\nContent-Type: application/json\r\n\r\n{"json": "There is no contact identifying information"}',
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2022-01-01T00:00:00Z",
                }
            ],
        )
        msg = self.create_incoming_msg(contact, "incoming msg", channel=channel, logs=[log])
        read_url = reverse("channels.channel_logs_read", args=[channel.uuid, "msg", msg.uuid])

        # check read page shows un-redacted content for a regular org
        self.login(self.admin)
        response = self.client.get(read_url)
        self.assertNotRedacted(response, ("3527065",))

        # but for anon org we see complete redaction
        with self.anonymous(self.org):
            response = self.client.get(read_url)
            self.assertRedacted(response, ("3527065", "api.telegram.org", "/65474/sendMessage"))

    def test_redaction_for_facebook(self):
        urn = "facebook:2150393045080607"
        contact = self.create_contact("Fred Jones", urns=[urn])
        channel = self.create_channel("FB", "Test FB Channel", "54764868534")
        log = self.create_channel_log(
            channel,
            ChannelLog.LOG_TYPE_MSG_SEND,
            http_logs=[
                {
                    "url": f"https://textit.in/c/fb/{channel.uuid}/receive",
                    "status_code": 200,
                    "request": """POST /c/fb/d1117754-f2ab-4348-9572-996ddc1959a8/receive HTTP/1.1\r\nHost: textit.in\r\nAccept: */*\r\nAccept-Encoding: deflate, gzip\r\nContent-Length: 314\r\nContent-Type: application/json\r\n\r\n{"object":"page","entry":[{"id":"311494332880244","time":1559102364444,"messaging":[{"sender":{"id":"2150393045080607"},"recipient":{"id":"311494332880244"},"timestamp":1559102363925,"message":{"mid":"ld5jgfQP8TLBX9FFc3AETshZgE6Zn5UjpY3vY00t3A_YYC2AYDM3quxaodTiHj7nK6lI_ds4WFUJlTmM2l5xoA","seq":0,"text":"hi"}}]}]}""",
                    "response": """HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Type: application/json\r\n\r\n{"message":"Events Handled","data":[{"type":"msg","channel_uuid":"d1117754-f2ab-4348-9572-996ddc1959a8","msg_uuid":"55a3387b-f97e-4270-8157-7ba781a86411","text":"hi","urn":"facebook:2150393045080607","external_id":"ld5jgfQP8TLBX9FFc3AETshZgE6Zn5UjpY3vY00t3A_YYC2AYDM3quxaodTiHj7nK6lI_ds4WFUJlTmM2l5xoA","received_on":"2019-05-29T03:59:23.925Z"}]}""",
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2022-01-01T00:00:00Z",
                }
            ],
        )
        msg = self.create_incoming_msg(contact, "incoming msg", channel=channel, logs=[log])
        read_url = reverse("channels.channel_logs_read", args=[channel.uuid, "msg", msg.uuid])

        # check read page shows un-redacted content for a regular org
        self.login(self.admin)
        response = self.client.get(read_url)
        self.assertNotRedacted(response, ("2150393045080607",))

        # but for anon org we see redaction...
        with self.anonymous(self.org):
            response = self.client.get(read_url)
            self.assertRedacted(response, ("2150393045080607",))

    def test_redaction_for_facebook_when_no_match(self):
        # in this case we are paranoid and mask everything
        urn = "facebook:2150393045080607"
        contact = self.create_contact("Fred Jones", urns=[urn])
        channel = self.create_channel("FB", "Test FB Channel", "54764868534")
        log = self.create_channel_log(
            channel,
            ChannelLog.LOG_TYPE_MSG_SEND,
            http_logs=[
                {
                    "url": "https://facebook.com/There is no contact identifying information",
                    "status_code": 200,
                    "request": 'POST /65474/sendMessage HTTP/1.1\r\nHost: api.telegram.org\r\nUser-Agent: Courier/1.2.159\r\nContent-Length: 231\r\nContent-Type: application/x-www-form-urlencoded\r\nAccept-Encoding: gzip\r\n\r\n{"json": "There is no contact identifying information"}',
                    "response": 'HTTP/1.1 200 OK\r\nContent-Length: 298\r\nContent-Type: application/json\r\n\r\n{"json": "There is no contact identifying information"}',
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2022-01-01T00:00:00Z",
                }
            ],
        )
        msg = self.create_incoming_msg(contact, "incoming msg", channel=channel, logs=[log])
        read_url = reverse("channels.channel_logs_read", args=[channel.uuid, "msg", msg.uuid])

        # check read page shows un-redacted content for a regular org
        self.login(self.admin)
        response = self.client.get(read_url)
        self.assertNotRedacted(response, ("2150393045080607",))

        # but for anon org we see complete redaction...
        with self.anonymous(self.org):
            response = self.client.get(read_url)
            self.assertRedacted(response, ("2150393045080607", "facebook.com", "/65474/sendMessage"))

    def test_redaction_for_twilio(self):
        contact = self.create_contact("Fred Jones", phone="+593979099111")
        channel = self.create_channel("T", "Test Twilio Channel", "+12345")
        log = self.create_channel_log(
            channel,
            ChannelLog.LOG_TYPE_MSG_SEND,
            http_logs=[
                {
                    "url": "https://textit.in/c/t/1234-5678/status?id=2466753&action=callback",
                    "status_code": 200,
                    "request": "POST /c/t/1234-5678/status?id=86598533&action=callback HTTP/1.1\r\nHost: textit.in\r\nAccept: */*\r\nAccept-Encoding: gzip,deflate\r\nCache-Control: max-age=259200\r\nContent-Length: 237\r\nContent-Type: application/x-www-form-urlencoded; charset=utf-8\r\nUser-Agent: TwilioProxy/1.1\r\nX-Amzn-Trace-Id: Root=1-5d5a10b2-8c8b96c86d45a9c6bdc5f43c\r\nX-Forwarded-For: 54.210.179.19\r\nX-Forwarded-Port: 443\r\nX-Forwarded-Proto: https\r\nX-Twilio-Signature: sdgreh54hehrghssghh55=\r\n\r\nSmsSid=SM357343637&SmsStatus=delivered&MessageStatus=delivered&To=%2B593979099111&MessageSid=SM357343637&AccountSid=AC865965965&From=%2B253262278&ApiVersion=2010-04-01&ToCity=Quito&ToCountry=EC",
                    "response": '{"message":"Status Update Accepted","data":[{"type":"status","channel_uuid":"1234-5678","status":"D","msg_id":2466753}]}\n',
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2022-01-01T00:00:00Z",
                }
            ],
        )
        msg = self.create_outgoing_msg(contact, "Hi", logs=[log])
        read_url = reverse("channels.channel_logs_read", args=[channel.uuid, "msg", msg.uuid])

        # check read page shows un-redacted content for a regular org
        self.login(self.admin)
        response = self.client.get(read_url)
        self.assertNotRedacted(response, ("097 909 9111", "979099111", "Quito"))

        # but for anon org we see redaction...
        with self.anonymous(self.org):
            response = self.client.get(read_url)
            self.assertRedacted(response, ("097 909 9111", "979099111", "Quito"))

    def test_channellog_whatsapp_cloud(self):
        urn = "whatsapp:15128505839"
        contact = self.create_contact("Fred Jones", urns=[urn])
        channel = self.create_channel("WAC", "Test WAC Channel", "54764868534")
        log = self.create_channel_log(
            channel,
            ChannelLog.LOG_TYPE_MSG_SEND,
            http_logs=[
                {
                    "url": f"https://example.com/send/message?access_token={settings.WHATSAPP_ADMIN_SYSTEM_USER_TOKEN}",
                    "status_code": 200,
                    "request": f"""
POST /send/message?access_token={settings.WHATSAPP_ADMIN_SYSTEM_USER_TOKEN} HTTP/1.1
Host: example.com
Accept: */*
Accept-Encoding: gzip;q=1.0,deflate;q=0.6,identity;q=0.3
Content-Length: 343
Content-Type: application/x-www-form-urlencoded
User-Agent: SignalwireCallback/1.0
Authorization: Bearer {settings.WHATSAPP_ADMIN_SYSTEM_USER_TOKEN}
MessageSid=e1d12194-a643-4007-834a-5900db47e262&SmsSid=e1d12194-a643-4007-834a-5900db47e262&AccountSid=<redacted>&From=%2B15618981512&To=%2B15128505839&Body=Hi+Ben+Google+Voice%2C+Did+you+enjoy+your+stay+at+White+Bay+Villas%3F++Answer+with+Yes+or+No.+reply+STOP+to+opt-out.&NumMedia=0&NumSegments=1&MessageStatus=sent""",
                    "response": '{"success": true }',
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2022-01-01T00:00:00Z",
                }
            ],
        )
        self.create_incoming_msg(contact, "incoming msg", channel=channel, logs=[log])
        read_url = reverse("channels.channel_logs_read", args=[channel.uuid, "log", log.uuid])

        self.login(self.admin)

        # the token should have been redacted by courier so blow up rather than let user see it
        with self.assertRaises(AssertionError):
            self.client.get(read_url)

    def test_channellog_anonymous_org_no_msg(self):
        tw_urn = "15128505839"

        tw_channel = self.create_channel("TW", "Test TW Channel", "+12345")

        failed_log = self.create_channel_log(
            tw_channel,
            ChannelLog.LOG_TYPE_MSG_STATUS,
            http_logs=[
                {
                    "url": f"https://textit.in/c/tw/{tw_channel.uuid}/status?action=callback&id=58027120",
                    "status_code": 200,
                    "request": """POST /c/tw/8388f8cd-658f-4fae-925e-ee0792588e68/status?action=callback&id=58027120 HTTP/1.1
Host: textit.in
Accept: */*
Accept-Encoding: gzip;q=1.0,deflate;q=0.6,identity;q=0.3
Content-Length: 343
Content-Type: application/x-www-form-urlencoded
User-Agent: SignalwireCallback/1.0

MessageSid=e1d12194-a643-4007-834a-5900db47e262&SmsSid=e1d12194-a643-4007-834a-5900db47e262&AccountSid=<redacted>&From=%2B15618981512&To=%2B15128505839&Body=Hi+Ben+Google+Voice%2C+Did+you+enjoy+your+stay+at+White+Bay+Villas%3F++Answer+with+Yes+or+No.+reply+STOP+to+opt-out.&NumMedia=0&NumSegments=1&MessageStatus=sent""",
                    "response": """HTTP/1.1 400 Bad Request
Content-Encoding: gzip
Content-Type: application/json

{"message":"Error","data":[{"type":"error","error":"missing request signature"}]}""",
                    "elapsed_ms": 12,
                    "retries": 0,
                    "created_on": "2022-01-01T00:00:00Z",
                }
            ],
            errors=[{"message": "missing request signature", "code": ""}],
        )

        read_url = reverse("channels.channel_logs_read", args=[tw_channel.uuid, "log", failed_log.uuid])

        self.login(self.admin)
        response = self.client.get(read_url)

        # non anon user can see contact identifying data (in the request)
        self.assertContains(response, tw_urn, count=1)

        with self.anonymous(self.org):
            response = self.client.get(read_url)

            self.assertContains(response, tw_urn, count=0)

            # when we can't identify the contact, the URL (shown twice, as the request's and its tooltip), request and
            # response body are masked
            self.assertContains(response, HTTPLog.REDACT_MASK, count=5)
