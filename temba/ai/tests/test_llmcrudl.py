from unittest.mock import patch

from django.test import override_settings
from django.urls import reverse

from temba.ai.models import LLM
from temba.ai.types.openai.type import OpenAIType
from temba.ai.types.openai_azure.type import OpenAIAzureType
from temba.mailroom.client.exceptions import AIServiceException
from temba.tests import CRUDLTestMixin, TembaTest, mock_mailroom
from temba.utils.views.mixins import TEMBA_MENU_SELECTION


class LLMCRUDLTest(TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        self.openai = LLM.create(self.org, self.admin, OpenAIType(), "gpt-5.4-mini", "GPT-4", {"api_key": "openai-key"})
        self.azure = LLM.create(
            self.org, self.admin, OpenAIAzureType(), "gpt-35-turbo", "Azure GPT", {"api_key": "azure-key"}
        )
        LLM.create(self.org2, self.admin2, OpenAIType(), "gpt-5.4-mini", "Other Org", {})

    def test_list(self):
        list_url = reverse("ai.llm_list")

        self.assertRequestDisallowed(list_url, [None, self.agent])

        response = self.assertListFetch(list_url, [self.editor, self.admin])
        self.assertEqual("settings/ai", response.headers[TEMBA_MENU_SELECTION])

        # the temba-llm-list component fetches the models itself from the internal API
        self.assertContains(response, "temba-llm-list")
        self.assertEqual(f"{reverse('api.internal.ai_models')}.json", response.context["list_url"])
        self.assertEqual([], list(response.context["object_list"]))
        self.assertNotContains(response, "Model limit reached")

        # only admins can edit models
        self.assertContains(response, "editable")
        response = self.requestView(list_url, self.editor)
        self.assertNotContains(response, "editable")

        self.assertContentMenu(list_url, self.admin, ["New Model"])
        self.assertContentMenu(list_url, self.editor, [])

        with override_settings(ORG_LIMIT_DEFAULTS={"llms": 2}):
            response = self.assertListFetch(list_url, [self.editor, self.admin])
            self.assertContains(response, "Model limit reached")
            self.assertContentMenu(list_url, self.admin, [])

        # types that aren't available to the user are hidden from provider selection
        with patch.object(OpenAIAzureType, "is_available_to", lambda self, org, user: user.is_staff):
            self.assertContentMenu(list_url, self.admin, ["New Model"])
            self.assertContentMenu(list_url, self.customer_support, ["New Model"], choose_org=self.org)

            response = self.requestView(reverse("ai.llm_connect"), self.admin)
            providers = dict(response.context["form"].fields["provider"].choices)
            self.assertNotIn("openai_azure", providers)
            self.assertEqual("OpenAI", providers["openai"])

    @patch.object(
        OpenAIType, "get_model_choices", return_value=[("gpt-5.4-mini", "gpt-5.4-mini"), ("gpt-5.4", "gpt-5.4")]
    )
    def test_connect_reuses_api_key(self, mock_get_models):
        connect_url = reverse("ai.llm_connect")
        self.login(self.admin)

        response = self.process_wizard("connect", connect_url, {"provider": {"provider": "openai"}})
        self.assertNotContains(response, "data-hide-steps")  # creating a model shows the wizard's steps
        self.assertFalse(response.context["form"].fields["api_key"].required)
        self.assertEqual("••••••••", response.context["form"].fields["api_key"].widget.attrs["placeholder"])
        self.assertContains(response, "Leave blank to use the existing API key for this provider.")
        self.assertNotContains(response, "openai-key")

        response = self.process_wizard("connect", connect_url, {"credentials": {"api_key": ""}})
        self.assertEqual(
            [("gpt-5.4-mini", "gpt-5.4-mini"), ("gpt-5.4", "gpt-5.4")], response.context["form"].fields["model"].choices
        )

        response = self.process_wizard(
            "connect", connect_url, {"model": {"model": "gpt-5.4", "name": "Flow Assistant"}}
        )
        self.assertRedirects(response, reverse("ai.llm_list"))

        llm = self.org.llms.get(name="Flow Assistant")
        self.assertEqual({"api_key": "openai-key"}, llm.config)
        mock_get_models.assert_called_once_with("openai-key")

    def test_connect_does_not_reuse_ineligible_api_keys(self):
        self.openai.is_active = False
        self.openai.save(update_fields=("is_active",))

        other_org = self.org2.llms.get(name="Other Org")
        other_org.config = {"api_key": "other-org-key"}
        other_org.save(update_fields=("config",))

        inactive = LLM.create(
            self.org, self.admin, OpenAIType(), "gpt-5.4-mini", "Inactive", {"api_key": "inactive-key"}
        )
        inactive.is_active = False
        inactive.save(update_fields=("is_active",))

        system = LLM.create(self.org, self.admin, OpenAIType(), "gpt-5.4-mini", "System", {"api_key": "system-key"})
        system.is_system = True
        system.save(update_fields=("is_system",))

        self.login(self.admin)
        response = self.process_wizard("connect", reverse("ai.llm_connect"), {"provider": {"provider": "openai"}})
        self.assertTrue(response.context["form"].fields["api_key"].required)
        self.assertNotIn("placeholder", response.context["form"].fields["api_key"].widget.attrs)

    @patch.object(
        OpenAIType, "get_model_choices", return_value=[("gpt-5.4-mini", "gpt-5.4-mini"), ("gpt-5.4", "gpt-5.4")]
    )
    def test_update(self, mock_get_models):
        update_url = reverse("ai.llm_update", args=[self.openai.uuid])

        self.assertRequestDisallowed(update_url, [None, self.agent, self.editor, self.admin2])

        response = self.assertUpdateFetch(update_url, [self.admin], form_fields={"provider": "openai"})
        providers = dict(response.context["form"].fields["provider"].choices)
        self.assertEqual("OpenAI", providers["openai"])
        self.assertEqual("Azure OpenAI", providers["openai_azure"])

        # the model is deleted from its update modal, which doesn't show the wizard's steps
        self.assertContains(response, reverse("ai.llm_delete", args=[self.openai.uuid]))
        self.assertContains(response, "Delete model")
        self.assertContains(response, "data-hide-steps")

        # existing keys are never sent to the browser and can be preserved by leaving the field blank
        response = self.process_wizard("update", update_url, {"provider": {"provider": "openai"}})
        self.assertFalse(response.context["form"].fields["api_key"].required)
        self.assertEqual("••••••••", response.context["form"].fields["api_key"].widget.attrs["placeholder"])
        self.assertNotContains(response, "openai-key")

        response = self.process_wizard("update", update_url, {"credentials": {"api_key": ""}})
        self.assertEqual(
            [("gpt-5.4-mini", "gpt-5.4-mini"), ("gpt-5.4", "gpt-5.4")], response.context["form"].fields["model"].choices
        )
        self.assertEqual("gpt-5.4-mini", response.context["form"].initial["model"])
        self.assertEqual("GPT-4", response.context["form"].initial["name"])

        # names must be unique (case-insensitive)
        response = self.process_wizard("update", update_url, {"model": {"model": "gpt-5.4", "name": "azure gpt"}})
        self.assertFormError(response.context["form"], "name", "Must be unique.")

        # update the model and name while preserving the existing key
        response = self.process_wizard(
            "update",
            update_url,
            {
                "provider": {"provider": "openai"},
                "credentials": {"api_key": ""},
                "model": {"model": "gpt-5.4", "name": "Translation Assistant"},
            },
        )
        self.assertRedirects(response, reverse("ai.llm_list"))

        self.openai.refresh_from_db()
        self.assertEqual("Translation Assistant", self.openai.name)
        self.assertEqual("gpt-5.4", self.openai.model)
        self.assertEqual({"api_key": "openai-key"}, self.openai.config)
        self.assertEqual(128_000, self.openai.max_output_tokens)
        mock_get_models.assert_called_once_with("openai-key")

        # system LLMs can't be edited
        self.openai.is_system = True
        self.openai.save(update_fields=("is_system",))

        self.login(self.admin)
        self.assertEqual(404, self.client.get(update_url).status_code)

    @patch.object(OpenAIAzureType, "get_model_choices", return_value=[("gpt-35-turbo", "gpt-35-turbo")])
    def test_update_provider(self, mock_get_models):
        update_url = reverse("ai.llm_update", args=[self.openai.uuid])
        self.login(self.admin)

        response = self.process_wizard("update", update_url, {"provider": {"provider": "openai_azure"}})
        self.assertFalse(response.context["form"].fields["api_key"].required)
        self.assertEqual("••••••••", response.context["form"].fields["api_key"].widget.attrs["placeholder"])
        self.assertNotContains(response, "azure-key")

        response = self.process_wizard(
            "update",
            update_url,
            {
                "credentials": {"api_key": ""},
                "model": {"model": "gpt-35-turbo", "name": "Support Assistant"},
            },
        )
        self.assertRedirects(response, reverse("ai.llm_list"))

        self.openai.refresh_from_db()
        self.assertEqual("openai_azure", self.openai.llm_type)
        self.assertEqual("gpt-35-turbo", self.openai.model)
        self.assertEqual("Support Assistant", self.openai.name)
        self.assertEqual({"endpoint": OpenAIAzureType.endpoint, "api_key": "azure-key"}, self.openai.config)
        self.assertEqual(4_096, self.openai.max_output_tokens)
        mock_get_models.assert_called_once_with("azure-key")

    @patch.object(OpenAIType, "get_model_choices", return_value=[("gpt-5.4-mini", "gpt-5.4-mini")])
    def test_update_api_key(self, mock_get_models):
        update_url = reverse("ai.llm_update", args=[self.openai.uuid])
        self.login(self.admin)

        response = self.process_wizard(
            "update",
            update_url,
            {
                "provider": {"provider": "openai"},
                "credentials": {"api_key": "openai-new-key"},
                "model": {"model": "gpt-5.4-mini", "name": "GPT-4"},
            },
        )
        self.assertRedirects(response, reverse("ai.llm_list"))

        self.openai.refresh_from_db()
        self.assertEqual({"api_key": "openai-new-key"}, self.openai.config)
        mock_get_models.assert_called_once_with("openai-new-key")

    @mock_mailroom
    def test_translate(self, mr_mocks):
        translate_url = reverse("ai.llm_translate", args=[self.openai.uuid])

        self.assertRequestDisallowed(translate_url, [None, self.agent])

        translated = {"a1:text": ["Hola"]}
        mr_mocks.llm_translate(translated)

        self.login(self.editor)
        response = self.client.post(
            translate_url,
            {"source": "eng", "target": "spa", "items": {"a1:text": ["Hello"]}},
            content_type="application/json",
        )
        self.assertEqual(response.json(), {"items": translated})

        # LLM service failure (bad credentials, rate limit, etc.) returns 400 to the client
        mr_mocks.exception(AIServiceException("rate limit exceeded", "unknown", "", ""))

        response = self.client.post(
            translate_url,
            {"source": "eng", "target": "spa", "items": {"a1:text": ["Hello"]}},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"error": "rate limit exceeded"})

    def test_usages(self):
        usages_url = reverse("ai.llm_usages", args=[self.openai.uuid])

        flow = self.create_flow("Color Flow")
        flow.llm_dependencies.add(self.openai)

        self.assertRequestDisallowed(usages_url, [None, self.agent, self.admin2])
        response = self.assertReadFetch(usages_url, [self.editor, self.admin], context_object=self.openai)

        self.assertEqual({"flow": [flow]}, {t: list(qs) for t, qs in response.context["dependents"].items()})

    def test_delete(self):
        list_url = reverse("ai.llm_list")
        delete_url = reverse("ai.llm_delete", args=[self.azure.uuid])

        self.flow = self.create_flow("Color Flow")
        self.flow.llm_dependencies.add(self.openai)

        self.assertRequestDisallowed(delete_url, [None, self.editor, self.agent, self.admin2])

        # fetch delete modal
        response = self.assertDeleteFetch(delete_url, [self.admin])
        self.assertContains(response, "You are about to delete")

        response = self.assertDeleteSubmit(delete_url, self.admin, object_deactivated=self.azure, success_status=200)
        self.assertEqual(list_url, response["X-Temba-Success"])

        # should see warning if model is being used
        delete_url = reverse("ai.llm_delete", args=[self.openai.uuid])
        self.assertFalse(self.flow.has_issues)

        response = self.assertDeleteFetch(delete_url, [self.admin])
        self.assertContains(response, "is used by the following items but can still be deleted:")
        self.assertContains(response, "Color Flow")

        response = self.assertDeleteSubmit(delete_url, self.admin, object_deactivated=self.openai, success_status=200)
        self.assertEqual(list_url, response["X-Temba-Success"])

        self.flow.refresh_from_db()
        self.assertTrue(self.flow.has_issues)
        self.assertNotIn(self.openai, self.flow.llm_dependencies.all())

        # system LLMs can't be deleted
        system = LLM.create(self.org, self.admin, OpenAIType(), "gpt-5.4-mini", "System", {})
        system.is_system = True
        system.save(update_fields=("is_system",))

        delete_url = reverse("ai.llm_delete", args=[system.uuid])

        self.login(self.admin)
        self.assertEqual(404, self.client.get(delete_url).status_code)
        self.assertEqual(404, self.client.post(delete_url).status_code)
