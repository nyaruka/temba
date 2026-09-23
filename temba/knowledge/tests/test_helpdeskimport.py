from unittest.mock import call

from django import forms
from django.test import override_settings
from django.urls import reverse

from temba.knowledge.forms import HelpdeskImportForm
from temba.knowledge.imports import register_import_type, reload_import_types
from temba.knowledge.models import Article, HelpdeskImport, HelpdeskImportError, HelpdeskImportType, KnowledgeSource
from temba.orgs.models import Org
from temba.tests import CRUDLTestMixin, TembaTest, mock_mailroom


class TestImportForm(HelpdeskImportForm):
    key = forms.CharField()

    def clean_key(self):
        key = self.cleaned_data["key"]
        if key == "wrong":
            raise forms.ValidationError("That key is wrong.")
        return key


class TestImportType(HelpdeskImportType):
    """
    A site of a section and two articles, the second of which can be made to fail.
    """

    name = "Test Site"
    slug = "test"
    form_class = TestImportForm
    secret_config_keys = ("key",)
    template_name = "knowledge/helpdeskimport_create.html"

    def perform(self, imp):
        imp.set_total(3)

        section = Article.create(imp.source, imp.created_by, "Imported")
        imp.advance()

        for i in (1, 2):
            if imp.config.get("fail_at") == i:
                raise HelpdeskImportError("The site went away.")
            article = Article.create(imp.source, imp.created_by, f"Article {i}", parent=section)
            article.publish(imp.created_by)
            imp.advance()


class ElsewhereImportType(HelpdeskImportType):
    """
    A kind of import this workspace isn't offered.
    """

    name = "Elsewhere"
    slug = "elsewhere"
    form_class = TestImportForm

    def is_available_to(self, org, user) -> bool:
        return False


TEST_TYPES = [
    "temba.knowledge.tests.test_helpdeskimport.TestImportType",
    "temba.knowledge.tests.test_helpdeskimport.ElsewhereImportType",
]


class ImportTypesMixin:
    """
    Registers the test import types for the duration of each test - the core registers none of its own.
    """

    def setUp(self):
        super().setUp()

        settings = override_settings(HELPDESK_IMPORT_TYPES=TEST_TYPES)
        settings.enable()
        reload_import_types()

        def restore():
            settings.disable()
            reload_import_types()

        self.addCleanup(restore)

        self.helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)
        self.test_type = HelpdeskImport.get_type("test")


class HelpdeskImportTest(ImportTypesMixin, TembaTest):
    def create_import(self, key="secret", **config):
        return HelpdeskImport.create(self.helpdesk, self.admin, self.test_type, {"key": key, **config})

    def test_types(self):
        self.assertEqual(["test", "elsewhere"], [t.slug for t in HelpdeskImport.get_types()])
        self.assertIsInstance(self.test_type, TestImportType)
        self.assertEqual("knowledge/imports/elsewhere/create.html", HelpdeskImport.get_type("elsewhere").template_name)
        self.assertIsNone(HelpdeskImport.get_type("nope"))

        # a slug is one type's alone
        with self.assertRaises(AssertionError):
            register_import_type(TestImportType)

        # and the core ships none of its own
        with override_settings(HELPDESK_IMPORT_TYPES=[]):
            reload_import_types()
            self.assertEqual([], list(HelpdeskImport.get_types()))

        reload_import_types()
        self.assertEqual(["test", "elsewhere"], [t.slug for t in HelpdeskImport.get_types()])

    @mock_mailroom
    def test_perform(self, mr_mocks):
        self.helpdesk.status = KnowledgeSource.STATUS_READY
        self.helpdesk.save(update_fields=("status",))

        imp = self.create_import()
        self.assertEqual("test", imp.import_type)
        self.assertEqual(self.test_type, imp.type)
        self.assertFalse(imp.is_finished)
        self.assertEqual("pending", imp.as_json()["status"])

        imp.perform()

        imp.refresh_from_db()
        self.assertEqual(HelpdeskImport.STATUS_COMPLETE, imp.status)
        self.assertEqual("complete", imp.as_json()["status"])
        self.assertIsNone(imp.error)
        self.assertIsNotNone(imp.started_on)
        self.assertIsNotNone(imp.finished_on)
        self.assertEqual({"total": 3, "current": 3}, imp.as_json()["progress"])
        self.assertEqual(3, self.helpdesk.articles.count())

        # what was lent for the import isn't kept
        self.assertEqual({}, imp.config)

        # and the helpdesk is queued for reindexing, with one request to mailroom for the whole import
        self.helpdesk.refresh_from_db()
        self.assertEqual(KnowledgeSource.STATUS_PENDING, self.helpdesk.status)
        self.assertEqual([call(self.org, self.helpdesk)], mr_mocks.calls["knowledge_index"])

        # an import that can't go on says why, and keeps what it brought before that
        imp = self.create_import(fail_at=2)
        imp.perform()

        imp.refresh_from_db()
        self.assertEqual(HelpdeskImport.STATUS_FAILED, imp.status)
        self.assertEqual("The site went away.", imp.error)
        self.assertEqual({"total": 3, "current": 2}, imp.as_json()["progress"])
        self.assertEqual({"fail_at": 2}, imp.config)
        self.assertEqual(5, self.helpdesk.articles.count())

        # what it did bring in still gets indexed
        self.assertEqual([call(self.org, self.helpdesk)] * 2, mr_mocks.calls["knowledge_index"])

        # only a pending import can be performed - not one that's finished, nor one already being performed
        with self.assertRaises(AssertionError):
            imp.perform()

        imp = self.create_import()
        imp.status = HelpdeskImport.STATUS_PROCESSING
        imp.save(update_fields=("status",))
        with self.assertRaises(AssertionError):
            imp.perform()

    def test_get_unfinished(self):
        self.assertIsNone(HelpdeskImport.get_unfinished(self.helpdesk))
        self.assertIsNone(HelpdeskImport.get_latest(self.helpdesk))

        imp = self.create_import()
        self.assertEqual(imp, HelpdeskImport.get_unfinished(self.helpdesk))
        self.assertEqual(imp, HelpdeskImport.get_latest(self.helpdesk))

        # one that never finished in hours has died rather than still be running
        imp.created_on = imp.created_on - HelpdeskImport.UNFINISHED_WINDOW
        imp.save(update_fields=("created_on",))
        self.assertIsNone(HelpdeskImport.get_unfinished(self.helpdesk))

        imp = self.create_import()
        imp.status = HelpdeskImport.STATUS_COMPLETE
        imp.save(update_fields=("status",))
        self.assertIsNone(HelpdeskImport.get_unfinished(self.helpdesk))


class HelpdeskImportCRUDLTest(ImportTypesMixin, TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        self.org.features = [Org.FEATURE_AGENTS]
        self.org.save(update_fields=("features",))

    def test_create(self):
        create_url = reverse("knowledge.helpdeskimport_create", args=["test"])
        self.assertEqual("/helpdeskimport/create/test/", create_url)

        self.assertRequestDisallowed(create_url, [None, self.agent])
        self.assertCreateFetch(create_url, [self.editor, self.admin], form_fields=("key",))

        # a kind of import that isn't registered, or isn't offered to this workspace, isn't there
        self.requestView(reverse("knowledge.helpdeskimport_create", args=["nope"]), self.admin, status=404)
        self.requestView(reverse("knowledge.helpdeskimport_create", args=["elsewhere"]), self.admin, status=404)

        # the type's form checks what it's given before anything is queued
        self.assertCreateSubmit(create_url, self.admin, {"key": "wrong"}, form_errors={"key": "That key is wrong."})
        self.assertEqual(0, HelpdeskImport.objects.count())

        # given something good the import is queued - and run, since tasks are eager in tests
        self.assertCreateSubmit(
            create_url,
            self.editor,
            {"key": "secret"},
            new_obj_query=HelpdeskImport.objects.filter(
                org=self.org, source=self.helpdesk, import_type="test", created_by=self.editor
            ),
        )

        imp = HelpdeskImport.objects.get()
        self.assertEqual(HelpdeskImport.STATUS_COMPLETE, imp.status)
        self.assertEqual({}, imp.config)  # the form's own fields became the config, and the key was a secret
        self.assertEqual(3, self.helpdesk.articles.count())

        # while one is running, the dialog offers nothing but to wait
        imp.status = HelpdeskImport.STATUS_PROCESSING
        imp.save(update_fields=("status",))

        response = self.assertCreateFetch(create_url, [self.admin], form_fields=("key",))
        self.assertEqual("existing-import", response.context["blocker"])
        self.assertContains(response, "An import is already in progress.")

        response = self.requestView(create_url, self.admin, post_data={"key": "secret"}, choose_org=self.org)
        self.assertEqual(200, response.status_code)
        self.assertContains(response, "An import is already in progress.")
        self.assertEqual(1, HelpdeskImport.objects.count())

    def test_status(self):
        status_url = reverse("knowledge.helpdeskimport_status")
        self.assertEqual("/helpdeskimport/status/", status_url)

        self.assertRequestDisallowed(status_url, [None, self.agent])

        response = self.requestView(status_url, self.editor)
        self.assertEqual({"results": []}, response.json())

        imp = HelpdeskImport.create(self.helpdesk, self.admin, self.test_type, {})
        imp.set_total(10)
        imp.advance()

        response = self.requestView(status_url, self.editor)
        self.assertEqual(
            {
                "id": imp.id,
                "status": "pending",
                "created_on": imp.created_on.isoformat(),
                "modified_on": imp.modified_on.isoformat(),
                "progress": {"total": 10, "current": 1},
                "error": None,
            },
            response.json()["results"][0],
        )

    def test_list_shows_import(self):
        list_url = reverse("knowledge.article_list")

        # the menu offers each kind of import the workspace can do
        self.assertContentMenu(list_url, self.admin, ["New Section", "Site Settings", "Import from Test Site"])

        # nothing to say until there's an import
        response = self.requestView(list_url, self.admin)
        self.assertNotIn("helpdesk_import", response.context)
        self.assertNotContains(response, 'id="import-card"')

        # one underway is shown with its progress and kept current
        imp = HelpdeskImport.create(self.helpdesk, self.admin, self.test_type, {})

        response = self.requestView(list_url, self.admin)
        self.assertEqual(imp, response.context["helpdesk_import"])
        self.assertEqual(reverse("knowledge.helpdeskimport_status"), response.context["import_status_url"])
        self.assertContains(response, "Importing from Test Site")
        self.assertContains(response, "pollHelpdeskImport(1)")

        # one that failed says why, and offers to try again
        imp.status = HelpdeskImport.STATUS_FAILED
        imp.error = "The site went away."
        imp.save(update_fields=("status", "error"))

        response = self.requestView(list_url, self.admin)
        self.assertEqual(imp, response.context["helpdesk_import"])
        self.assertEqual(reverse("knowledge.helpdeskimport_create", args=["test"]), response.context["import_url"])
        self.assertEqual("Import from Test Site", response.context["import_title"])
        self.assertContains(response, "The import from Test Site did not finish.")
        self.assertContains(response, "The site went away.")
        self.assertContains(response, "Try Again")
        self.assertNotContains(response, "pollHelpdeskImport(1)")

        # unless its kind of import is no longer on
        imp.import_type = "gone"
        imp.save(update_fields=("import_type",))

        response = self.requestView(list_url, self.admin)
        self.assertEqual("gone", response.context["import_type_name"])
        self.assertNotIn("import_url", response.context)
        self.assertNotContains(response, "Try Again")

        # and one that finished is nothing to mention
        imp.status = HelpdeskImport.STATUS_COMPLETE
        imp.save(update_fields=("status",))

        response = self.requestView(list_url, self.admin)
        self.assertNotIn("helpdesk_import", response.context)
