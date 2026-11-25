from google import genai
from google.genai import errors

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
        help_text=_("You can find your API key at https://aistudio.google.com/"),
    )

    def clean_api_key(self):
        api_key = self.data["credentials-api_key"]

        try:
            client = genai.Client(api_key=api_key)
            pager = client.models.list(config={"page_size": 10})
            available_models = list(pager)
        except errors.ClientError:
            raise forms.ValidationError(_("Invalid API Key."))

        allowed_models = [f"models/{m}" for m in self.llm_type.settings.get("models", [])]
        model_choices = [
            (m.name, m.display_name) for m in available_models if not allowed_models or m.name in allowed_models
        ]
        self.extra_data = {"model_choices": model_choices}  # save our model choices as extra data

        return api_key


class ConnectView(BaseConnectWizard):
    form_list = [("credentials", CredentialsForm), ("model", ModelForm), ("name", NameForm)]

    def get_form_kwargs(self, step=None):
        kwargs = super().get_form_kwargs(step)

        if step == "model":
            step_data = self.storage.data["step_data"]
            kwargs["model_choices"] = step_data["credentials"]["model_choices"][0]

        if step == "name":
            step_data = self.storage.data["step_data"]
            kwargs["model_name"] = (
                step_data["model"]["model-model"][0].removeprefix("models/").title().replace("-", " ")
            )

        return kwargs

    def done(self, form_list, form_dict, **kwargs):
        api_key = form_dict["credentials"].cleaned_data["api_key"]
        model = form_dict["model"].cleaned_data["model"].removeprefix("models/")
        name = form_dict["name"].cleaned_data["name"]

        self.object = LLM.create(self.request.org, self.request.user, self.llm_type, model, name, {"api_key": api_key})

        return HttpResponseRedirect(self.get_success_url())
