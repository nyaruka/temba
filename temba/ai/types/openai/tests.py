from unittest.mock import Mock, patch

import openai

from django.urls import reverse

from temba.ai.models import LLM
from temba.tests import TembaTest
from temba.tests.crudl import CRUDLTestMixin


class OpenAITypeTest(TembaTest, CRUDLTestMixin):
    @patch("openai.OpenAI")
    def test_connect(self, mock_client):
        connect_url = reverse("ai.types.openai.connect")

        self.assertRequestDisallowed(connect_url, [self.editor, self.agent])

        response = self.requestView(connect_url, self.admin, status=200)
        self.assertContains(response, "You can find your API key at https://platform.openai.com/account/api-key")

        # test with bad api key
        mock_client.return_value.models.list.side_effect = openai.AuthenticationError(
            "Invalid API Key", response=Mock(request=None), body=None
        )
        response = self.process_wizard("connect_view", connect_url, {"credentials": {"api_key": "bad_key"}})
        self.assertContains(response, "Invalid API Key")

        # reset our mock
        mock_client.return_value.models.list.side_effect = None

        # get our model list from an api key
        mock_client.return_value.models.list.return_value = [
            Mock(id="gpt-4o"),
            Mock(id="gpt-4.1"),
            Mock(id="gpt-turbo-3.5"),
        ]
        response = self.process_wizard("connect_view", connect_url, {"credentials": {"api_key": "good_key"}})
        self.assertEqual(
            response.context["form"].fields["model"].choices, [("gpt-4o", "gpt-4o"), ("gpt-4.1", "gpt-4.1")]
        )

        # select a model and give it a name
        response = self.process_wizard(
            "connect_view",
            connect_url,
            {"credentials": {"api_key": "good_key"}, "model": {"model": "gpt-4o"}, "name": {"name": "GPT-4"}},
        )
        self.assertRedirects(response, reverse("ai.llm_list"))

        # check that we created our model
        llm = LLM.objects.get(org=self.org, llm_type="openai")
        self.assertEqual("GPT-4", llm.name)
        self.assertEqual("gpt-4o", llm.model)
        self.assertEqual("good_key", llm.config["api_key"])

        # try to create another model with same name
        response = self.process_wizard(
            "connect_view",
            connect_url,
            {"credentials": {"api_key": "good_key"}, "model": {"model": "gpt-4o"}, "name": {"name": "GPT-4"}},
        )

        self.assertFormError(response.context["form"], "name", "Must be unique.")
