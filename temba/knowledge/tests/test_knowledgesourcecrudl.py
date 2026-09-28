from unittest.mock import call, patch

from django.conf import settings
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test.utils import override_settings
from django.urls import reverse

from temba.knowledge.models import KnowledgeChunk, KnowledgeItem, KnowledgeSource
from temba.orgs.models import Org
from temba.tests import CRUDLTestMixin, TembaTest, cleanup, mock_mailroom


class KnowledgeSourceCRUDLTest(TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        self.system_shortcuts = self.org.sources.get(source_type=KnowledgeSource.TYPE_SHORTCUTS)
        self.system_helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)

    def enable_agents(self, org):
        org.features = [Org.FEATURE_AGENTS]
        org.save(update_fields=("features",))

    def create_chunk(self, source, item_key, text: str):
        return KnowledgeChunk.objects.create(
            source=source, item_key=item_key, item_name="Test", text=text, embedding=[0.0] * 384
        )

    @override_settings(ORG_LIMIT_DEFAULTS={"knowledge": 2})
    def test_menu(self):
        menu_url = reverse("knowledge.knowledgesource_menu")

        # nobody can access if agents feature not enabled
        response = self.requestView(menu_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(menu_url, [None, self.agent])
        self.assertPageMenu(menu_url, self.admin, ["Shortcuts (0)", "Helpdesk", "New Source"])

        # user created sources are unpacked as their own items, ordered by name.. and no other org sources
        website = KnowledgeSource.create_website(self.org, self.admin, "Nyaruka", "https://nyaruka.com")
        KnowledgeSource.create_documents(self.org2, self.admin2, "Other Org")

        self.assertPageMenu(menu_url, self.editor, ["Shortcuts (0)", "Helpdesk", "Nyaruka", "New Source"])

        # no create option when the limit is reached (system rows don't count)
        KnowledgeSource.create_documents(self.org, self.admin, "Guides")
        self.assertPageMenu(menu_url, self.admin, ["Shortcuts (0)", "Helpdesk", "Guides", "Nyaruka"])

        # each source links to its read page (results are shortcuts, helpdesk, divider, then the sources)
        menu = self.requestView(menu_url, self.admin).json()["results"]
        self.assertEqual(reverse("knowledge.knowledgesource_read", args=[website.uuid]), menu[4]["href"])

    def test_read(self):
        website = KnowledgeSource.create_website(self.org, self.admin, "Nyaruka", "https://nyaruka.com")
        docs = KnowledgeSource.create_documents(self.org, self.admin, "Guides")

        read_url = reverse("knowledge.knowledgesource_read", args=[website.uuid])

        # nobody can access if agents feature not enabled
        response = self.requestView(read_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(read_url, [None, self.agent, self.admin2])

        # the system sources aren't served here - they have their own fixed URL pages
        response = self.requestView(
            reverse("knowledge.knowledgesource_read", args=[self.system_shortcuts.uuid]), self.admin
        )
        self.assertEqual(404, response.status_code)
        response = self.requestView(
            reverse("knowledge.knowledgesource_read", args=[self.system_helpdesk.uuid]), self.admin
        )
        self.assertEqual(404, response.status_code)

        # a website read page lists its pages with no upload option
        page = KnowledgeItem.objects.create(
            source=website, name="Home", url="https://nyaruka.com/", content_type="text/html", size=1024
        )
        response = self.assertReadFetch(read_url, [self.admin], context_object=website)
        self.assertTrue(response.context["is_website"])
        self.assertEqual([page], list(response.context["items"]))
        self.assertNotIn("upload_url", response.context)
        self.assertContentMenu(read_url, self.admin, ["Edit", "Delete"])

        # a documents read page lists its documents and can upload
        docs_read_url = reverse("knowledge.knowledgesource_read", args=[docs.uuid])
        response = self.assertReadFetch(docs_read_url, [self.admin], context_object=docs)
        self.assertTrue(response.context["is_documents"])
        self.assertEqual([], list(response.context["items"]))
        self.assertEqual(reverse("knowledge.knowledgesource_upload", args=[docs.uuid]), response.context["upload_url"])
        self.assertFalse(response.context["items_limit_reached"])
        self.assertContentMenu(docs_read_url, self.admin, ["Upload", "Edit", "Delete"])

    def test_shortcuts(self):
        shortcuts_url = reverse("knowledge.knowledgesource_shortcuts")

        # nobody can access if agents feature not enabled
        response = self.requestView(shortcuts_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(shortcuts_url, [None, self.agent])

        # the page is the component driven shortcut list
        for user in (self.editor, self.admin):
            response = self.requestView(shortcuts_url, user)
            self.assertEqual(200, response.status_code)

        self.assertEqual(self.system_shortcuts, response.context["object"])
        self.assertEqual(f"{reverse('api.internal.shortcuts')}.json", response.context["shortcuts_endpoint"])
        self.assertContains(response, "temba-shortcut-list")
        self.assertContentMenu(shortcuts_url, self.admin, ["New"])

        # 404 if the system source is somehow absent
        self.org.sources.filter(source_type=KnowledgeSource.TYPE_SHORTCUTS).update(is_active=False)
        response = self.requestView(shortcuts_url, self.admin)
        self.assertEqual(404, response.status_code)

    def test_create(self):
        create_url = reverse("knowledge.knowledgesource_create")

        # nobody can access if agents feature not enabled
        response = self.requestView(create_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(create_url, [None, self.agent])

        response = self.assertCreateFetch(
            create_url, [self.editor, self.admin], form_fields=("name", "source_type", "url", "max_pages", "refresh")
        )

        # type picker only offers website and documents - users can't create a second helpdesk
        self.assertEqual(
            ["website", "documents"], [c[0] for c in response.context["form"].fields["source_type"].choices]
        )

        # a website source requires a URL
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Nyaruka", "source_type": "website", "url": ""},
            form_errors={"url": "This field is required."},
        )

        # names must be unique, including against the system sources
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "shortcuts", "source_type": "documents"},
            form_errors={"name": "Must be unique."},
        )
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "helpdesk", "source_type": "documents"},
            form_errors={"name": "Must be unique."},
        )

        response = self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Nyaruka", "source_type": "website", "url": "https://nyaruka.com", "max_pages": 100},
            new_obj_query=KnowledgeSource.objects.filter(name="Nyaruka", source_type="website", is_system=False),
        )

        website = KnowledgeSource.objects.get(name="Nyaruka")
        self.assertEqual(
            {"url": "https://nyaruka.com", "max_depth": 3, "max_pages": 100, "refresh": "weekly"}, website.config
        )
        self.assertEqual(reverse("knowledge.knowledgesource_read", args=[website.uuid]), response.url)

        response = self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Guides", "source_type": "documents"},
            new_obj_query=KnowledgeSource.objects.filter(name="Guides", source_type="documents", is_system=False),
        )

        docs = KnowledgeSource.objects.get(name="Guides")
        self.assertEqual({}, docs.config)
        self.assertEqual(KnowledgeSource.STATUS_READY, docs.status)
        self.assertEqual(reverse("knowledge.knowledgesource_read", args=[docs.uuid]), response.url)

    @mock_mailroom
    def test_update(self, mr_mocks):
        website = KnowledgeSource.create_website(self.org, self.admin, "Nyaruka", "https://nyaruka.com")
        docs = KnowledgeSource.create_documents(self.org, self.admin, "Guides")
        mr_mocks.calls["knowledge_index"].clear()

        update_url = reverse("knowledge.knowledgesource_update", args=[website.uuid])

        # nobody can access if agents feature not enabled
        response = self.requestView(update_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])

        # neither system source can be updated
        self.assertRequestDisallowed(
            reverse("knowledge.knowledgesource_update", args=[self.system_shortcuts.uuid]), [self.admin]
        )
        self.assertRequestDisallowed(
            reverse("knowledge.knowledgesource_update", args=[self.system_helpdesk.uuid]), [self.admin]
        )

        # website sources expose their crawl settings, document sets just their name
        self.assertUpdateFetch(
            update_url,
            [self.editor, self.admin],
            form_fields={"name": "Nyaruka", "url": "https://nyaruka.com", "max_pages": 500, "refresh": "weekly"},
        )
        self.assertUpdateFetch(
            reverse("knowledge.knowledgesource_update", args=[docs.uuid]), [self.admin], form_fields={"name": "Guides"}
        )

        # names must be unique
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "guides", "url": "https://nyaruka.com"},
            form_errors={"name": "Must be unique."},
            object_unchanged=website,
        )

        website.status = KnowledgeSource.STATUS_READY
        website.save(update_fields=("status",))

        # a config change flips the source back to pending
        response = self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "Nyaruka", "url": "https://nyaruka.com/docs", "max_pages": 500, "refresh": "weekly"},
        )
        website.refresh_from_db()
        self.assertEqual("https://nyaruka.com/docs", website.url)
        self.assertEqual(KnowledgeSource.STATUS_PENDING, website.status)
        self.assertEqual(reverse("knowledge.knowledgesource_read", args=[website.uuid]), response.url)
        self.assertEqual([call(self.org, website)], mr_mocks.calls["knowledge_index"])

        website.status = KnowledgeSource.STATUS_READY
        website.save(update_fields=("status",))

        # a name only change doesn't
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "Nyaruka Docs", "url": "https://nyaruka.com/docs", "max_pages": 500, "refresh": "weekly"},
        )
        website.refresh_from_db()
        self.assertEqual("Nyaruka Docs", website.name)
        self.assertEqual(KnowledgeSource.STATUS_READY, website.status)
        self.assertEqual(1, len(mr_mocks.calls["knowledge_index"]))

    @cleanup(s3=True)
    def test_delete(self):
        website = KnowledgeSource.create_website(self.org, self.admin, "Nyaruka", "https://nyaruka.com")
        page = KnowledgeItem.objects.create(
            source=website, name="Home", url="https://nyaruka.com/", content_type="text/html", size=1024
        )
        self.create_chunk(website, page.uuid, "welcome")

        delete_url = reverse("knowledge.knowledgesource_delete", args=[website.uuid])

        # nobody can access if agents feature not enabled
        response = self.requestView(delete_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(delete_url, [None, self.agent, self.admin2])

        # neither system source can be deleted
        self.assertRequestDisallowed(
            reverse("knowledge.knowledgesource_delete", args=[self.system_shortcuts.uuid]), [self.admin]
        )
        self.assertRequestDisallowed(
            reverse("knowledge.knowledgesource_delete", args=[self.system_helpdesk.uuid]), [self.admin]
        )

        response = self.assertDeleteFetch(delete_url, [self.editor, self.admin])
        self.assertContains(response, "You are about to delete")

        self.assertDeleteSubmit(delete_url, self.admin, object_deactivated=website, success_status=302)

        # its items and chunks are gone
        self.assertEqual(0, website.items.count())
        self.assertEqual(0, website.chunks.count())

    @cleanup(s3=True)
    def test_upload(self):
        website = KnowledgeSource.create_website(self.org, self.admin, "Nyaruka", "https://nyaruka.com")
        docs = KnowledgeSource.create_documents(self.org, self.admin, "Guides")

        upload_url = reverse("knowledge.knowledgesource_upload", args=[docs.uuid])

        # an org that loses the agents feature can't keep uploading to sources it already has
        response = self.requestView(upload_url, self.admin, post_data={})
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(upload_url, [None, self.agent, self.admin2])

        self.login(self.admin)

        # GET isn't allowed
        response = self.client.get(upload_url)
        self.assertEqual(405, response.status_code)

        # can't upload to a website source or the helpdesk
        for source in (website, self.system_helpdesk):
            response = self.client.post(
                reverse("knowledge.knowledgesource_upload", args=[source.uuid]),
                {"file": self.upload(f"{settings.TESTDATA_DIR}/media/simple.pdf", "application/pdf")},
            )
            self.assertEqual({"error": "Files can only be added to document sets."}, response.json())

        # can't upload a file type we don't support (sniffed, not the browser supplied type)
        response = self.client.post(
            upload_url, {"file": self.upload(f"{settings.TESTDATA_DIR}/media/klab.png", "application/pdf")}
        )
        self.assertEqual({"error": "Unsupported file type"}, response.json())

        # can't upload a file that's too big
        with patch("temba.knowledge.models.KnowledgeItem.MAX_UPLOAD_SIZE", 10):
            response = self.client.post(
                upload_url, {"file": self.upload(f"{settings.TESTDATA_DIR}/media/simple.pdf", "application/pdf")}
            )
            self.assertEqual({"error": "Limit for file uploads is 9.5367431640625e-06 MB"}, response.json())

        # can't exceed the documents limit
        with patch("temba.knowledge.models.KnowledgeItem.MAX_DOCUMENTS", 0):
            response = self.client.post(
                upload_url, {"file": self.upload(f"{settings.TESTDATA_DIR}/media/simple.pdf", "application/pdf")}
            )
            self.assertEqual({"error": "Limit of 0 documents reached."}, response.json())

        response = self.client.post(
            upload_url, {"file": self.upload(f"{settings.TESTDATA_DIR}/media/simple.pdf", "application/pdf")}
        )

        item = docs.items.get()
        self.assertEqual(
            {"uuid": str(item.uuid), "name": "simple.pdf", "size": item.size, "status": "pending"}, response.json()
        )
        self.assertEqual("application/pdf", item.content_type)
        self.assertTrue(default_storage.exists(item.path))

    @cleanup(s3=True)
    def test_item_delete(self):
        website = KnowledgeSource.create_website(self.org, self.admin, "Nyaruka", "https://nyaruka.com")
        docs = KnowledgeSource.create_documents(self.org, self.admin, "Guides")
        item = KnowledgeItem.from_upload(
            docs, self.admin, SimpleUploadedFile("guide.txt", b"hello", content_type="text/plain")
        )
        self.create_chunk(docs, item.uuid, "hello")
        page = KnowledgeItem.objects.create(
            source=website, name="Home", url="https://nyaruka.com/", content_type="text/html", size=1024
        )
        self.create_chunk(website, page.uuid, "welcome")

        delete_url = reverse("knowledge.knowledgeitem_delete", args=[item.uuid])

        # nobody can access if agents feature not enabled
        response = self.requestView(delete_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(delete_url, [None, self.agent, self.admin2])

        response = self.assertDeleteFetch(delete_url, [self.editor, self.admin])
        self.assertContains(response, "You are about to delete")

        item_path = item.path
        response = self.assertDeleteSubmit(delete_url, self.admin, object_deleted=item, success_status=302)
        self.assertEqual(reverse("knowledge.knowledgesource_read", args=[docs.uuid]), response.url)

        self.assertEqual(0, docs.chunks.count())
        self.assertFalse(default_storage.exists(item_path))

        # the other source's page and chunk are untouched
        self.assertEqual(1, website.items.count())
        self.assertEqual(1, website.chunks.count())
