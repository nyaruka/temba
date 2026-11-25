import openai

from django import forms
from django.http import HttpResponseRedirect
from django.utils.translation import gettext_lazy as _

from temba.ai.models import LLM
from temba.ai.views import BaseConnectWizard, ModelForm, NameForm
from temba.utils.fields import InputWidget


class CredentialsForm(BaseConnectWizard.Form):
    api_key = forms.CharField(
        widget=InputWidget({"placeholder": "API Key", "widget_only": False, "label": "API Key", "value": ""}),
        label="",
        help_text=_("API keys are provided by the UNICEF ICTD team."),
    )

    def __init__(self, endpoint, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.endpoint = endpoint

    def clean_api_key(self):
        api_key = self.data["credentials-api_key"]

        if api_key:
            endpoint = self.endpoint + "/openai"  # mailroom using go client appends this
            model = next(iter(self.llm_type.settings["models"]))
            try:
                client = openai.AzureOpenAI(base_url=endpoint, api_key=api_key, api_version="2025-03-01-preview")
                client.chat.completions.create(model=model, messages=[{"role": "user", "content": "How are you?"}])
            except openai.AuthenticationError:
                raise forms.ValidationError(_("Invalid API Key."))

        return api_key


class ConnectView(BaseConnectWizard):
    form_list = [("credentials", CredentialsForm), ("model", ModelForm), ("name", NameForm)]

    endpoint = "https://orgunit-ai-endpoints.azure-api.net/openai-gen-ai-poc"

    def get_form_kwargs(self, step=None):
        kwargs = super().get_form_kwargs(step)

        if step == "credentials":
            kwargs["endpoint"] = self.endpoint

        if step == "model":
            step_data = self.storage.data["step_data"]
            kwargs["model_choices"] = ((m, m) for m in self.llm_type.settings["models"])

        if step == "name":
            step_data = self.storage.data["step_data"]
            kwargs["model_name"] = step_data["model"]["model-model"][0].replace("gpt", "GPT").replace("-", " ")

        return kwargs

    def done(self, form_list, form_dict, **kwargs):
        api_key = form_dict["credentials"].cleaned_data["api_key"]
        model = form_dict["model"].cleaned_data["model"]
        name = form_dict["name"].cleaned_data["name"]

        self.object = LLM.create(
            self.request.org,
            self.request.user,
            self.llm_type,
            model,
            name,
            {"endpoint": self.endpoint, "api_key": api_key},
        )

        return HttpResponseRedirect(self.get_success_url())
