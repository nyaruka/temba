from smartmin.views import SmartCreateView, SmartCRUDL

from django import forms
from django.db.models.functions import Lower
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.utils.functional import cached_property
from django.utils.html import format_html, format_html_join
from django.utils.safestring import mark_safe
from django.utils.translation import gettext_lazy as _

from temba.contacts.models import ContactField, ContactGroup
from temba.flows.models import Flow
from temba.msgs.models import Msg
from temba.orgs.views.base import (
    BaseDeleteModal,
    BaseListView,
    BaseMenuView,
    BaseReadView,
    BaseUpdateModal,
    BaseUpdateView,
)
from temba.orgs.views.mixins import BulkActionMixin, OrgPermsMixin
from temba.templates.models import Template, TemplateTranslation
from temba.utils import json, languages
from temba.utils.compose import compose_deserialize, compose_serialize
from temba.utils.fields import ComposeField, ComposeWidget, InputWidget, SelectWidget, TembaChoiceField
from temba.utils.views.mixins import ContextMenuMixin, ModalFormMixin, SpaMixin

from .models import Campaign, CampaignEvent


class CampaignForm(forms.ModelForm):
    group = TembaChoiceField(
        queryset=ContactGroup.objects.none(),
        empty_label=None,
        widget=SelectWidget(attrs={"placeholder": _("Select group"), "searchable": True}),
        label=_("Group"),
        help_text=_("Only contacts in this group will be included in this campaign's events."),
    )

    def __init__(self, org, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.fields["group"].queryset = ContactGroup.get_groups(org).order_by(Lower("name"))

    class Meta:
        model = Campaign
        fields = ("name", "group")
        labels = {"name": _("Name")}
        widgets = {"name": InputWidget()}


class CampaignCRUDL(SmartCRUDL):
    model = Campaign
    actions = ("create", "read", "update", "list", "delete", "archived", "archive", "activate", "menu")

    class Menu(BaseMenuView):
        def derive_menu(self):
            org = self.request.org

            menu = []
            menu.append(
                self.create_menu_item(
                    menu_id="active",
                    name=_("Active"),
                    icon="campaign_active",
                    count=org.campaigns.filter(is_active=True, is_archived=False).count(),
                    href="campaigns.campaign_list",
                )
            )

            menu.append(
                self.create_menu_item(
                    menu_id="archived",
                    name=_("Archived"),
                    icon="campaign_archived",
                    count=org.campaigns.filter(is_active=True, is_archived=True).count(),
                    href="campaigns.campaign_archived",
                    perm="campaigns.campaign_list",
                )
            )

            return menu

    class Update(BaseUpdateModal):
        fields = ("name", "group")
        form_class = CampaignForm
        success_url = "uuid@campaigns.campaign_read"

        def derive_queryset(self, **kwargs):
            return super().derive_queryset(**kwargs).filter(is_archived=False)

        def form_valid(self, form):
            previous_group = self.get_object().group
            new_group = form.cleaned_data["group"]

            # save our campaign
            self.object = form.save(commit=False)
            self.save(self.object)

            # if our group changed, create our new fires
            if new_group != previous_group:
                for event in self.object.get_events():
                    event.schedule_async()

            return self.render_modal_response(form)

    class Read(SpaMixin, ContextMenuMixin, BaseReadView):
        menu_path = "/campaign/active"

        def derive_title(self):
            return self.object.name

        def build_context_menu(self, menu):
            obj = self.get_object()

            if obj.is_archived:
                if self.has_org_perm("campaigns.campaign_activate"):
                    menu.add_url_post(_("Activate"), reverse("campaigns.campaign_activate", args=[obj.uuid]))

                if self.has_org_perm("orgs.org_export"):
                    menu.add_link(_("Export"), f"{reverse('orgs.org_export')}?campaign={obj.id}&archived=1")
                if self.has_org_perm("campaigns.campaign_delete"):
                    menu.new_group()
                    menu.add_modax(
                        _("Delete"),
                        "campaign-delete",
                        reverse("campaigns.campaign_delete", args=[obj.uuid]),
                        title=_("Delete Campaign"),
                    )
            else:
                if self.has_org_perm("campaigns.campaignevent_create"):
                    menu.add_modax(
                        _("New Event"),
                        "event-add",
                        reverse("campaigns.campaignevent_create", args=[obj.id]),
                        as_button=True,
                    )

                if self.has_org_perm("campaigns.campaign_update"):
                    menu.add_modax(
                        _("Edit"),
                        "campaign-update",
                        reverse("campaigns.campaign_update", args=[obj.uuid]),
                        title=_("Edit Campaign"),
                    )

                if self.has_org_perm("orgs.org_export"):
                    menu.add_link(_("Export"), f"{reverse('orgs.org_export')}?campaign={obj.id}")

                if self.has_org_perm("campaigns.campaign_archive"):
                    menu.add_url_post(_("Archive"), reverse("campaigns.campaign_archive", args=[obj.uuid]))

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["events"] = self.object.get_sorted_events()
            return context

    class Create(ModalFormMixin, OrgPermsMixin, SmartCreateView):
        fields = ("name", "group")
        form_class = CampaignForm
        success_url = "uuid@campaigns.campaign_read"

        def pre_save(self, obj):
            obj = super().pre_save(obj)
            obj.org = self.request.org
            return obj

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["org"] = self.request.org
            return kwargs

    class BaseList(SpaMixin, ContextMenuMixin, BulkActionMixin, BaseListView):
        permission = "campaigns.campaign_list"
        fields = ("name", "group")
        default_template = "campaigns/campaign_list.html"
        default_order = ("-modified_on",)

    class List(BaseList):
        title = _("Active")
        bulk_actions = ("archive",)
        search_fields = ("name__icontains", "group__name__icontains")
        menu_path = "/campaign/active"

        def get_queryset(self, *args, **kwargs):
            return super().get_queryset(*args, **kwargs).filter(is_archived=False)

        def build_context_menu(self, menu):
            if self.has_org_perm("campaigns.campaign_create"):
                menu.add_modax(
                    _("New Campaign"),
                    "event-update",
                    reverse("campaigns.campaign_create"),
                    title=_("New Campaign"),
                    as_button=True,
                )

    class Archived(BaseList):
        title = _("Archived")
        bulk_actions = ("restore",)
        menu_path = "/campaign/archived"

        def get_queryset(self, *args, **kwargs):
            return super().get_queryset(*args, **kwargs).filter(is_archived=True)

    class Archive(BaseUpdateView):
        fields = ()
        success_url = "uuid@campaigns.campaign_read"
        success_message = _("Campaign archived")

        def save(self, obj):
            obj.apply_action_archive(self.request.user, Campaign.objects.filter(id=obj.id))
            return obj

    class Activate(BaseUpdateView):
        fields = ()
        success_url = "uuid@campaigns.campaign_read"
        success_message = _("Campaign activated")

        def save(self, obj):
            obj.apply_action_restore(self.request.user, Campaign.objects.filter(id=obj.id))
            return obj

    class Delete(BaseDeleteModal):
        cancel_url = "uuid@campaigns.campaign_read"
        redirect_url = "@campaigns.campaign_list"

        def get_queryset(self, **kwargs):
            qs = super().get_queryset(**kwargs)
            return qs.filter(is_archived=True)


class CampaignEventForm(forms.ModelForm):
    event_type = forms.ChoiceField(
        choices=((CampaignEvent.TYPE_MESSAGE, "Send a message"), (CampaignEvent.TYPE_FLOW, "Start a flow")),
        required=True,
        widget=SelectWidget(attrs={"placeholder": _("Select the event type"), "widget_only": True}),
    )

    direction = forms.ChoiceField(
        choices=(("B", "Before"), ("A", "After")),
        required=True,
        widget=SelectWidget(attrs={"placeholder": _("Relative date direction"), "widget_only": True}),
    )

    unit = forms.ChoiceField(
        choices=CampaignEvent.UNIT_CHOICES,
        required=True,
        widget=SelectWidget(attrs={"placeholder": _("Select a unit"), "widget_only": True}),
    )

    flow_to_start = TembaChoiceField(
        queryset=Flow.objects.none(),
        required=False,
        empty_label=None,
        widget=SelectWidget(
            attrs={
                "placeholder": _("Select a flow to start"),
                "widget_only": True,
                "searchable": True,
            }
        ),
    )

    relative_to = TembaChoiceField(
        queryset=ContactField.objects.none(),
        required=False,
        empty_label=None,
        widget=SelectWidget(
            attrs={
                "placeholder": _("Select a date field to base this event on"),
                "widget_only": True,
                "searchable": True,
            }
        ),
    )

    delivery_hour = forms.ChoiceField(
        choices=CampaignEvent.get_hour_choices(),
        required=False,
        widget=SelectWidget(attrs={"placeholder": _("Select hour for delivery"), "widget_only": True}),
    )

    flow_start_mode = forms.ChoiceField(
        choices=(
            (CampaignEvent.MODE_INTERRUPT, _("Stop it and run this flow")),
            (CampaignEvent.MODE_SKIP, _("Skip this event")),
        ),
        required=False,
        widget=SelectWidget(attrs={"widget_only": True}),
    )

    message_start_mode = forms.ChoiceField(
        choices=(
            (CampaignEvent.MODE_INTERRUPT, _("Stop it and send the message")),
            (CampaignEvent.MODE_SKIP, _("Skip this message")),
            (CampaignEvent.MODE_PASSIVE, _("Send the message")),
        ),
        required=False,
        widget=SelectWidget(attrs={"widget_only": True}),
    )

    compose = ComposeField(
        required=False,
        label="",
        widget=ComposeWidget(
            attrs={
                "chatbox": True,
                "attachments": True,
                "counter": True,
                "completion": True,
                "quickreplies": True,
                "templates": True,
                "hide_label": True,
                "min-height": 60,
                "maxlength": Msg.MAX_TEXT_LEN,
                "maxAttachments": Msg.MAX_ATTACHMENTS,
            }
        ),
    )

    def _base_language(self):
        if self.instance.id and self.instance.base_language:
            return self.instance.base_language
        return self.org.flow_languages[0]

    def clean(self):
        data = super().clean()

        if self.data["event_type"] == CampaignEvent.TYPE_MESSAGE:
            compose = data.get("compose") or {}
            base_language = self._base_language()
            primary_language = self.org.flow_languages[0] if self.org.flow_languages else None

            def is_missing(values):
                if values:
                    return not (
                        values.get("text", "") or values.get("attachments", []) or values.get("quick_replies", [])
                    )
                return True

            base = compose.get(base_language)
            primary = compose.get(primary_language)
            if is_missing(base) and is_missing(primary):
                self.add_error("compose", _("This field is required."))

            for values in compose.values():
                if values:
                    text = values.get("text", "")
                    attachments = values.get("attachments", [])
                    if text and len(text) > Msg.MAX_TEXT_LEN:
                        self.add_error("compose", _(f"Maximum allowed text is {Msg.MAX_TEXT_LEN} characters."))
                    if attachments and len(attachments) > Msg.MAX_ATTACHMENTS:
                        self.add_error("compose", _(f"Maximum allowed attachments is {Msg.MAX_ATTACHMENTS} files."))

            primary_values = compose.get(primary_language) or compose.get(base_language, {})
            template = primary_values.get("template", None)
            locale = primary_values.get("locale", None)
            variables = primary_values.get("variables", [])
            if template:
                translation = TemplateTranslation.objects.filter(
                    template__org=self.org, template__uuid=template, locale=locale
                ).first()
                if translation:
                    for idx, param in enumerate(translation.variables):
                        if param.get("type") != "text":
                            if idx >= len(variables) or not variables[idx]:
                                self.add_error("compose", _("The attachment for the WhatsApp template is required."))

            if not data.get("message_start_mode"):
                self.add_error("message_start_mode", _("This field is required."))
        else:
            if not data.get("flow_to_start"):
                self.add_error("flow_to_start", _("This field is required."))
            if not data.get("flow_start_mode"):
                self.add_error("flow_start_mode", _("This field is required."))

        return data

    def pre_save(self, request, obj):
        # if it's before, negate the offset
        if self.cleaned_data["direction"] == "B":
            obj.offset = -obj.offset

        if self.cleaned_data["unit"] == "H" or self.cleaned_data["unit"] == "M":  # pragma: needs cover
            obj.delivery_hour = -1

        # if its a message flow, set that accordingly
        if self.cleaned_data["event_type"] == CampaignEvent.TYPE_MESSAGE:
            base_language = self._base_language()
            compose = self.cleaned_data.get("compose") or {}

            # pull the template off the primary/base translation before deserializing
            primary_language = self.org.flow_languages[0] if self.org.flow_languages else base_language
            template_uuid = None
            template_variables = []
            primary_values = compose.get(primary_language) or compose.get(base_language) or {}
            if primary_values.get("template"):
                template_uuid = primary_values.pop("template", None)
                template_variables = primary_values.pop("variables", [])
                primary_values.pop("locale", None)

            # remove template-related keys from all translations so they aren't stored per-language
            for values in compose.values():
                if isinstance(values, dict):
                    values.pop("template", None)
                    values.pop("variables", None)
                    values.pop("locale", None)

            # only keep translations that have actual content
            trimmed = {}
            for lang, values in compose.items():
                text = (values.get("text") or "").strip() if values else ""
                attachments = values.get("attachments", []) if values else []
                quick_replies = values.get("quick_replies", []) if values else []
                if text or attachments or quick_replies:
                    trimmed[lang] = values

            obj.translations = compose_deserialize(trimmed)
            obj.base_language = base_language
            obj.start_mode = self.cleaned_data["message_start_mode"]
            obj.flow = None

            if template_uuid:
                obj.template = Template.objects.filter(org=self.org, uuid=template_uuid).first()
                obj.template_variables = list(template_variables) if template_variables else None
            else:
                obj.template = None
                obj.template_variables = None

        # otherwise, it's an event that runs an existing flow
        else:
            obj.flow = self.cleaned_data["flow_to_start"]
            obj.start_mode = self.cleaned_data["flow_start_mode"]
            obj.translations = None
            obj.base_language = None
            obj.template = None
            obj.template_variables = None

            # force passive mode for user-selected background flows
            if obj.flow.flow_type == Flow.TYPE_BACKGROUND:
                obj.start_mode = CampaignEvent.MODE_PASSIVE

    def __init__(self, org, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.org = org

        relative_to = self.fields["relative_to"]
        relative_to.queryset = org.fields.filter(is_active=True, value_type=ContactField.TYPE_DATETIME).order_by(
            Lower("name")
        )

        flow = self.fields["flow_to_start"]
        flow.queryset = org.flows.filter(
            flow_type__in=[Flow.TYPE_MESSAGE, Flow.TYPE_VOICE, Flow.TYPE_BACKGROUND],
            is_active=True,
            is_archived=False,
            is_system=False,
        ).order_by("name")

        if (
            self.instance.id
            and self.instance.event_type == CampaignEvent.TYPE_FLOW
            and self.instance.flow.flow_type == Flow.TYPE_BACKGROUND
        ):
            flow.widget.attrs["info_text"] = CampaignEventCRUDL.BACKGROUND_WARNING

        # build compose initial and language list
        base_language = self.instance.base_language if self.instance.id else org.flow_languages[0]
        isos = list(org.flow_languages)

        compose = {}
        if self.instance.id and self.instance.event_type == CampaignEvent.TYPE_MESSAGE and self.instance.translations:
            compose = compose_serialize(self.instance.translations, base_language=base_language)

            # remove any languages not present on the org, except the base language
            for iso in list(compose.keys()):
                if iso != base_language and iso not in isos:
                    del compose[iso]

            # ensure base language is represented in the iso list
            if base_language not in isos:
                if isos and isos[0] in compose:
                    isos.append(base_language)
                else:
                    isos.insert(0, base_language)
            elif isos[0] not in compose:
                isos.remove(base_language)
                isos.insert(0, base_language)

            if self.instance.template:
                compose.setdefault(base_language, {})
                compose[base_language]["template"] = str(self.instance.template.uuid)
                compose[base_language]["variables"] = self.instance.template_variables or []

        langs = [{"iso": iso, "name": str(_("Default")) if iso == "und" else languages.get_name(iso)} for iso in isos]
        compose_attrs = self.fields["compose"].widget.attrs
        compose_attrs["languages"] = json.dumps(langs)
        self.fields["compose"].initial = compose

    class Meta:
        model = CampaignEvent
        fields = (
            "event_type",
            "relative_to",
            "offset",
            "unit",
            "delivery_hour",
            "direction",
            "flow_to_start",
            "flow_start_mode",
            "message_start_mode",
        )
        widgets = {"offset": InputWidget(attrs={"widget_only": True})}


class CampaignEventCRUDL(SmartCRUDL):
    model = CampaignEvent
    actions = ("create", "delete", "read", "update")

    BACKGROUND_WARNING = _(
        "This is a background flow. When it triggers, it will run it for all contacts without interruption."
    )

    class Read(SpaMixin, ContextMenuMixin, BaseReadView):
        title = _("Event History")
        model_org_lookup = "campaign__org"

        @classmethod
        def derive_url_pattern(cls, path, action):
            return r"^%s/%s/(?P<campaign_uuid>[0-9a-f-]{36})/(?P<uuid>[0-9a-f-]{36})/$" % (path, action)

        def derive_menu_path(self):
            return f"/campaign/{'archived' if self.get_object().campaign.is_archived else 'active'}/"

        def get_queryset(self):
            return super().get_queryset().filter(is_active=True)

        def get_object_org(self):
            return self.get_object().campaign.org

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["recent_fires"] = self.object.get_recent_fires()

            if self.object.event_type == CampaignEvent.TYPE_MESSAGE and self.object.translations:
                org_langs = self.object.campaign.org.flow_languages
                names = sorted(
                    languages.get_name(iso)
                    for iso in self.object.translations.keys()
                    if iso != self.object.base_language and iso in org_langs
                )
                bolded = [format_html("<b>{}</b>", n) for n in names]
                if len(bolded) == 1:
                    context["translations_summary"] = bolded[0]
                elif len(bolded) == 2:
                    context["translations_summary"] = format_html(
                        _("{first} and {second}"), first=bolded[0], second=bolded[1]
                    )
                elif len(bolded) > 2:
                    context["translations_summary"] = format_html(
                        _("{list}, and {last}"),
                        list=mark_safe(format_html_join(", ", "{}", ((b,) for b in bolded[:-1]))),
                        last=bolded[-1],
                    )
                context["translation_count"] = len(bolded)
            return context

        def build_context_menu(self, menu):
            obj = self.get_object()

            if (
                self.has_org_perm("campaigns.campaignevent_update")
                and obj.status != obj.STATUS_SCHEDULING
                and not obj.campaign.is_archived
            ):
                menu.add_modax(
                    _("Edit"),
                    "event-update",
                    reverse("campaigns.campaignevent_update", args=[obj.uuid]),
                    title=_("Edit Event"),
                    as_button=True,
                )

            if self.has_org_perm("campaigns.campaignevent_delete"):
                menu.add_modax(
                    _("Delete"),
                    "event-delete",
                    reverse("campaigns.campaignevent_delete", args=[obj.uuid]),
                    title=_("Delete Event"),
                )

    class Delete(BaseDeleteModal):
        model_org_lookup = "campaign__org"

        def get_object_org(self):
            return self.get_object().campaign.org

        def get_redirect_url(self):
            return reverse("campaigns.campaign_read", args=[self.object.campaign.uuid])

        def get_cancel_url(self):  # pragma: needs cover
            return reverse("campaigns.campaign_read", args=[self.object.campaign.uuid])

    class Update(BaseUpdateModal):
        form_class = CampaignEventForm
        fields = (
            "event_type",
            "flow_to_start",
            "offset",
            "unit",
            "direction",
            "relative_to",
            "delivery_hour",
            "message_start_mode",
            "flow_start_mode",
            "compose",
        )
        model_org_lookup = "campaign__org"

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["org"] = self.request.org
            return kwargs

        def get_queryset(self):
            return super().get_queryset().filter(status=CampaignEvent.STATUS_READY, campaign__is_archived=False)

        def get_object_org(self):
            return self.get_object().campaign.org

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["background_warning"] = CampaignEventCRUDL.BACKGROUND_WARNING
            return context

        def derive_initial(self):
            initial = super().derive_initial()

            if self.object.offset < 0:
                initial["direction"] = "B"
                initial["offset"] = abs(self.object.offset)
            else:
                initial["direction"] = "A"

            if self.object.event_type == "F":
                initial["flow_to_start"] = self.object.flow
                initial["flow_start_mode"] = self.object.start_mode
            else:
                initial["message_start_mode"] = self.object.start_mode

            return initial

        def pre_save(self, obj):
            obj = super().pre_save(obj)
            self.form.pre_save(self.request, obj)

            prev = CampaignEvent.objects.get(id=obj.id)
            if prev.event_type == CampaignEvent.TYPE_MESSAGE and (
                obj.event_type == CampaignEvent.TYPE_FLOW and prev.flow
            ):  # pragma: needs cover
                flow = prev.flow
                flow.is_active = False
                flow.save(update_fields=("is_active",))
                obj.translations = None
                obj.base_language = None

            # if we changed scheduling, update the fire version to invalidate existing fires
            if (
                prev.unit != obj.unit
                or prev.offset != obj.offset
                or prev.relative_to != obj.relative_to
                or prev.delivery_hour != obj.delivery_hour
            ):
                obj.schedule_async()

            return obj

        def get_success_url(self):
            return reverse("campaigns.campaignevent_read", args=[self.object.campaign.uuid, self.object.uuid])

    class Create(ModalFormMixin, OrgPermsMixin, SmartCreateView):
        fields = (
            "event_type",
            "flow_to_start",
            "offset",
            "unit",
            "direction",
            "relative_to",
            "delivery_hour",
            "message_start_mode",
            "flow_start_mode",
            "compose",
        )
        form_class = CampaignEventForm
        template_name = "campaigns/campaignevent_update.html"

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["background_warning"] = CampaignEventCRUDL.BACKGROUND_WARNING
            return context

        @classmethod
        def derive_url_pattern(cls, path, action):
            return r"^%s/%s/(?P<campaign_id>\d+)/$" % (path, action)

        @cached_property
        def campaign(self):
            return get_object_or_404(
                Campaign, id=self.kwargs["campaign_id"], org=self.request.org, is_active=True, is_archived=False
            )

        def get_success_url(self):
            return reverse("campaigns.campaign_read", args=[self.object.campaign.uuid])

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["org"] = self.request.org
            return kwargs

        def derive_initial(self):
            initial = super().derive_initial()
            initial["unit"] = "D"
            initial["offset"] = "15"
            initial["direction"] = "A"
            initial["event_type"] = "M"
            initial["message_start_mode"] = "I"
            initial["delivery_hour"] = "-1"

            # default to our first date field
            initial["relative_to"] = self.request.org.fields.filter(
                is_active=True, value_type=ContactField.TYPE_DATETIME
            ).first()

            return initial

        def post_save(self, obj):
            obj = super().post_save(obj)
            obj.schedule_async()
            return obj

        def pre_save(self, obj):
            obj = super().pre_save(obj)
            obj.campaign = self.campaign
            self.form.pre_save(self.request, obj)
            return obj
