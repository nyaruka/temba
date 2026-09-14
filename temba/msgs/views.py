import mimetypes
import os
from functools import cached_property
from urllib.parse import quote_plus

import magic
from smartmin.views import SmartCreateView, SmartCRUDL, SmartDeleteView, SmartUpdateView

from django import forms
from django.conf import settings
from django.db.models.functions.text import Lower
from django.http import HttpResponse, HttpResponseRedirect, JsonResponse
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from django.views.generic import RedirectView

from temba import mailroom
from temba.mailroom.client.types import Exclusions
from temba.orgs.models import Org
from temba.orgs.views.base import (
    BaseCreateModal,
    BaseDependencyDeleteModal,
    BaseExportModal,
    BaseListComponentView,
    BaseListView,
    BaseMenuView,
    BaseUsagesModal,
)
from temba.orgs.views.mixins import OrgObjPermsMixin, OrgPermsMixin, UniqueNameMixin
from temba.templates.models import Template
from temba.utils import json
from temba.utils.compose import compose_deserialize, compose_serialize
from temba.utils.fields import ContactSearchWidget, InputWidget, SelectWidget
from temba.utils.views.mixins import (
    ModalFormMixin,
    ModalHeaderMixin,
    PostOnlyMixin,
    SpaMixin,
    StaffOnlyMixin,
)
from temba.utils.views.wizard import SmartWizardUpdateView, SmartWizardView

from .forms import ComposeForm, ScheduleForm, TargetForm
from .models import Broadcast, Label, LabelCount, Media, MessageExport, Msg, MsgFolder


class MsgListView(BaseListComponentView):
    """
    Base class for message list views with message folders and labels listed by the side
    """

    permission = "msgs.msg_list"
    default_order = ("-created_on", "-id")
    allow_export = False
    bulk_actions = ()
    bulk_action_permissions = {"resend": "msgs.msg_create", "delete": "msgs.msg_update"}
    template_name = "msgs/msg_list.html"
    folder = None
    list_endpoint = "api.internal.messages"

    BULK_ACTION_CONFIG = {
        "label": {"label": _("Label"), "icon": "tag-01", "labelsEndpoint": "/api/v2/labels.json"},
        "archive": {"label": _("Archive"), "icon": "archive"},
        # `restore_messages` resolves to inbox-01 in temba-components — the
        # generic `restore` icon is a play button (used for reactivating
        # flows/triggers/campaigns) which reads strangely for messages.
        "restore": {"label": _("Restore"), "icon": "restore_messages"},
        "delete": {
            "label": _("Delete"),
            "icon": "delete",
            "destructive": True,
            "confirm": _("Delete selected messages? This cannot be undone."),
        },
        "resend": {"label": _("Resend"), "icon": "send"},
    }

    def pre_process(self, request, *args, **kwargs):
        if self.folder:
            self.queryset = self.folder.get_queryset(request.org)

        return super().pre_process(request, *args, **kwargs)

    def derive_folder(self):
        return self.folder

    def derive_list_query(self) -> str:
        # the built-in folders are selected by name, a user label by uuid
        folder = self.derive_folder()
        if isinstance(folder, Label):
            return f"label={folder.uuid}"

        return f"folder={folder.name.lower()}"

    def derive_bulk_action_config(self, key: str) -> dict:
        cfg = super().derive_bulk_action_config(key)
        if key == "label":
            # the dropdown's "New Label…" row only renders for viewers who can create labels
            cfg["allowCreate"] = self.has_org_perm("msgs.label_create")
        return cfg

    def derive_export_url(self):
        redirect = quote_plus(self.request.get_full_path())
        folder = self.derive_folder()
        label_id = folder.uuid if isinstance(folder, Label) else folder.code
        return "%s?l=%s&redirect=%s" % (reverse("msgs.msg_export"), label_id, redirect)

    def get_queryset(self, **kwargs):
        return super().get_queryset(**kwargs).select_related("contact", "channel", "flow")

    def get_bulk_action_labels(self):
        return self.request.org.msgs_labels.filter(is_active=True).order_by(Lower("name"))

    def build_context_menu(self, menu):
        if self.has_org_perm("msgs.broadcast_create"):
            menu.add_modax(
                _("Send"),
                "send-message",
                reverse("msgs.broadcast_create"),
                title=_("New Broadcast"),
                as_button=True,
                primary=True,
            )
        if self.has_org_perm("msgs.label_create"):
            menu.add_modax(_("New Label"), "new-msg-label", reverse("msgs.label_create"), title=_("New Label"))

        if self.allow_export and self.has_org_perm("msgs.msg_export"):
            menu.add_modax(_("Export"), "export-messages", self.derive_export_url(), title=_("Export Messages"))


class BroadcastCRUDL(SmartCRUDL):
    actions = (
        "list",
        "create",
        "update",
        "scheduled",
        "scheduled_delete",
        "preview",
        "interrupt",
    )
    model = Broadcast

    class BaseList(BaseListComponentView):
        """
        Base class for the broadcast list views (sent and scheduled)
        """

        template_name = "msgs/broadcast_list.html"
        list_endpoint = "api.internal.broadcasts"

        # The internal-API folder (and the component's `mode`) this view lists — `sent` or `scheduled`.
        list_folder = "sent"

        def derive_list_query(self) -> str:
            return f"folder={self.list_folder}"

        def get_queryset(self, **kwargs):
            # the component fetches and pages broadcasts itself, and these views have no bulk actions, so the page
            # never needs an object list
            return Broadcast.objects.none()

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)

            # the component's mode
            context["list_mode"] = self.list_folder

            return context

        def build_context_menu(self, menu):
            if self.has_org_perm("msgs.broadcast_create"):
                menu.add_modax(
                    _("New Broadcast"),
                    "new-scheduled",
                    reverse("msgs.broadcast_create"),
                    as_button=True,
                )

    class List(BaseList):
        title = _("Broadcasts")
        menu_path = "/msg/broadcasts"
        default_order = ("-created_on", "-id")
        list_folder = "sent"

        def get_queryset(self, **kwargs):
            return super().get_queryset(**kwargs).filter(schedule=None)

    class Scheduled(BaseList):
        title = _("Scheduled Broadcasts")
        menu_path = "/msg/scheduled"
        default_order = ("schedule__next_fire", "-created_on")
        list_folder = "scheduled"

        def get_queryset(self, **kwargs):
            return super().get_queryset(**kwargs).exclude(schedule=None)

    class Create(ModalHeaderMixin, OrgPermsMixin, SmartWizardView):
        form_list = [("target", TargetForm), ("compose", ComposeForm), ("schedule", ScheduleForm)]
        success_url = "@msgs.broadcast_scheduled"
        submit_button_name = _("Create")
        modal_header_bg = "#8e5ea7"
        modal_header_text = "#fff"

        def derive_readonly_servicing(self):
            return self.request.POST.get("create-current_step") == "schedule"

        def get_form_kwargs(self, step):
            return {"org": self.request.org, "features": self.request.branding.get("features", [])}

        def get_form_initial(self, step):
            initial = super().get_form_initial(step)

            if step == "target":
                org = self.request.org
                contact_uuids = [_ for _ in self.request.GET.get("c", "").split(",") if _]
                contacts = org.contacts.filter(uuid__in=contact_uuids)

                initial["contact_search"] = {
                    "recipients": ContactSearchWidget.get_recipients(contacts),
                    "advanced": False,
                    "query": None,
                    "exclusions": settings.DEFAULT_EXCLUSIONS,
                }
                return initial

        def done(self, form_list, form_dict, **kwargs):
            user = self.request.user
            org = self.request.org
            compose = form_dict["compose"].cleaned_data["compose"]
            translations = compose_deserialize(compose)
            base_language = next(iter(translations))
            template = None
            template_variables = []

            # extract template which is packed into the base translation
            for trans in compose.values():
                if trans.get("template"):
                    template = Template.objects.filter(org=org, uuid=trans.pop("template")).first()
                    template_variables = trans.pop("variables", [])

            contact_search = form_dict["target"].cleaned_data["contact_search"]
            schedule_form = form_dict["schedule"]
            send_when = schedule_form.cleaned_data["send_when"]
            schedule = None

            if send_when == ScheduleForm.SEND_LATER:
                start = schedule_form.cleaned_data["start_datetime"].astimezone(org.timezone)
                schedule = mailroom.ScheduleSpec(
                    start=start.isoformat(),
                    repeat_period=schedule_form.cleaned_data["repeat_period"],
                    repeat_days_of_week=schedule_form.cleaned_data["repeat_days_of_week"],
                )

            if contact_search.get("advanced"):  # pragma: needs cover
                groups = []
                contacts = []
                query = contact_search.get("parsed_query")
                exclude = Exclusions()
            else:
                groups, contacts = ContactSearchWidget.parse_recipients(
                    self.request.org, contact_search.get("recipients", [])
                )
                query = None
                exclude = Exclusions(**contact_search.get("exclusions", {}))

            self.object = Broadcast.create(
                org,
                user,
                translations,
                base_language=base_language,
                groups=groups,
                contacts=contacts,
                query=query,
                exclude=exclude,
                template=template,
                template_variables=template_variables,
                schedule=schedule,
            )

            if send_when == ScheduleForm.SEND_NOW:
                return HttpResponseRedirect(reverse("msgs.broadcast_list"))

            return HttpResponseRedirect(self.get_success_url())

    class Update(ModalHeaderMixin, OrgObjPermsMixin, SmartWizardUpdateView):
        form_list = [("target", TargetForm), ("compose", ComposeForm), ("schedule", ScheduleForm)]
        # this wizard view resolves its object through Django's SingleObjectMixin rather than smartmin's, and that
        # doesn't default `slug_field` to the url kwarg, so both are needed
        slug_url_kwarg = "uuid"
        slug_field = "uuid"
        success_url = "@msgs.broadcast_scheduled"
        submit_button_name = _("Save")
        modal_header_bg = "#8e5ea7"
        modal_header_text = "#fff"

        def derive_readonly_servicing(self):
            return self.request.POST.get("update-current_step") == "schedule"

        def get_form_kwargs(self, step):
            return {"org": self.request.org, "features": self.request.branding.get("features", [])}

        def get_form_initial(self, step):
            org = self.request.org

            if step == "target":
                recipients = ContactSearchWidget.get_recipients(self.object.contacts.all(), self.object.groups.all())
                query = self.object.query if not recipients else None
                return {
                    "contact_search": {
                        "recipients": recipients,
                        "advanced": bool(query),
                        "query": query,
                        "exclusions": self.object.exclusions,
                    }
                }

            if step == "compose":
                base_language = self.object.base_language

                compose = compose_serialize(self.object.translations, base_language=self.object.base_language)

                # remove any languages not present on the org
                langs = [k for k in compose.keys()]
                for iso in langs:
                    if iso != base_language and iso not in org.flow_languages:
                        del compose[iso]

                if self.object.template:
                    compose[base_language]["template"] = str(self.object.template.uuid)
                    compose[base_language]["variables"] = self.object.template_variables

                return {"compose": compose, "base_language": base_language}

            if step == "schedule":
                schedule = self.object.schedule
                return {
                    "start_datetime": schedule.next_fire,
                    "repeat_period": schedule.repeat_period,
                    "repeat_days_of_week": list(schedule.repeat_days_of_week) if schedule.repeat_days_of_week else [],
                }

        def done(self, form_list, form_dict, **kwargs):
            broadcast = self.object
            schedule = broadcast.schedule

            # update message
            compose = form_dict["compose"].cleaned_data["compose"]
            composeBase = compose[broadcast.base_language]

            contact_search = form_dict["target"].cleaned_data["contact_search"]

            template = composeBase.pop("template", None)
            template_variables = composeBase.pop("variables", [])
            if template:
                template = Template.objects.filter(org=broadcast.org, uuid=template).first()

            # determine our new recipients
            if contact_search.get("advanced"):  # pragma: needs cover
                groups = []
                contacts = []
                query = contact_search.get("parsed_query")
                exclusions = {}
            else:
                groups, contacts = ContactSearchWidget.parse_recipients(
                    self.request.org, contact_search.get("recipients", [])
                )
                query = None
                exclusions = contact_search.get("exclusions", {})

            broadcast.translations = compose_deserialize(compose)
            broadcast.query = query
            broadcast.exclusions = exclusions
            broadcast.template = template
            broadcast.template_variables = template_variables
            broadcast.save()

            broadcast.update_recipients(groups=groups, contacts=contacts)

            # finally, update schedule
            schedule_form = form_dict["schedule"]
            start_time = schedule_form.cleaned_data["start_datetime"]
            repeat_period = schedule_form.cleaned_data["repeat_period"]
            repeat_days_of_week = schedule_form.cleaned_data["repeat_days_of_week"]
            schedule.update_schedule(start_time, repeat_period, repeat_days_of_week=repeat_days_of_week)
            broadcast.save()

            return HttpResponseRedirect(self.get_success_url())

    class ScheduledDelete(ModalFormMixin, OrgObjPermsMixin, SmartDeleteView):
        default_template = "broadcast_scheduled_delete.html"
        slug_url_kwarg = "uuid"
        success_url = "@msgs.broadcast_scheduled"
        cancel_url = "@msgs.broadcast_scheduled"
        fields = ("uuid",)
        submit_button_name = _("Delete")

        def post(self, request, *args, **kwargs):
            self.get_object().delete(self.request.user, soft=True)

            response = HttpResponse()
            response["X-Temba-Success"] = self.get_success_url()
            return response

    class Preview(OrgPermsMixin, SmartCreateView):
        permission = "msgs.broadcast_create"
        readonly_servicing = False

        blockers = {
            "no_send_channel": _(
                'To get started you need to <a href="%(link)s">add a channel</a> to your workspace which will allow '
                "you to send messages to your contacts."
            ),
            "outbox_full": _(
                "You have too many messages queued in your outbox. Please wait for these messages to send and then try again."
            ),
        }

        def get_blockers(self, org) -> list:
            blockers = []

            if org.is_outbox_full():
                blockers.append(self.blockers["outbox_full"])

            if org.is_suspended:
                blockers.append(Org.BLOCKER_SUSPENDED)
            elif org.is_flagged:
                blockers.append(Org.BLOCKER_FLAGGED)

            if not org.get_send_channel():
                blockers.append(self.blockers["no_send_channel"] % {"link": reverse("channels.channel_claim")})

            return blockers

        def post(self, request, *args, **kwargs):
            payload = json.loads(request.body)
            include = mailroom.Inclusions(**payload.get("include", {}))
            exclude = mailroom.Exclusions(**payload.get("exclude", {}))

            try:
                query, total = Broadcast.preview(self.request.org, include=include, exclude=exclude)
            except mailroom.QueryValidationException as e:
                return JsonResponse({"query": "", "total": 0, "error": str(e)}, status=400)

            return JsonResponse(
                {
                    "query": query,
                    "total": total,
                    "warnings": [],
                    "blockers": self.get_blockers(self.request.org),
                }
            )

    class Interrupt(ModalFormMixin, OrgObjPermsMixin, SmartUpdateView):
        default_template = "smartmin/delete_confirm.html"
        slug_url_kwarg = "uuid"
        permission = "msgs.broadcast_update"
        fields = ()
        submit_button_name = _("Interrupt")
        success_url = "@msgs.broadcast_list"

        def post(self, request, *args, **kwargs):
            broadcast = self.get_object()
            broadcast.interrupt(self.request.user)
            return super().post(request, *args, **kwargs)


class MsgCRUDL(SmartCRUDL):
    model = Msg
    actions = ("inbox", "flow", "archived", "menu", "outbox", "sent", "failed", "filter", "export", "legacy_inbox")

    class Menu(BaseMenuView):
        def derive_menu(self):
            org = self.request.org
            counts = MsgFolder.get_counts(org)

            menu = [
                self.create_menu_item(
                    menu_id="inbox",
                    name=_("Inbox"),
                    href=reverse("msgs.msg_inbox"),
                    count=counts[MsgFolder.INBOX],
                    icon="inbox",
                ),
                self.create_menu_item(
                    menu_id="handled",
                    name=_("Handled"),
                    href=reverse("msgs.msg_flow"),
                    count=counts[MsgFolder.HANDLED],
                    icon="flow",
                ),
                self.create_menu_item(
                    menu_id="archived",
                    name=_("Archived"),
                    href=reverse("msgs.msg_archived"),
                    count=counts[MsgFolder.ARCHIVED],
                    icon="archive",
                ),
                self.create_divider(),
                self.create_menu_item(
                    menu_id="outbox",
                    name=_("Outbox"),
                    href=reverse("msgs.msg_outbox"),
                    count=counts[MsgFolder.OUTBOX],
                    icon="template_pending" if counts[MsgFolder.OUTBOX] >= Org.OUTBOX_WARNING_THRESHOLD else None,
                ),
                self.create_menu_item(
                    menu_id="sent",
                    name=_("Sent"),
                    href=reverse("msgs.msg_sent"),
                    count=counts[MsgFolder.SENT],
                ),
                self.create_menu_item(
                    menu_id="failed",
                    name=_("Failed"),
                    href=reverse("msgs.msg_failed"),
                    count=counts[MsgFolder.FAILED],
                ),
                self.create_divider(),
                self.create_menu_item(
                    menu_id="scheduled",
                    name=_("Scheduled"),
                    href=reverse("msgs.broadcast_scheduled"),
                    count=counts["scheduled"],
                ),
                self.create_menu_item(
                    menu_id="broadcasts",
                    name=_("Broadcasts"),
                    href=reverse("msgs.broadcast_list"),
                ),
                self.create_menu_item(
                    menu_id="templates",
                    name=_("Templates"),
                    href=reverse("templates.template_list"),
                ),
                self.create_divider(),
                self.create_menu_item(
                    menu_id="calls",
                    name=_("Calls"),
                    href=reverse("ivr.call_list"),
                    count=counts["calls"],
                ),
            ]

            labels = Label.get_active_for_org(org).order_by(Lower("name"))
            label_items = []
            label_counts = LabelCount.get_totals([lb for lb in labels])
            for label in labels:
                label_items.append(
                    self.create_menu_item(
                        icon="label",
                        menu_id=label.uuid,
                        name=label.name,
                        count=label_counts[label],
                        href=reverse("msgs.msg_filter", args=[label.uuid]),
                    )
                )

            if label_items:
                menu.append(self.create_menu_item(menu_id="labels", name="Labels", items=label_items, inline=True))

            return menu

    class Export(BaseExportModal):
        class Form(BaseExportModal.Form):
            LABEL_CHOICES = ((0, _("Just this label")), (1, _("All messages")))
            FOLDER_CHOICES = ((0, _("Just this folder")), (1, _("All messages")))

            export_all = forms.ChoiceField(
                choices=(), label=_("Selection"), initial=0, widget=SelectWidget(attrs={"widget_only": True})
            )

            def __init__(self, org, label, *args, **kwargs):
                super().__init__(org, *args, **kwargs)

                self.fields["export_all"].choices = self.LABEL_CHOICES if label else self.FOLDER_CHOICES

        form_class = Form
        export_type = MessageExport
        success_url = "@msgs.msg_inbox"

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["label"] = self.derive_folder()[1]
            return kwargs

        def derive_folder(self) -> tuple:
            # is either a UUID of a Label instance (36 chars) or a folder code (1 char)
            label_id = self.request.GET["l"]
            if len(label_id) == 1:
                return MsgFolder.from_code(label_id), None
            else:
                return None, Label.get_active_for_org(self.request.org).get(uuid=label_id)

        def create_export(self, org, user, form):
            export_all = bool(int(form.cleaned_data["export_all"]))
            start_date = form.cleaned_data["start_date"]
            end_date = form.cleaned_data["end_date"]
            with_fields = form.cleaned_data["with_fields"]
            with_groups = form.cleaned_data["with_groups"]

            folder, label = (None, None) if export_all else self.derive_folder()

            return MessageExport.create(
                org,
                user,
                start_date=start_date,
                end_date=end_date,
                folder=folder,
                label=label,
                with_fields=with_fields,
                with_groups=with_groups,
            )

    class LegacyInbox(RedirectView):
        url = "/msg"

        @classmethod
        def derive_url_pattern(cls, path, action):
            return r"^%s/inbox/$" % (path)

    class Inbox(MsgListView):
        title = _("Inbox")
        subtitle = _("Incoming messages that weren't automatically handled by a flow.")
        folder = MsgFolder.INBOX
        search_fields = ("text__icontains", "contact__name__icontains")
        bulk_actions = ("label", "archive")
        allow_export = True
        menu_path = "/msg/inbox"

        @classmethod
        def derive_url_pattern(cls, path, action):
            return r"^%s/$" % (path)

        def get_queryset(self, **kwargs):
            return super().get_queryset(**kwargs).prefetch_related("labels")

    class Flow(MsgListView):
        title = _("Handled")
        subtitle = _("Incoming messages that were handled by a flow.")
        folder = MsgFolder.HANDLED
        search_fields = ("text__icontains", "contact__name__icontains")
        bulk_actions = ("label", "archive")
        allow_export = True
        menu_path = "/msg/handled"

        def get_queryset(self, **kwargs):
            return super().get_queryset(**kwargs).prefetch_related("labels")

    class Archived(MsgListView):
        title = _("Archived")
        subtitle = _("Incoming messages you've archived from your inbox.")
        folder = MsgFolder.ARCHIVED
        search_fields = ("text__icontains", "contact__name__icontains")
        bulk_actions = ("restore", "label", "delete")
        allow_export = True

        def get_queryset(self, **kwargs):
            return super().get_queryset(**kwargs).prefetch_related("labels")

    class Outbox(MsgListView):
        title = _("Outbox")
        subtitle = _("Outgoing messages queued to be sent.")
        folder = MsgFolder.OUTBOX
        bulk_actions = ()
        allow_export = True

    class Sent(MsgListView):
        title = _("Sent")
        subtitle = _("Outgoing messages that have been sent.")
        folder = MsgFolder.SENT
        bulk_actions = ()
        allow_export = True

    class Failed(MsgListView):
        title = _("Failed")
        subtitle = _("Outgoing messages that couldn't be delivered.")
        folder = MsgFolder.FAILED
        allow_export = True

        def get_bulk_actions(self):
            return () if self.request.org.is_suspended else ("resend",)

    class Filter(MsgListView):
        search_fields = ("text__icontains", "contact__name__icontains")
        bulk_actions = ("label",)

        def derive_menu_path(self):
            return f"/msg/labels/{self.label.uuid}"

        def derive_title(self, *args, **kwargs):
            return self.label.name

        def derive_subtitle(self):
            return _("Messages tagged with the %(label)s label.") % {"label": self.label.name}

        def build_context_menu(self, menu):
            if self.has_org_perm("msgs.msg_update"):
                menu.add_modax(
                    _("Edit"),
                    "update-label",
                    reverse("msgs.label_update", args=[self.label.id]),
                    title=_("Edit Label"),
                )

            if self.has_org_perm("msgs.label_delete"):
                menu.add_modax(
                    _("Delete"),
                    "delete-label",
                    reverse("msgs.label_delete", args=[self.label.uuid]),
                    title=_("Delete Label"),
                )

            menu.new_group()

            if self.has_org_perm("msgs.msg_export"):
                menu.add_modax(_("Export"), "export-messages", self.derive_export_url(), title=_("Export Messages"))

            menu.add_modax(_("Usages"), "label-usages", reverse("msgs.label_usages", args=[self.label.uuid]))

        @classmethod
        def derive_url_pattern(cls, path, action):
            return r"^%s/%s/(?P<label_uuid>[^/]+)/$" % (path, action)

        @cached_property
        def label(self):
            return self.request.org.msgs_labels.get(uuid=self.kwargs["label_uuid"])

        def derive_folder(self):
            return self.label

        def get_queryset(self, **kwargs):
            return (
                super()
                .get_queryset(**kwargs)
                .filter(labels=self.label)
                .exclude(folder=Msg.FOLDER_DELETED)
                .prefetch_related("labels")
            )


class BaseLabelForm(UniqueNameMixin, forms.ModelForm):
    def __init__(self, org, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.org = org

    class Meta:
        model = Label
        fields = ("name",)
        labels = {"name": _("Name")}
        widgets = {"name": InputWidget()}


class LabelForm(BaseLabelForm):
    messages = forms.CharField(required=False, widget=forms.HiddenInput)

    def __init__(self, org, *args, **kwargs):
        super().__init__(org, *args, **kwargs)

    class Meta(BaseLabelForm.Meta):
        fields = ("name",)


class LabelCRUDL(SmartCRUDL):
    model = Label
    actions = ("create", "update", "usages", "delete")

    class Create(BaseCreateModal):
        fields = ("name", "messages")
        success_url = "uuid@msgs.msg_filter"
        form_class = LabelForm
        submit_button_name = _("Create")

        def save(self, obj):
            self.object = Label.create(self.request.org, self.request.user, obj.name)

        def post_save(self, obj, *args, **kwargs):
            obj = super().post_save(obj, *args, **kwargs)
            if self.form.cleaned_data["messages"]:  # pragma: needs cover
                msg_ids = [int(m) for m in self.form.cleaned_data["messages"].split(",") if m.isdigit()]
                msgs = Msg.objects.filter(org=obj.org, pk__in=msg_ids)
                if msgs:
                    obj.toggle_label(msgs, add=True)

            return obj

    class Update(ModalFormMixin, OrgObjPermsMixin, SmartUpdateView):
        form_class = LabelForm
        success_url = "uuid@msgs.msg_filter"
        title = _("Update Label")
        submit_button_name = _("Save")

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["org"] = self.request.org
            return kwargs

    class Usages(BaseUsagesModal):
        permission = "msgs.label_read"

    class Delete(BaseDependencyDeleteModal):
        cancel_url = "@msgs.msg_inbox"
        success_url = "@msgs.msg_inbox"
        success_message = _("Your label has been deleted.")


class MediaCRUDL(SmartCRUDL):
    model = Media
    path = "msgmedia"  # so we don't conflict with the /media directory
    actions = ("upload", "list")

    class Upload(PostOnlyMixin, OrgPermsMixin, SmartCreateView):
        """
        TODO deprecated, migrate usages to /api/v2/media.json
        """

        permission = "msgs.media_create"

        def post(self, request, *args, **kwargs):
            file = request.FILES["file"]

            filename, file_extension = os.path.splitext(file.name)
            detected_type = magic.from_buffer(next(file.chunks(chunk_size=2048)), mime=True)
            possible_extensions = mimetypes.guess_all_extensions(detected_type)
            if len(possible_extensions) > 0 and file_extension not in possible_extensions:
                return JsonResponse({"error": _("Unsupported file type")})

            if not Media.is_allowed_type(detected_type):
                return JsonResponse({"error": _("Unsupported file type")})
            if file.size > Media.MAX_UPLOAD_SIZE:
                limit_MB = Media.MAX_UPLOAD_SIZE / (1024 * 1024)
                return JsonResponse({"error": _("Limit for file uploads is %s MB") % limit_MB})

            media = Media.from_upload(request.org, request.user, file)

            return JsonResponse(
                {
                    "uuid": str(media.uuid),
                    "content_type": media.content_type,
                    "type": media.content_type,
                    "url": media.url,
                    "name": media.filename,
                    "size": media.size,
                }
            )

    class List(StaffOnlyMixin, SpaMixin, BaseListView):
        fields = ("url", "content_type", "size", "created_by", "created_on")
        default_order = ("-created_on",)

        def derive_queryset(self, **kwargs):
            return super().derive_queryset(**kwargs).filter(original=None)
