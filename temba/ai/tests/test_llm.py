from unittest.mock import call, patch

from temba.ai.models import LLM
from temba.ai.types.anthropic.type import AnthropicType
from temba.ai.types.openai.type import OpenAIType
from temba.tests import TembaTest, mock_mailroom


class LLMTest(TembaTest):
    def test_model(self):
        openai = LLM.create(self.org, self.admin, OpenAIType(), "gpt-4o", "GPT-4", {"api_key": "sesame"})
        LLM.create(self.org, self.admin, AnthropicType(), "claude-haiku-4-5-20251001", "Claude", {})

        self.assertEqual(openai.name, "GPT-4")
        self.assertEqual(openai.type.slug, OpenAIType.slug)
        self.assertEqual(openai.config, {"api_key": "sesame"})
        self.assertEqual("TGC", openai.roles)

        openai.release(self.admin)

        self.assertFalse(openai.is_active)
        self.assertEqual(1, LLM.objects.filter(is_active=True).count())
        self.assertEqual(1, LLM.objects.filter(is_active=False).count())
        self.assertEqual(2, LLM.objects.count())

    def test_roles(self):
        # roles can be given explicitly
        editing = LLM.create(self.org, self.admin, OpenAIType(), "gpt-4o", "Editing", {}, roles=LLM.ROLE_TRANSLATION)
        self.assertEqual("T", editing.roles)

        # otherwise limited to what the type can do
        with patch.object(AnthropicType, "roles", LLM.ROLE_CLASSIFICATION):
            classifier = LLM.create(self.org, self.admin, AnthropicType(), "claude-haiku-4-5-20251001", "Claude", {})
            self.assertEqual("C", classifier.roles)

            # and reset when the type changes
            classifier.update_config(self.admin, OpenAIType(), "gpt-4o", "GPT", {})
            self.assertEqual("TGC", classifier.roles)

            editing.update_config(self.admin, AnthropicType(), "claude-haiku-4-5-20251001", "Claude 2", {})
            self.assertEqual("C", editing.roles)

        # but not when it doesn't
        editing.update_config(self.admin, AnthropicType(), "claude-haiku-4-5-20251001", "Claude 3", {})
        self.assertEqual("C", editing.roles)

    def test_release_system(self):
        system = LLM.create(self.org, self.admin, OpenAIType(), "gpt-4o", "System", {})
        system.is_system = True
        system.save(update_fields=("is_system",))

        with self.assertRaises(AssertionError):
            system.release(self.admin)

        system.refresh_from_db()
        self.assertTrue(system.is_active)

    def test_is_available_to(self):
        # by default available to any user
        self.assertTrue(OpenAIType().is_available_to(self.org, self.admin))
        self.assertTrue(OpenAIType().is_available_to(self.org, self.editor))

    @mock_mailroom
    def test_translate(self, mr_mocks):
        openai = LLM.create(self.org, self.admin, OpenAIType(), "gpt-4o", "GPT-4", {})

        items = {"a1:text": ["Hello"]}
        translated = {"a1:text": ["Hola"]}

        mr_mocks.llm_translate(translated)
        self.assertEqual(openai.translate("eng", "spa", items), translated)

        self.assertEqual(call(openai, "eng", "spa", items), mr_mocks.calls["llm_translate"][-1])
