from smartmin.views import SmartCRUDL, SmartUpdateView

from django import forms
from django.urls import reverse
from django.utils.translation import gettext_lazy as _

from temba.orgs.views.base import BaseCreateModal, BaseDependencyDeleteModal, BaseListView, BaseUsagesModal
from temba.orgs.views.mixins import OrgObjPermsMixin, UniqueNameMixin
from temba.utils.fields import InputWidget
from temba.utils.views.mixins import ContextMenuMixin, ModalFormMixin, ScopedUpdateMixin, SpaMixin

from .models import Global


class CreateGlobalForm(UniqueNameMixin, forms.ModelForm):
    def __init__(self, *args, **kwargs):
        self.org = kwargs["org"]
        del kwargs["org"]

        super().__init__(*args, **kwargs)

    def clean_name(self):
        name = super().clean_name()

        if not Global.is_valid_name(name):
            raise forms.ValidationError(_("Can only contain letters, numbers and hypens."))

        if not Global.is_valid_key(Global.make_key(name)):
            raise forms.ValidationError(_("Isn't a valid name"))

        return name

    class Meta:
        model = Global
        fields = ("name", "value")
        widgets = {
            "name": InputWidget(attrs={"name": _("Name"), "widget_only": False}),
            "value": InputWidget(attrs={"name": _("Value"), "widget_only": False, "textarea": True}),
        }


class UpdateGlobalForm(forms.ModelForm):
    def __init__(self, *args, **kwargs):
        self.org = kwargs["org"]
        del kwargs["org"]

        super().__init__(*args, **kwargs)

    class Meta:
        model = Global
        fields = ("value",)
        widgets = {
            "value": InputWidget(attrs={"name": _("Value"), "widget_only": False, "textarea": True}),
        }


class GlobalCRUDL(SmartCRUDL):
    model = Global
    actions = ("create", "update", "delete", "list", "unused", "usages")

    class Create(BaseCreateModal):
        form_class = CreateGlobalForm
        submit_button_name = _("Create")

        def form_valid(self, form):
            self.object = Global.get_or_create(
                self.request.org,
                self.request.user,
                key=Global.make_key(name=form.cleaned_data["name"]),
                name=form.cleaned_data["name"],
                value=form.cleaned_data["value"],
            )

            return self.render_modal_response(form)

    class Update(ModalFormMixin, OrgObjPermsMixin, ScopedUpdateMixin, SmartUpdateView):
        form_class = UpdateGlobalForm
        submit_button_name = _("Update")

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["org"] = self.derive_org()
            return kwargs

    class Delete(BaseDependencyDeleteModal):
        cancel_url = "@globals.global_list"
        success_url = "@globals.global_list"

    class List(SpaMixin, ContextMenuMixin, BaseListView):
        title = _("Globals")
        fields = ("name", "key", "value")
        search_fields = ("name__icontains", "key__icontains")
        default_order = ("key",)
        paginate_by = 250
        menu_path = "/flow/globals"

        def build_context_menu(self, menu):
            if self.has_org_perm("globals.global_create") and not self.is_limit_reached:
                menu.add_modax(
                    _("New"),
                    "new-global",
                    reverse("globals.global_create"),
                    title=_("New Global"),
                    as_button=True,
                    on_redirect="refreshGlobals()",
                )

        def get_queryset(self, **kwargs):
            qs = super().get_queryset(**kwargs)
            return Global.annotate_usage(qs)

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)

            org_globals = self.request.org.globals.filter(is_active=True)
            all_count = org_globals.count()
            unused_count = Global.annotate_usage(org_globals).filter(usage_count=0).count()

            context["global_categories"] = [
                {"label": _("All"), "count": all_count, "url": reverse("globals.global_list")},
                {"label": _("Unused"), "count": unused_count, "url": reverse("globals.global_unused")},
            ]

            return context

    class Unused(List):
        def get_queryset(self, **kwargs):
            return super().get_queryset(**kwargs).filter(usage_count=0)

    class Usages(BaseUsagesModal):
        permission = "globals.global_read"
