from temba.ai.models import LLM
from temba.ai.types.anthropic.type import AnthropicType
from temba.ai.types.openai.type import OpenAIType
from temba.tests import MigrationTest


class SplitEngineRoleTest(MigrationTest):
    app = "ai"
    migrate_from = "0013_alter_llm_id"
    migrate_to = "0014_split_engine_role"

    def setUpBeforeMigration(self, apps):
        self.llm1 = LLM.create(self.org, self.admin, OpenAIType(), "gpt-4o", "Both", {}, roles="TF")
        self.llm2 = LLM.create(self.org, self.admin, OpenAIType(), "gpt-4o", "Editing", {}, roles="T")
        self.llm3 = LLM.create(
            self.org, self.admin, AnthropicType(), "claude-haiku-4-5-20251001", "Engine", {}, roles="F"
        )

    def test_migration(self):
        def assert_roles(llm, roles: str):
            llm.refresh_from_db()
            self.assertEqual(roles, llm.roles)

        assert_roles(self.llm1, "TGC")
        assert_roles(self.llm2, "T")
        assert_roles(self.llm3, "GC")
