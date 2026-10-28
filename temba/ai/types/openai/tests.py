from unittest.mock import Mock, patch

import openai

from django.urls import reverse

from temba.ai.models import LLM
from temba.tests import TembaTest
from temba.tests.crudl import CRUDLTestMixin


class OpenAITypeTest(TembaTest, CRUDLTestMixin):
    @patch("openai.OpenAI")
    def test_connect(self, mock_client):
        connect_url = reverse("ai.llm_connect")

        self.assertRequestDisallowed(connect_url, [self.editor, self.agent])

        response = self.requestView(connect_url, self.admin, status=200)
        response = self.process_wizard("connect", connect_url, {"provider": {"provider": "openai"}})
        self.assertContains(response, "You can find your API key at https://platform.openai.com/account/api-key")

        # test with bad api key
        mock_client.return_value.models.list.side_effect = openai.AuthenticationError(
            "Invalid API Key", response=Mock(request=None), body=None
        )
        response = self.process_wizard("connect", connect_url, {"credentials": {"api_key": "bad_key"}})
        self.assertContains(response, "Invalid API Key")

        # reset our mock
        mock_client.return_value.models.list.side_effect = None

        # get our model list from an api key
        mock_client.return_value.models.list.return_value = [
            Mock(id="gpt-5.4-mini"),
            Mock(id="gpt-5.4"),
            Mock(id="gpt-turbo-3.5"),
        ]
        response = self.process_wizard("connect", connect_url, {"credentials": {"api_key": "good_key"}})
        self.assertEqual(
            response.context["form"].fields["model"].choices, [("gpt-5.4-mini", "gpt-5.4-mini"), ("gpt-5.4", "gpt-5.4")]
        )
        self.assertNotIn("name", response.context["form"].initial)
        self.assertEqual(
            "e.g. Translation Assistant", response.context["form"].fields["name"].widget.attrs["placeholder"]
        )
        self.assertContains(
            response,
            "Name it for how it will be used, so the name stays accurate if you change models later.",
        )

        # select a model and give it a name
        response = self.process_wizard(
            "connect",
            connect_url,
            {
                "credentials": {"api_key": "good_key"},
                "model": {"model": "gpt-5.4-mini", "name": "Translation Assistant"},
            },
        )
        self.assertRedirects(response, reverse("ai.llm_list"))

        # check that we created our model
        llm = LLM.objects.get(org=self.org, llm_type="openai")
        self.assertEqual("Translation Assistant", llm.name)
        self.assertEqual("gpt-5.4-mini", llm.model)
        self.assertEqual("good_key", llm.config["api_key"])

        # try to create another model with same name
        response = self.process_wizard(
            "connect",
            connect_url,
            {
                "provider": {"provider": "openai"},
                "credentials": {"api_key": "good_key"},
                "model": {"model": "gpt-5.4-mini", "name": "Translation Assistant"},
            },
        )

        self.assertFormError(response.context["form"], "name", "Must be unique.")
