import requests
from smartmin.views import SmartCRUDL, SmartFormView

from django import forms
from django.contrib import messages
from django.http import HttpResponseRedirect
from django.urls import reverse
from django.utils.translation import gettext_lazy as _

from temba.channels.models import Channel
from temba.orgs.views.base import BaseListView, BaseReadView, BaseUsagesModal
from temba.orgs.views.mixins import OrgPermsMixin
from temba.utils.views.mixins import ContextMenuMixin, SpaMixin

from .models import Template, TemplateTranslation


class TemplateCRUDL(SmartCRUDL):
    model = Template
    actions = ("list", "read", "usages", "refresh")

    class List(SpaMixin, ContextMenuMixin, BaseListView):
        default_order = ("-created_on",)

        def derive_menu_path(self):
            return "/msg/templates"

        def get_queryset(self, **kwargs):
            return Template.annotate_usage(
                super().get_queryset(**kwargs).exclude(base_translation=None)  # don't show "empty" templates
            )

        def build_context_menu(self, menu):
            menu.add_url_post(_("Refresh"), reverse("templates.template_refresh"), as_button=True)

    class Read(SpaMixin, BaseReadView):
        status_icons = {
            TemplateTranslation.STATUS_PENDING: "template_pending",
            TemplateTranslation.STATUS_APPROVED: "template_approved",
            TemplateTranslation.STATUS_REJECTED: "template_rejected",
            TemplateTranslation.STATUS_PAUSED: "template_rejected",
            TemplateTranslation.STATUS_DISABLED: "template_rejected",
            TemplateTranslation.STATUS_IN_APPEAL: "template_pending",
        }

        def derive_menu_path(self):
            return "/msg/templates"

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)

            base_trans = context["object"].base_translation
            all_trans = context["object"].translations.order_by("locale", "channel")
            other_trans = all_trans.exclude(id=base_trans.id) if base_trans else all_trans

            context["base_translation"] = base_trans
            context["other_translations"] = other_trans
            context["status_icons"] = self.status_icons
            return context

    class Usages(BaseUsagesModal):
        permission = "templates.template_read"

    class Refresh(SpaMixin, OrgPermsMixin, SmartFormView):
        class Form(forms.Form):
            pass

        form_class = Form
        fields = ()
        permission = "templates.template_list"
        success_url = "@templates.template_list"
        success_message = _("Your templates have been fetched and refreshed.")
        title = ""
        submit_button_name = _("Refresh")

        def post(self, *args, **kwargs):
            # get all active channels for types that use templates
            channel_types = [t.code for t in Channel.get_types() if t.template_type]
            channels = self.request.org.channels.filter(is_active=True, channel_type__in=channel_types)

            has_errors = False
            for channel in channels:
                try:
                    channel.refresh_templates()
                except requests.RequestException:
                    has_errors = True

            if has_errors:
                messages.error(self.request, _("Unable to refresh all templates. See the log for details."))
            else:
                messages.info(self.request, self.success_message)

            return HttpResponseRedirect(self.get_success_url())
