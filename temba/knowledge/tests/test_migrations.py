from importlib import import_module
from zoneinfo import ZoneInfo

from temba.orgs.models import Org
from temba.tests import MigrationTest
from temba.utils.uuid import uuid4


class BackfillSystemKnowledgeTest(MigrationTest):
    app = "knowledge"
    migrate_from = "0001_initial"
    migrate_to = "0002_backfill_system_knowledge"

    def setUpBeforeMigration(self, apps):
        OldKnowledge = apps.get_model("knowledge", "Knowledge")

        # TembaTest.setUp already ran Org.initialize() which created both rows - remove them so the backfill has
        # work to do
        OldKnowledge.objects.all().delete()

        # org2 gets a colliding user created source, so its system shortcuts row has to fall back to "Shortcuts 2"
        OldKnowledge.objects.create(
            org_id=self.org2.id,
            uuid=uuid4(),
            name="Shortcuts",
            knowledge_type="website",
            config={"url": "https://nyaruka.com"},
            created_by_id=self.admin2.id,
            modified_by_id=self.admin2.id,
        )

        # org3 is mid rolling-deploy: it already has a helpdesk but no shortcuts
        self.org3 = Org.objects.create(
            name="Third", timezone=ZoneInfo("Africa/Kigali"), created_by=self.admin, modified_by=self.admin
        )
        self.org3_helpdesk_uuid = uuid4()
        OldKnowledge.objects.create(
            org_id=self.org3.id,
            uuid=self.org3_helpdesk_uuid,
            name="Helpdesk",
            knowledge_type="helpdesk",
            is_system=True,
            created_by_id=self.admin.id,
            modified_by_id=self.admin.id,
        )

    def assertSystemRows(self, org, shortcuts_name: str, helpdesk_name: str):
        # the model as it was at this migration, before it became KnowledgeSource
        Knowledge = self.apps.get_model("knowledge", "Knowledge")

        shortcuts = Knowledge.objects.get(org_id=org.id, knowledge_type="shortcuts")
        helpdesk = Knowledge.objects.get(org_id=org.id, knowledge_type="helpdesk")

        for source in (shortcuts, helpdesk):
            self.assertTrue(source.is_system)
            self.assertTrue(source.is_active)
            self.assertEqual("P", source.status)

        self.assertEqual(shortcuts_name, shortcuts.name)
        self.assertEqual(helpdesk_name, helpdesk.name)

    def test_migration(self):
        Knowledge = self.apps.get_model("knowledge", "Knowledge")

        self.assertSystemRows(self.org, "Shortcuts", "Helpdesk")
        self.assertSystemRows(self.org2, "Shortcuts 2", "Helpdesk")  # "Shortcuts" was taken by its website source
        self.assertSystemRows(self.org3, "Shortcuts", "Helpdesk")

        # org3's pre-existing helpdesk row is untouched
        self.assertEqual(
            self.org3_helpdesk_uuid, Knowledge.objects.get(org_id=self.org3.id, knowledge_type="helpdesk").uuid
        )

        # re-running the backfill is a no-op
        num_rows = Knowledge.objects.count()
        backfill = import_module("temba.knowledge.migrations.0002_backfill_system_knowledge").backfill_system_knowledge
        backfill(self.apps, None)
        self.assertEqual(num_rows, Knowledge.objects.count())


class KeepArticleHtmlAddresslessTest(MigrationTest):
    app = "knowledge"
    migrate_from = "0009_backfill_article_html"
    migrate_to = "0010_keep_article_html_addressless"

    def setUpBeforeMigration(self, apps):
        KnowledgeSource = apps.get_model("knowledge", "KnowledgeSource")
        Article = apps.get_model("knowledge", "Article")

        helpdesk = KnowledgeSource.objects.get(org_id=self.org.id, source_type="helpdesk")
        helpdesk.config = {"colors": {"1": "#ffe8a3"}}
        helpdesk.save(update_fields=("config",))
        self.helpdesk_id = helpdesk.id

        def create_article(title, body, status, body_html=""):
            return Article.objects.create(
                source=helpdesk,
                title=title,
                slug=title.lower(),
                body=body,
                body_html=body_html,
                status=status,
                created_by_id=self.admin.id,
                modified_by_id=self.admin.id,
            )

        # published with colors and addresses baked in, as it was before
        self.published = create_article(
            "Nodes",
            "# Nodes\n\n![shot](orgs/1/knowledge/shot.png)\n\n| background: 1 |\n| - |\n| one |",
            "P",
            '<col style="background: #ffe8a3">',
        )
        self.draft = create_article("Drafting", "# Drafting\n\nNot yet.", "D")
        self.modified_on = self.published.modified_on

    def test_migration(self):
        KnowledgeSource = self.apps.get_model("knowledge", "KnowledgeSource")
        Article = self.apps.get_model("knowledge", "Article")

        # what each palette entry looks like on a page is kept alongside the palette
        helpdesk = KnowledgeSource.objects.get(id=self.helpdesk_id)
        self.assertEqual(
            {"1": {"fill": "#ffe8a3", "text": "#6b581f", "border": "#d4be7d"}}, helpdesk.config["color_styles"]
        )

        # and published articles are kept with palette indexes and storage keys, without looking any more recently
        # modified
        published = Article.objects.get(id=self.published.id)
        self.assertEqual(
            '<h1 id="nodes">Nodes</h1>\n<p><img alt="shot" src="storage:orgs/1/knowledge/shot.png"></p>\n'
            '<table>\n<colgroup><col class="bubble-1"></colgroup><thead>\n<tr>\n<th></th>\n</tr>\n</thead>\n'
            '<tbody>\n<tr>\n<td class="bubble-1">one</td>\n</tr>\n</tbody>\n</table>',
            published.body_html,
        )
        self.assertEqual([{"id": "nodes", "text": "Nodes"}], published.headings)
        self.assertEqual(self.modified_on, published.modified_on)

        # a draft isn't rendered
        draft = Article.objects.get(id=self.draft.id)
        self.assertEqual("", draft.body_html)
