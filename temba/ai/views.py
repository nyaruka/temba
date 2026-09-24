import json

from smartmin.views import SmartCRUDL

from django import forms
from django.db.models.functions import Lower
from django.http import HttpResponseRedirect, JsonResponse
from django.urls import reverse
from django.utils.crypto import salted_hmac
from django.utils.translation import gettext_lazy as _
from django.views.decorators.csrf import csrf_exempt

from temba import mailroom
from temba.orgs.views.base import BaseDependencyDeleteModal, BaseListView, BaseReadView
from temba.orgs.views.mixins import OrgObjPermsMixin, OrgPermsMixin
from temba.utils.fields import InputWidget, NameValidator, SelectWidget
from temba.utils.views.mixins import ContextMenuMixin, PostOnlyMixin, SpaMixin
from temba.utils.views.wizard import SmartWizardUpdateView, SmartWizardView

from .models import LLM, LLMCredentialsError


class ModelWizardForm(forms.Form):
    def __init__(self, org, user, llm=None, llm_type=None, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.org = org
        self.user = user
        self.llm = llm
        self.llm_type = llm_type


class ProviderForm(ModelWizardForm):
    provider = forms.ChoiceField(
        label=_("Provider"), widget=SelectWidget(), help_text=_("Choose the provider for this model.")
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        choices = []
        for llm_type in LLM.get_types():
            if llm_type.is_available_to(self.org, self.user) or (self.llm and self.llm.llm_type == llm_type.slug):
                choices.append((llm_type.slug, llm_type.name))
        self.fields["provider"].choices = choices


class CredentialsForm(ModelWizardForm):
    api_key = forms.CharField(label=_("API Key"), widget=InputWidget(attrs={"password": True}))

    def __init__(self, validation_cache=None, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.validation_cache = validation_cache
        existing_key = self.get_existing_api_key()
        self.fields["api_key"].help_text = self.llm_type.api_key_help
        if existing_key:
            self.fields["api_key"].required = False
            self.fields["api_key"].widget.attrs["placeholder"] = "••••••••"
            self.fields["api_key"].help_text = _(
                "Leave blank to use the existing API key for this provider. %(help)s"
            ) % {"help": self.llm_type.api_key_help}

    def get_existing_api_key(self):
        if self.llm and self.llm.llm_type == self.llm_type.slug:
            api_key = self.llm.config.get("api_key")
            if api_key:
                return api_key

        existing_llms = self.org.llms.filter(is_active=True, is_system=False, llm_type=self.llm_type.slug)
        if self.llm:
            existing_llms = existing_llms.exclude(id=self.llm.id)

        for config in existing_llms.order_by("-modified_on").values_list("config", flat=True):
            api_key = config.get("api_key")
            if api_key:
                return api_key

        return None

    def clean_api_key(self):
        api_key = self.cleaned_data["api_key"]
        if not api_key:
            api_key = self.get_existing_api_key()

        api_key_hash = salted_hmac("temba.ai.credentials", api_key, algorithm="sha256").hexdigest()
        cache = self.validation_cache
        if (
            cache
            and cache.get("llm_type") == self.llm_type.slug
            and cache.get("api_key_hash") == api_key_hash
            and cache.get("model_choices") is not None
        ):
            model_choices = cache["model_choices"]
        else:
            try:
                model_choices = self.llm_type.get_model_choices(api_key)
            except LLMCredentialsError as e:
                raise forms.ValidationError(str(e))

        self.extra_data = {
            "validated_api_key_hash": api_key_hash,
            "validated_llm_type": self.llm_type.slug,
            "model_choices": model_choices,
        }
        return api_key


class ModelForm(ModelWizardForm):
    """
    Reusable wizard form for selecting and naming a model.
    """

    model = forms.ChoiceField(
        label=_("Model"), widget=SelectWidget(), help_text=_("Choose the model you would like to use.")
    )
    name = forms.CharField(
        label=_("Name"),
        max_length=LLM.MAX_NAME_LEN,
        validators=[NameValidator(LLM.MAX_NAME_LEN)],
        widget=InputWidget(attrs={"placeholder": _("e.g. Translation Assistant")}),
        help_text=_(
            "Name this model for how you plan to use it, so the name stays useful if you change providers or models later."
        ),
        required=True,
    )

    def __init__(self, model_choices, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.fields["model"].choices = model_choices

    def clean_name(self):
        name = self.cleaned_data["name"]

        # make sure the name isn't already taken
        existing = self.org.llms.filter(is_active=True, name__iexact=name)
        if self.llm:
            existing = existing.exclude(id=self.llm.id)
        if existing.exists():
            raise forms.ValidationError(_("Must be unique."))

        return name


class ModelWizardMixin:
    form_list = [
        ("provider", ProviderForm),
        ("credentials", CredentialsForm),
        ("model", ModelForm),
    ]
    template_name = "ai/llm_form.html"
    success_url = "@ai.llm_list"

    def get_llm(self):
        return getattr(self, "object", None)

    def get_selected_type(self):
        provider = self.get_cleaned_data_for_step("provider")["provider"]
        return next(t for t in LLM.get_types() if t.slug == provider)

    def get_credentials_validation(self):
        # Extra data added by SmartWizardView.process_step is list-wrapped by the wizard's MultiValueDict storage.
        data = self.storage.get_step_data("credentials")
        if not data:
            return None

        return {
            "api_key_hash": data.get("validated_api_key_hash"),
            "llm_type": data.get("validated_llm_type"),
            "model_choices": data.get("model_choices"),
        }

    def get_form_kwargs(self, step=None):
        kwargs = super().get_form_kwargs(step)
        kwargs.update({"org": self.request.org, "user": self.request.user, "llm": self.get_llm()})

        if step != "provider":
            kwargs["llm_type"] = self.get_selected_type()
        if step == "credentials":
            kwargs["validation_cache"] = self.get_credentials_validation()
        elif step == "model":
            kwargs["model_choices"] = self.get_credentials_validation()["model_choices"]

        return kwargs

    def get_form_initial(self, step):
        initial = super().get_form_initial(step)
        llm = self.get_llm()
        if not llm:
            return initial

        if step == "provider":
            initial["provider"] = llm.llm_type
        elif step == "model":
            initial["name"] = llm.name
            if self.get_selected_type().slug == llm.llm_type:
                initial["model"] = llm.model

        return initial

    def done(self, form_list, form_dict, **kwargs):
        llm_type = next(t for t in LLM.get_types() if t.slug == form_dict["provider"].cleaned_data["provider"])
        api_key = form_dict["credentials"].cleaned_data["api_key"]
        model = form_dict["model"].cleaned_data["model"]
        name = form_dict["model"].cleaned_data["name"]
        config = llm_type.get_config(api_key)

        llm = self.get_llm()
        if llm:
            llm.update_config(self.request.user, llm_type, model, name, config)
        else:
            self.object = LLM.create(self.request.org, self.request.user, llm_type, model, name, config)

        return HttpResponseRedirect(self.get_success_url())


class LLMCRUDL(SmartCRUDL):
    model = LLM
    actions = ("list", "connect", "update", "translate", "delete")

    class List(SpaMixin, ContextMenuMixin, BaseListView):
        title = _("Artificial Intelligence")
        menu_path = "settings/ai"
        default_order = (Lower("name"),)

        def derive_queryset(self, **kwargs):
            return super().derive_queryset(**kwargs).filter(is_system=False)

        def build_context_menu(self, menu):
            if self.has_org_perm("ai.llm_connect") and not self.is_limit_reached:
                if any(t.is_available_to(self.request.org, self.request.user) for t in LLM.get_types()):
                    menu.add_modax(_("New Model"), "new-model", reverse("ai.llm_connect"), title=_("New Model"))

    class Connect(ModelWizardMixin, OrgPermsMixin, SmartWizardView):
        permission = "ai.llm_connect"
        menu_path = "/settings/ai/new-model"
        submit_button_name = _("Create")

    class Update(ModelWizardMixin, OrgObjPermsMixin, SmartWizardUpdateView):
        slug_field = "uuid"
        slug_url_kwarg = "uuid"
        submit_button_name = _("Save")

        def get_queryset(self):
            return LLM.objects.filter(org=self.request.org, is_active=True, is_system=False)

    class Translate(PostOnlyMixin, BaseReadView):
        @csrf_exempt
        def dispatch(self, *args, **kwargs):
            return super().dispatch(*args, **kwargs)

        def post(self, request, *args, **kwargs):
            self.object = self.get_object()
            data = json.loads(request.body)

            try:
                items = self.object.translate(data["source"], data["target"], data["items"])
            except mailroom.AIServiceException as e:
                return JsonResponse({"error": str(e), "code": e.code}, status=400)

            return JsonResponse({"items": items})

    class Delete(BaseDependencyDeleteModal):
        cancel_url = "@ai.llm_list"
        success_url = "@ai.llm_list"
        success_message = _("Your LLM model has been deleted.")
