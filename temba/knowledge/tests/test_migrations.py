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
