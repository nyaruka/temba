from unittest.mock import call, patch
from zoneinfo import ZoneInfo

import requests

from django.urls import reverse

from temba import mailroom
from temba.channels.models import Channel
from temba.orgs.models import Org, OrgRole
from temba.tests import CRUDLTestMixin, MockResponse, TembaTest, mock_mailroom

from .models import Template, TemplateTranslation
from .tasks import refresh_channel_templates, refresh_templates
from .templatetags.templates import handlebars


class TemplateTest(TembaTest):
    def test_model(self):
        channel1 = self.create_channel("D3C", "Channel 1", "1234")
        channel2 = self.create_channel("D3C", "Channel 2", "2345")

        hello_eng = TemplateTranslation.get_or_create(
            channel1,
            "hello",
            locale="eng-US",
            status=TemplateTranslation.STATUS_PENDING,
            external_id="1234",
            external_locale="en_US",
            namespace="",
            components=[],
            variables=[],
            is_supported=True,
        )
        self.assertIsNotNone(hello_eng.template)  # should have a template with name hello
        self.assertEqual("hello", hello_eng.template.name)

        modified_on = hello_eng.template.modified_on

        hello_fra = TemplateTranslation.get_or_create(
            channel1,
            "hello",
            locale="fra-FR",
            status=TemplateTranslation.STATUS_PENDING,
            external_id="5678",
            external_locale="fr_FR",
            namespace="",
            components=[],
            variables=[],
            is_supported=True,
        )
        self.assertEqual(hello_fra.template, hello_fra.template)
        self.assertGreater(hello_fra.template.modified_on, modified_on)  # should be updated

        goodbye_fra = TemplateTranslation.get_or_create(
            channel1,
            "goodbye",
            locale="fra-FR",
            status=TemplateTranslation.STATUS_PENDING,
            external_id="6789",
            external_locale="fr_FR",
            namespace="foo_namespace",
            components=[],
            variables=[],
            is_supported=True,
        )
        self.assertNotEqual(hello_fra.template, goodbye_fra.template)
        self.assertTrue("goodbye", goodbye_fra.template.name)

        goodbye_fra_other_channel = TemplateTranslation.get_or_create(
            channel2,
            "goodbye",
            locale="fra-FR",
            status=TemplateTranslation.STATUS_PENDING,
            external_id="6789",
            external_locale="fr_FR",
            namespace="foo_namespace",
            components=[],
            variables=[],
            is_supported=True,
        )
        self.assertNotEqual(goodbye_fra, goodbye_fra_other_channel)
        self.assertEqual(goodbye_fra.template, goodbye_fra_other_channel.template)

        self.assertEqual(2, Template.objects.filter(org=self.org).count())
        self.assertEqual(3, TemplateTranslation.objects.filter(channel=channel1).count())
        self.assertEqual(1, TemplateTranslation.objects.filter(channel=channel2).count())

        hello = hello_eng.template
        self.assertFalse(hello.is_approved())
        self.assertFalse(Template.get_or_create(self.org, "empty").is_approved())

        hello.update_base()
        self.assertEqual(hello_eng, hello.base_translation)

        # changing the base translation's variables makes the others incompatible
        TemplateTranslation.get_or_create(
            channel1,
            "hello",
            locale="eng-US",
            status=TemplateTranslation.STATUS_APPROVED,
            external_id="1234",
            external_locale="en_US",
            namespace="",
            components=[],
            variables=[{"type": "text"}],
            is_supported=True,
        )
        hello_fra.refresh_from_db()
        self.assertFalse(hello_fra.is_compatible)
        self.assertFalse(hello.is_approved())

        hello_fra.status = TemplateTranslation.STATUS_APPROVED
        hello_fra.save(update_fields=("status",))
        self.assertTrue(hello.is_approved())

    def test_refresh_task(self):
        org3 = Org.objects.create(
            name="Nyaruka 3",
            timezone=ZoneInfo("Africa/Kigali"),
            flow_languages=["eng", "kin"],
            created_by=self.admin,
            modified_by=self.admin,
        )
        org3.initialize()
        org3.add_user(self.admin, OrgRole.ADMINISTRATOR)
        org3.suspend()

        org4 = Org.objects.create(
            name="Nyaruka 4",
            timezone=ZoneInfo("Africa/Kigali"),
            flow_languages=["eng", "kin"],
            created_by=self.admin,
            modified_by=self.admin,
        )
        org4.initialize()
        org4.add_user(self.admin, OrgRole.ADMINISTRATOR)
        org4.release(self.admin)

        # channels on restricted orgs are still refreshed
        self.org2.restrict(Org.RESTRICTED_STAFF)
        restricted_channel = self.create_channel(
            "D3C",
            "360Dialog channel",
            address="123",
            country="BR",
            config={
                Channel.CONFIG_BASE_URL: "https://waba-v2.360dialog.io",
                Channel.CONFIG_AUTH_TOKEN: "123456789",
            },
            org=self.org2,
        )

        # channels on suspended org are ignored
        self.create_channel(
            "D3C",
            "360Dialog channel",
            address="234",
            country="BR",
            config={
                Channel.CONFIG_BASE_URL: "https://waba-v2.360dialog.io",
                Channel.CONFIG_AUTH_TOKEN: "123456789",
            },
            org=org3,
        )

        # channels on inactive org are ignored
        self.create_channel(
            "D3C",
            "360Dialog channel",
            address="345",
            country="BR",
            config={
                Channel.CONFIG_BASE_URL: "https://waba-v2.360dialog.io",
                Channel.CONFIG_AUTH_TOKEN: "123456789",
            },
            org=org4,
        )

        # inactive channels are ignored
        self.create_channel(
            "D3C",
            "360Dialog channel",
            address="456",
            country="BR",
            config={
                Channel.CONFIG_BASE_URL: "https://waba-v2.360dialog.io",
                Channel.CONFIG_AUTH_TOKEN: "123456789",
            },
        ).release(self.admin)

        d3c_channel = self.create_channel(
            "D3C",
            "360Dialog channel",
            address="1234",
            country="BR",
            config={
                Channel.CONFIG_BASE_URL: "https://waba-v2.360dialog.io",
                Channel.CONFIG_AUTH_TOKEN: "123456789",
            },
        )

        twa_channel = self.create_channel(
            "TWA",
            "TWilio WhatsAPp channel",
            address="1234",
            country="US",
            config={
                Channel.CONFIG_BASE_URL: "https://example.com/whatsapp",
                Channel.CONFIG_AUTH_TOKEN: "123456789",
            },
        )

        # cron only queues a task per eligible channel (self.channel is Android so has no templates)
        with patch("temba.templates.tasks.refresh_channel_templates.delay") as mock_delay:
            self.assertEqual({"queued": 3}, refresh_templates())

        self.assertCountEqual(
            [call(restricted_channel.id), call(d3c_channel.id), call(twa_channel.id)], mock_delay.call_args_list
        )

    @mock_mailroom
    def test_refresh_channel_task(self, mr_mocks):
        d3c_channel = self.create_channel(
            "D3C",
            "360Dialog channel",
            address="1234",
            country="BR",
            config={
                Channel.CONFIG_BASE_URL: "https://waba-v2.360dialog.io",
                Channel.CONFIG_AUTH_TOKEN: "123456789",
            },
        )

        # mailroom does the sync and records it on the channel
        refresh_channel_templates(d3c_channel.id)

        self.assertEqual([call(self.org, d3c_channel)], mr_mocks.calls["channel_sync_templates"])
        d3c_channel.refresh_from_db()
        self.assertFalse(d3c_channel.last_templates_sync.failed)

        # a failed fetch from the provider is recorded by mailroom, as is a sync already in progress
        mr_mocks.exception(mailroom.RequestException("", "", MockResponse(422, '{"error": "boom"}')))
        refresh_channel_templates(d3c_channel.id)

        mr_mocks.exception(mailroom.RequestException("", "", MockResponse(409, '{"error": "already syncing"}')))
        refresh_channel_templates(d3c_channel.id)

        # other errors, e.g. mailroom being down, are logged as warnings rather than failing the task
        mr_mocks.exception(mailroom.RequestException("", "", MockResponse(500, '{"error": "boom"}')))
        mr_mocks.exception(requests.ConnectionError("connection refused"))
        with patch("logging.Logger.warning") as mock_warning:
            refresh_channel_templates(d3c_channel.id)
            refresh_channel_templates(d3c_channel.id)

        self.assertEqual(
            [
                call(f"error syncing templates for channel #{d3c_channel.id}: boom"),
                call(f"error syncing templates for channel #{d3c_channel.id}: connection refused"),
            ],
            mock_warning.call_args_list,
        )
        self.assertEqual(5, len(mr_mocks.calls["channel_sync_templates"]))

        # channel that has been released since being queued is skipped
        d3c_channel.release(self.admin)

        refresh_channel_templates(d3c_channel.id)

        # as is a channel that no longer exists
        refresh_channel_templates(d3c_channel.id + 1000)

        self.assertEqual(5, len(mr_mocks.calls["channel_sync_templates"]))


class TemplateCRUDLTest(CRUDLTestMixin, TembaTest):
    def test_list(self):
        list_url = reverse("templates.template_list")

        channel = self.create_channel("D3C", "360Dialog channel", address="1234")
        template1 = self.create_template(
            "hello",
            [
                TemplateTranslation(channel=channel, locale="eng-US", status=TemplateTranslation.STATUS_APPROVED),
                TemplateTranslation(channel=channel, locale="spa", status=TemplateTranslation.STATUS_APPROVED),
                TemplateTranslation(channel=self.channel, locale="eng-US", status=TemplateTranslation.STATUS_PENDING),
            ],
        )
        template2 = self.create_template(
            "goodbye", [TemplateTranslation(channel=channel, locale="eng", status=TemplateTranslation.STATUS_PENDING)]
        )
        self.create_template("empty", [])  # templates with no translations shouldn't appear

        # add template and translation in other org
        channel_other_org = self.create_channel("D3C", "360Dialog channel", address="2345", org=self.org2)
        self.create_template(
            "hello",
            [
                TemplateTranslation(
                    channel=channel_other_org,
                    locale="eng",
                    status=TemplateTranslation.STATUS_PENDING,
                )
            ],
            org=self.org2,
        )

        self.assertRequestDisallowed(list_url, [None, self.agent])
        response = self.assertListFetch(list_url, [self.editor, self.admin], context_objects=[template2, template1])

        self.assertContains(response, "goodbye")
        self.assertContains(response, "1 language,")
        self.assertContains(response, "hello")
        self.assertContains(response, "2 languages,")

    def test_read(self):
        channel = self.create_channel("D3C", "360Dialog channel", address="1234")
        template1 = self.create_template(
            "hello",
            [
                TemplateTranslation(
                    channel=channel,
                    locale="eng-US",
                    status=TemplateTranslation.STATUS_PENDING,
                    components=[
                        {
                            "name": "body",
                            "type": "body/text",
                            "content": "Hello {{1}}",
                            "variables": {"1": 0},
                            "params": [{"type": "text"}],
                        }
                    ],
                    variables=[{"type": "text"}],
                ),
                TemplateTranslation(
                    channel=channel,
                    locale="spa",
                    status=TemplateTranslation.STATUS_APPROVED,
                    components=[
                        {
                            "name": "body",
                            "type": "body/text",
                            "content": "Hola {{1}}",
                            "variables": {"1": 0},
                            "params": [{"type": "text"}],
                        }
                    ],
                    variables=[{"type": "text"}],
                    is_supported=False,
                ),
                TemplateTranslation(
                    channel=self.channel,
                    locale="eng-US",
                    status=TemplateTranslation.STATUS_REJECTED,
                    components=[
                        {
                            "name": "body",
                            "type": "body/text",
                            "content": "Hello {{1}}",
                            "variables": {"1": 0},
                            "params": [{"type": "text"}, {"type": "text"}],
                        }
                    ],
                    variables=[{"type": "text"}, {"type": "text"}],
                ),
            ],
        )

        # create translation for other template
        self.create_template(
            "goodbye", [TemplateTranslation(channel=channel, locale="eng", status=TemplateTranslation.STATUS_PENDING)]
        )

        read_url = reverse("templates.template_read", args=[template1.uuid])

        self.assertRequestDisallowed(read_url, [None, self.agent, self.admin2])
        response = self.assertReadFetch(read_url, [self.editor, self.admin], context_object=template1)

        self.assertContains(response, "Hello <code>{{1}}</code>")
        self.assertContains(response, "Hola <code>{{1}}</code>")
        self.assertContains(response, "Uses unsupported component types.")
        self.assertContains(response, "Variable parameters don't match.")
        self.assertNotContains(response, "Goodbye")

    @mock_mailroom
    def test_refresh_templates(self, mr_mocks):
        d3c_channel = self.create_channel(
            "D3C",
            "360Dialog channel",
            address="1234",
            country="BR",
            config={
                Channel.CONFIG_BASE_URL: "https://waba-v2.360dialog.io",
                Channel.CONFIG_AUTH_TOKEN: "123456789",
            },
        )
        twa_channel = self.create_channel(
            "TWA",
            "TWilio WhatsAPp channel",
            address="1234",
            country="US",
            config={
                Channel.CONFIG_BASE_URL: "https://example.com/whatsapp",
                Channel.CONFIG_AUTH_TOKEN: "123456789",
            },
        )

        self.create_channel(
            "D3C",
            "360Dialog channel",
            address="3456",
            country="BR",
            config={
                Channel.CONFIG_BASE_URL: "https://waba-v2.360dialog.io",
                Channel.CONFIG_AUTH_TOKEN: "00123456789",
            },
            org=self.org2,
        )

        sync_templates_url = reverse("templates.template_refresh")

        self.assertRequestDisallowed(sync_templates_url, [None, self.agent])

        self.login(self.admin)

        response = self.client.get(sync_templates_url)
        self.assertContains(response, "Refresh")

        # each of the workspace's channels with templates is synced through mailroom
        response = self.client.post(sync_templates_url, {}, follow=True)
        self.assertEqual(200, response.status_code)
        self.assertToast(response, "info", "Your templates have been fetched and refreshed.")
        self.assertCountEqual(
            [call(self.org, d3c_channel), call(self.org, twa_channel)], mr_mocks.calls["channel_sync_templates"]
        )

        # if one channel fails, others continue, whether it's the provider, mailroom or the connection to it
        for exception in (
            mailroom.RequestException("", "", MockResponse(422, '{"error": "boom"}')),
            mailroom.RequestException("", "", MockResponse(500, '{"error": "boom"}')),
            requests.ConnectionError("connection refused"),
        ):
            mr_mocks.exception(exception)
            num_calls = len(mr_mocks.calls["channel_sync_templates"])

            response = self.client.post(sync_templates_url, {}, follow=True)
            self.assertEqual(200, response.status_code)
            self.assertToast(response, "error", "Unable to refresh all templates. See the log for details.")
            self.assertEqual(num_calls + 2, len(mr_mocks.calls["channel_sync_templates"]))


class TemplateTagsTest(TembaTest):
    def test_handlebars(self):
        self.assertEqual("Hello", handlebars("Hello"))
        self.assertEqual("Hello <code>{{name}}</code>", handlebars("Hello {{name}}"))
