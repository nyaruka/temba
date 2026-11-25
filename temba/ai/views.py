import json

from smartmin.views import SmartCRUDL

from django import forms
from django.db.models.functions import Lower
from django.http import JsonResponse
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from django.views.decorators.csrf import csrf_exempt

from temba import mailroom
from temba.orgs.views.base import BaseDependencyDeleteModal, BaseListView, BaseReadView, BaseUpdateModal
from temba.orgs.views.mixins import OrgPermsMixin, UniqueNameMixin
from temba.utils.fields import InputWidget, SelectWidget
from temba.utils.views.mixins import ContextMenuMixin, PostOnlyMixin, SpaMixin
from temba.utils.views.wizard import SmartWizardView

from .models import LLM


class BaseConnectWizard(OrgPermsMixin, SmartWizardView):
    class Form(forms.Form):
        def __init__(self, org, llm_type, *args, **kwargs):
            super().__init__(*args, **kwargs)

            self.org = org
            self.llm_type = llm_type

    permission = "ai.llm_connect"
    menu_path = "/settings/ai/new-model"
    template_name = "ai/llm_connect_form.html"
    success_url = "@ai.llm_list"
    llm_type = None

    def __init__(self, llm_type, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.llm_type = llm_type

    def get_form_kwargs(self, step=None):
        kwargs = super().get_form_kwargs(step)
        kwargs["org"] = self.request.org
        kwargs["llm_type"] = self.llm_type
        return kwargs

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["form_blurb"] = self.llm_type.get_form_blurb()
        return context


class ModelForm(BaseConnectWizard.Form):
    """
    Reusable wizard form for selecting a model.
    """

    model = forms.ChoiceField(
        label=_("Model"), widget=SelectWidget(), help_text=_("Choose the model you would like to use.")
    )

    def __init__(self, model_choices, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.fields["model"].choices = model_choices


class NameForm(BaseConnectWizard.Form):
    """
    Reusable wizard form for giving a name to a model.
    """

    name = forms.CharField(
        label=_("Name"), widget=InputWidget(), help_text=_("Give your model a memorable name."), required=True
    )

    def __init__(self, model_name: str, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.fields["name"].initial = model_name

    def clean_name(self):
        name = self.cleaned_data["name"]

        # make sure the name isn't already taken
        if self.org.llms.filter(is_active=True, name__iexact=name).exists():
            raise forms.ValidationError(_("Must be unique."))

        return name


class LLMCRUDL(SmartCRUDL):
    model = LLM
    actions = ("list", "update", "translate", "delete")

    class List(SpaMixin, ContextMenuMixin, BaseListView):
        title = _("Artificial Intelligence")
        menu_path = "settings/ai"
        default_order = (Lower("name"),)

        def derive_queryset(self, **kwargs):
            return super().derive_queryset(**kwargs).filter(is_system=False)

        def build_context_menu(self, menu):
            if self.has_org_perm("ai.llm_connect") and not self.is_limit_reached():
                org = self.request.org
                user = self.request.user
                for llm_type in LLM.get_types():
                    if not llm_type.is_available_to(org, user):
                        continue
                    menu.add_modax(
                        f"New {llm_type.name}",
                        f"new-{llm_type.slug}",
                        reverse(f"ai.types.{llm_type.slug}.connect"),
                        title=llm_type.name,
                    )

    class Update(BaseUpdateModal):
        class Form(UniqueNameMixin, forms.ModelForm):
            def __init__(self, org, *args, **kwargs):
                super().__init__(*args, **kwargs)

                self.org = org

            class Meta:
                model = LLM
                fields = ("name",)

        form_class = Form
        success_url = "@ai.llm_list"

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
                return JsonResponse({"error": str(e)}, status=400)

            return JsonResponse({"items": items})

    class Delete(BaseDependencyDeleteModal):
        cancel_url = "@ai.llm_list"
        success_url = "@ai.llm_list"
        success_message = _("Your LLM model has been deleted.")
