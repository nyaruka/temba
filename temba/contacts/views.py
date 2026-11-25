import logging
from collections import OrderedDict
from urllib.parse import quote_plus
from uuid import UUID

from smartmin.views import SmartCreateView, SmartCRUDL, SmartListView, SmartUpdateView, SmartView

from django import forms
from django.conf import settings
from django.contrib import messages
from django.core.exceptions import ValidationError
from django.core.validators import FileExtensionValidator
from django.db import transaction
from django.db.models.functions import Upper
from django.http import HttpResponse, HttpResponseNotFound, HttpResponseRedirect, JsonResponse
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.utils import timezone
from django.utils.functional import Promise, cached_property
from django.utils.translation import gettext_lazy as _
from django.views import View

from temba import mailroom
from temba.channels.models import Channel
from temba.orgs.models import Org
from temba.orgs.views.base import (
    BaseCreateModal,
    BaseDeleteModal,
    BaseDependencyDeleteModal,
    BaseExportModal,
    BaseListView,
    BaseMenuView,
    BaseReadView,
    BaseUpdateModal,
    BaseUsagesModal,
)
from temba.orgs.views.mixins import BulkActionMixin, OrgObjPermsMixin, OrgPermsMixin, UniqueNameMixin
from temba.tickets.models import Topic
from temba.users.models import User
from temba.utils import json, on_transaction_commit
from temba.utils.fields import CheckboxWidget, InputWidget, SelectWidget, TembaChoiceField
from temba.utils.models import patch_queryset_count
from temba.utils.models.es import SearchSliceQuerySet
from temba.utils.views.mixins import ContextMenuMixin, ModalFormMixin, NonAtomicMixin, SpaMixin

from .forms import ContactGroupForm, CreateContactForm, UpdateContactForm
from .models import URN, Contact, ContactExport, ContactField, ContactGroup, ContactImport
from .omnibox import omnibox_query, omnibox_serialize

logger = logging.getLogger(__name__)


class ContactListView(SpaMixin, BulkActionMixin, BaseListView):
    """
    Base class for contact list views with contact folders and groups listed by the side
    """

    permission = "contacts.contact_list"
    system_group = None
    add_button = True
    paginate_by = 50

    parsed_query = None
    search_is_saveable = None

    sort_field = None
    sort_direction = None

    search_fields = ("name",)  # so that search box is displayed
    search_error = None
    search_max_length = ContactGroup.MAX_QUERY_LEN

    # Gated behind global preview mode (PreviewMiddleware → request.preview). When the viewer is in preview, every
    # contact list view renders the temba-contact-list component (contacts/contact_list_new.html) instead of its
    # legacy table; the component fetches/pages contacts itself from the internal contacts API.
    NEW_LIST_TEMPLATE = "contacts/contact_list_new.html"

    # Optional subtitle rendered under the title on the new-list view; subclasses override to carry the intro text the
    # legacy templates rendered in their pre-table block.
    subtitle = ""

    # Maps a view's system group to the `folder` the internal contacts API expects; user groups pass `group=<uuid>`.
    FOLDER_BY_SYSTEM_GROUP = {
        ContactGroup.TYPE_DB_ACTIVE: "active",
        ContactGroup.TYPE_DB_BLOCKED: "blocked",
        ContactGroup.TYPE_DB_STOPPED: "stopped",
        ContactGroup.TYPE_DB_ARCHIVED: "archived",
    }

    # Bulk-action key -> config consumed by temba-contact-list (label, icon, destructive/confirm). `clientOnly` actions
    # (send / start-flow) open a modal seeded with the selected contacts rather than POSTing to the action endpoint.
    # `labelsEndpoint` turns the action into a dropdown of (static) groups to add/remove the selection to/from —
    # mirroring the message list's label dropdown.
    BULK_ACTION_CONFIG = {
        "send": {"label": _("Send"), "icon": "compose", "clientOnly": True},
        "start-flow": {"label": _("Start Flow"), "icon": "flow", "clientOnly": True},
        "label": {
            "label": _("Group"),
            "icon": "group",
            "labelsEndpoint": "/api/v2/groups.json?manual_only=1",
            "labelsKey": "groups",
        },
        "block": {"label": _("Block"), "icon": "contact_blocked"},
        "archive": {"label": _("Archive"), "icon": "archive"},
        "restore": {"label": _("Reactivate"), "icon": "restore"},
        "unlabel": {"label": _("Remove from group"), "icon": "group_exclude"},
        "delete": {
            "label": _("Delete"),
            "icon": "delete",
            "destructive": True,
            "confirm": _("Delete selected contacts? This cannot be undone."),
        },
    }

    def _use_new_list(self) -> bool:
        # `getattr` defaults to False so a view called via RequestFactory (or if PreviewMiddleware is reordered out)
        # doesn't AttributeError.
        return getattr(self.request, "preview", False)

    def get_template_names(self):
        if self._use_new_list():
            return [self.NEW_LIST_TEMPLATE]
        return super().get_template_names()

    def get_paginate_by(self, queryset):
        # The temba-contact-list component fetches and pages contacts itself.
        if self._use_new_list():
            return None
        return super().get_paginate_by(queryset)

    def derive_subtitle(self):
        return self.subtitle

    def derive_new_list_query(self) -> str:
        if self.system_group:
            return f"folder={self.FOLDER_BY_SYSTEM_GROUP[self.system_group]}"
        return f"group={self.group.uuid}"

    def post(self, request, *args, **kwargs):
        # The component posts contact uuids in `objects`, but BulkActionMixin matches by primary key — translate them
        # here so the new component and the legacy id-based form post are both accepted. The group dropdown likewise
        # posts the target group by uuid (action=label, add=true|false), which the form matches by id — translate it
        # too. A fixed "unlabel" with no group (the group view's "Remove from group") falls back to the current group.
        if self._use_new_list():
            data = request.POST.copy()
            uuids = data.getlist("objects")
            if uuids:
                # Only keep well-formed UUIDs — `uuid__in` runs each value through UUIDField.get_prep_value, so a single
                # malformed value (a hostile post, or a stale id-based form post) would otherwise raise ValueError (500).
                valid = []
                for u in uuids:
                    try:
                        valid.append(UUID(u))
                    except ValueError:
                        pass
                ids = Contact.objects.filter(org=request.org, uuid__in=valid).values_list("id", flat=True)
                data.setlist("objects", [str(i) for i in ids])
            label = data.get("label")
            if label:
                try:
                    UUID(label)
                except ValueError:
                    pass  # already an id (legacy form post) — leave alone
                else:
                    group = request.org.groups.filter(uuid=label).first()
                    data["label"] = str(group.id) if group else ""
            elif data.get("action") == "unlabel" and self.group is not None:
                data["label"] = str(self.group.id)
            request.POST = data

        return super().post(request, *args, **kwargs)

    def pre_process(self, request, *args, **kwargs):
        """
        Don't allow pagination past 200th page
        """
        if int(self.request.GET.get("page", "1")) > 200:
            return HttpResponseNotFound()

        return super().pre_process(request, *args, **kwargs)

    @cached_property
    def group(self):
        return self.derive_group()

    def derive_group(self):
        return self.request.org.groups.get(group_type=self.system_group)

    def derive_export_url(self):
        search = quote_plus(self.request.GET.get("search", ""))
        return f"{reverse('contacts.contact_export')}?g={self.group.uuid}&s={search}"

    def get_bulk_action_labels(self):
        # The "label" bulk action (group dropdown) and "unlabel" validate their posted group against this queryset —
        # only static (manual) groups can have members added/removed.
        return ContactGroup.get_groups(self.request.org, manual_only=True)

    def get_queryset(self, **kwargs):
        # In preview the temba-contact-list component fetches and pages contacts from the internal contacts API, so a
        # GET page needs no object list — skip the mailroom/DB query entirely. A POST (bulk action) still needs the
        # real queryset, since BulkActionMixin validates the posted `objects` against it.
        if self._use_new_list() and self.request.method == "GET":
            return Contact.objects.none()

        org = self.request.org
        self.search_error = None

        # contact list views don't use regular field searching but use more complex contact searching
        search_query = self.request.GET.get("search", None)
        sort_on = self.request.GET.get("sort_on", "")
        page = self.request.GET.get("page", "1")

        offset = (int(page) - 1) * 50

        self.sort_direction = "desc" if sort_on.startswith("-") else "asc"
        self.sort_field = sort_on.lstrip("-")

        if search_query or sort_on:
            # is this request is part of a bulk action, get the ids that were modified so we can check which ones
            # should no longer appear in this view, even though ES won't have caught up yet
            bulk_action_ids = self.kwargs.get("bulk_action_ids", [])
            if bulk_action_ids:
                reappearing_ids = set(self.group.contacts.filter(id__in=bulk_action_ids).values_list("id", flat=True))
                exclude = list(
                    Contact.objects.filter(id__in=bulk_action_ids).exclude(id__in=reappearing_ids).only("id", "uuid")
                )
            else:
                exclude = []

            try:
                results = mailroom.get_client().contact_search(
                    org, self.group, search_query, sort=sort_on, offset=offset, exclude=exclude
                )
                self.parsed_query = results.query if len(results.query) > 0 else None
                self.search_is_saveable = results.metadata.allow_as_group

                return SearchSliceQuerySet(Contact, results.contact_uuids, offset=offset, total=results.total)
            except mailroom.QueryValidationException as e:
                self.search_error = str(e)

                # this should be an empty resultset
                return Contact.objects.none()
        else:
            # if user search is not defined, use DB to select contacts
            qs = self.group.contacts.filter(org=self.request.org).order_by("-id").prefetch_related("org", "groups")
            patch_queryset_count(qs, self.group.get_member_count)
            return qs

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        org = self.request.org

        # prefetch contact URNs
        Contact.bulk_urn_cache_initialize(context["object_list"])

        # get the first 6 featured fields as well as the last seen and created fields
        featured_fields = ContactField.get_fields(org, featured=True).order_by("-priority", "id")[0:6]
        proxy_fields = org.fields.filter(key__in=("last_seen_on", "created_on"), is_proxy=True).order_by("-key")
        context["contact_fields"] = list(featured_fields) + list(proxy_fields)

        context["search_error"] = self.search_error
        context["sort_direction"] = self.sort_direction
        context["sort_field"] = self.sort_field

        # replace search string with parsed search expression
        if self.parsed_query is not None:
            context["search"] = self.parsed_query
            context["search_is_saveable"] = self.search_is_saveable

        # New-list view context: the resolved contacts-api endpoint (folder= for the system groups, group= for a user
        # group), the subtitle, and the bulk-action configs the temba-contact-list expects (resolved + JSON-encoded
        # here so the template stays inert).
        if self._use_new_list():
            context["new_list_endpoint"] = f"{reverse('api.internal.contacts')}.json?{self.derive_new_list_query()}"
            subtitle = self.derive_subtitle()
            context["new_list_subtitle"] = str(subtitle) if subtitle else ""
            actions = []
            for key in self.get_bulk_actions():
                cfg = dict(self.BULK_ACTION_CONFIG.get(key, {}))
                cfg["key"] = key
                # Resolve any i18n lazy proxies so json_script / json.dumps don't choke.
                cfg = {k: (str(v) if isinstance(v, Promise) else v) for k, v in cfg.items()}
                actions.append(cfg)
            context["new_list_bulk_actions"] = actions

        return context


class ContactCRUDL(SmartCRUDL):
    model = Contact
    actions = (
        "create",
        "update",
        "search",
        "stopped",
        "archived",
        "list",
        "menu",
        "read",
        "group",
        "blocked",
        "omnibox",
        "open_ticket",
        "export",
        "interrupt",
        "delete",
        "timeline",
        "chat",
        "chat_search",
    )

    class Menu(BaseMenuView):
        def render_to_response(self, context, **response_kwargs):
            org = self.request.org
            counts = Contact.get_status_counts(org)
            menu = [
                {
                    "id": "active",
                    "count": counts[Contact.STATUS_ACTIVE],
                    "name": _("Active"),
                    "href": reverse("contacts.contact_list"),
                    "icon": "active",
                },
                {
                    "id": "archived",
                    "icon": "archive",
                    "count": counts[Contact.STATUS_ARCHIVED],
                    "name": _("Archived"),
                    "href": reverse("contacts.contact_archived"),
                },
                {
                    "id": "blocked",
                    "count": counts[Contact.STATUS_BLOCKED],
                    "name": _("Blocked"),
                    "href": reverse("contacts.contact_blocked"),
                    "icon": "contact_blocked",
                },
                {
                    "id": "stopped",
                    "count": counts[Contact.STATUS_STOPPED],
                    "name": _("Stopped"),
                    "href": reverse("contacts.contact_stopped"),
                    "icon": "contact_stopped",
                },
            ]

            menu.append(self.create_divider())
            menu.append(
                {
                    "id": "import",
                    "icon": "upload",
                    "href": reverse("contacts.contactimport_create"),
                    "name": _("Import"),
                }
            )

            if self.has_org_perm("contacts.contactfield_list"):
                menu.append(
                    dict(
                        id="fields",
                        icon="fields",
                        count=ContactField.get_fields(org).count(),
                        name=_("Fields"),
                        href=reverse("contacts.contactfield_list"),
                    )
                )

            groups = (
                ContactGroup.get_groups(org, ready_only=False)
                .select_related("org")
                .order_by("-group_type", Upper("name"))
            )
            group_counts = ContactGroup.get_member_counts(groups)
            group_items = []

            for g in groups:
                group_items.append(
                    self.create_menu_item(
                        menu_id=g.uuid,
                        name=g.name,
                        icon=g.icon,
                        count=group_counts[g],
                        href=reverse("contacts.contact_group", args=[g.uuid]),
                    )
                )

            if group_items:
                menu.append({"id": "group", "icon": "users", "name": _("Groups"), "items": group_items, "inline": True})

            return JsonResponse({"results": menu})

    class Export(BaseExportModal):
        export_type = ContactExport
        success_url = "@contacts.contact_list"
        size_limit = 1_000_000

        def derive_fields(self):
            return ("with_groups",)

        def get_blocker(self) -> str:
            if blocker := super().get_blocker():
                return blocker

            query = self.request.GET.get("s")
            total = mailroom.get_client().contact_export_preview(self.request.org, self.group, query)
            if total > self.size_limit:
                return "too-big"

            return ""

        @cached_property
        def group(self):
            org = self.request.org
            group_uuid = self.request.GET.get("g")
            return org.groups.filter(uuid=group_uuid).first() if group_uuid else org.active_contacts_group

        def create_export(self, org, user, form):
            search = self.request.GET.get("s")
            with_groups = form.cleaned_data["with_groups"]
            return ContactExport.create(org, user, group=self.group, search=search, with_groups=with_groups)

    class Omnibox(OrgPermsMixin, SmartListView):
        def get_queryset(self, **kwargs):
            return Contact.objects.none()

        def render_to_response(self, context, **response_kwargs):
            org = self.request.org
            groups, contacts = omnibox_query(org, **{k: v for k, v in self.request.GET.items()})
            results = omnibox_serialize(org, groups, contacts)

            return JsonResponse({"results": results, "more": False, "total": len(results), "err": "nil"})

    class Read(SpaMixin, ContextMenuMixin, BaseReadView):
        fields = ("name",)
        select_related = ("current_flow",)

        def derive_menu_path(self):
            return f"/contact/{self.object.get_status_display().lower()}"

        def derive_title(self):
            return self.object.get_display()

        def build_context_menu(self, menu):
            obj = self.get_object()

            if self.has_org_perm("contacts.contact_update"):
                menu.add_modax(
                    _("Edit"),
                    "edit-contact",
                    f"{reverse('contacts.contact_update', args=[obj.uuid])}",
                    title=_("Edit Contact"),
                    on_submit="contactUpdated()",
                    as_button=True,
                )

            if obj.status == Contact.STATUS_ACTIVE:
                if not obj.current_flow and self.has_org_perm("flows.flow_start"):
                    menu.add_modax(
                        _("Start Flow"),
                        "start-flow",
                        f"{reverse('flows.flow_start')}?c={obj.uuid}",
                        on_submit="contactUpdated()",
                        disabled=True,
                    )
                if self.has_org_perm("contacts.contact_open_ticket") and obj.ticket_count == 0:
                    menu.add_modax(
                        _("Open Ticket"), "open-ticket", reverse("contacts.contact_open_ticket", args=[obj.uuid])
                    )

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["msg_logs_after"] = (timezone.now() - settings.RETENTION_PERIODS["channellog"]).isoformat()
            return context

    class Timeline(BaseReadView):
        """
        Timeline of campaign events and broadcasts for a contact, both upcoming and past. Pass a
        `before` cursor (returned as `next_before`) to page further back through past events; pass
        an `after` cursor (returned as `next_after`) to page further forward through upcoming events.
        """

        permission = "contacts.contact_read"

        def render_to_response(self, context, **response_kwargs):
            before = self.request.GET.get("before") or None
            after = self.request.GET.get("after") or None
            return JsonResponse(self.object.get_timeline(before=before, after=after))

    class Chat(BaseReadView):
        """
        Returns chat history for a contact or sends a new message to the contact.
        """

        page_size = 50

        def get(self, request, *args, **kwargs):
            before = self._get_uuid_param("before")
            after = self._get_uuid_param("after")
            ticket = self._get_uuid_param("ticket")
            contact = self.get_object()

            if before:
                # a before value means UI is scrolling back thru historical events
                events = contact.get_history(request.user, before=before, ticket=ticket, limit=self.page_size + 1)
                page, more = events[: self.page_size], events[self.page_size :]
                return JsonResponse({"events": page, "next": page[-1]["uuid"] if more else None})
            elif after:
                # after value means UI is polling for new events
                events = contact.get_history(request.user, after=after, ticket=ticket, limit=self.page_size + 1)
                page, more = events[: self.page_size], events[self.page_size :]
                return JsonResponse({"events": list(reversed(page)), "next": page[-1]["uuid"] if more else None})
            else:
                return JsonResponse({"error": "must specify before or after parameter"}, status=400)

        def post(self, request, *args, **kwargs):
            payload = json.loads(request.body)
            text = payload.get("text", "")
            attachments = []
            ticket = None

            if attachment_uuids := payload.get("attachments"):
                attachments = request.org.media.filter(uuid__in=attachment_uuids)

            if ticket_uuid := payload.get("ticket"):
                ticket = request.org.tickets.filter(uuid=ticket_uuid).first()

            # check if user has permission to reply to tickets not assigned to them
            if ticket and ticket.assignee != request.user:
                membership = request.org.get_membership(request.user)
                if membership and not membership.can_reply_non_own:
                    return JsonResponse(
                        {"error": "You do not have permission to reply to tickets not assigned to you."}, status=403
                    )

            resp = mailroom.get_client().msg_send(
                request.org, request.user, self.get_object(), text, [str(a) for a in attachments], [], ticket
            )

            # update user ref with avatar
            if resp["event"].get("_user"):
                resp["event"]["_user"] = request.user.as_chat_ref()

            return JsonResponse({"event": resp["event"]})

        def _get_uuid_param(self, name: str) -> UUID:
            try:
                return UUID(self.request.GET.get(name))
            except ValueError, TypeError:
                return None

    class ChatSearch(BaseReadView):
        """
        Searches message text within a contact's chat history.
        """

        permission = "contacts.contact_chat"

        def get(self, request, *args, **kwargs):
            text = request.GET.get("text", "").strip()
            if not text:
                return JsonResponse({"results": []})

            contact = self.get_object()
            results = mailroom.get_client().msg_search(request.org, text, contact=contact)

            return JsonResponse({"results": [event for _, event in results]})

    class Search(ContactListView):
        template_name = "contacts/contact_list.html"

        def get(self, request, *args, **kwargs):
            org = self.request.org
            query = self.request.GET.get("search", None)
            samples = int(self.request.GET.get("samples", 10))

            if not query:
                return JsonResponse({"total": 0, "sample": [], "fields": {}})

            try:
                results = mailroom.get_client().contact_search(
                    org, org.active_contacts_group, query, sort="-created_on"
                )
                summary = {
                    "total": results.total,
                    "query": results.query,
                    "fields": results.metadata.fields,
                    "sample": SearchSliceQuerySet(Contact, results.contact_uuids, offset=0, total=results.total)[
                        0:samples
                    ],
                }
            except mailroom.QueryValidationException as e:
                return JsonResponse({"total": 0, "sample": [], "query": "", "error": str(e)})

            # serialize our contact sample
            json_contacts = []
            for contact in summary["sample"]:
                primary_urn = contact.get_urn()
                if primary_urn:
                    primary_urn = primary_urn.get_display(org=org, international=True)
                else:
                    primary_urn = "--"

                contact_json = {
                    "name": contact.name,
                    "fields": contact.fields if contact.fields else {},
                    "primary_urn_formatted": primary_urn,
                }
                contact_json["created_on"] = org.format_datetime(contact.created_on, show_time=False)
                contact_json["last_seen_on"] = org.format_datetime(contact.last_seen_on, show_time=False)

                json_contacts.append(contact_json)
            summary["sample"] = json_contacts

            # add in our field defs
            field_keys = [f["key"] for f in summary["fields"]]
            summary["fields"] = {
                str(f.uuid): {"label": f.name}
                for f in org.fields.filter(key__in=field_keys, is_active=True, is_proxy=False)
            }
            return JsonResponse(summary)

    class List(ContextMenuMixin, ContactListView):
        title = _("Active")
        system_group = ContactGroup.TYPE_DB_ACTIVE
        menu_path = "/contact/active"

        def get_bulk_actions(self):
            # "label" (the group dropdown) is a preview-list-only action — the legacy table has no UI for it.
            update = ("label", "block", "archive") if self._use_new_list() else ("block", "archive")
            actions = update if self.has_org_perm("contacts.contact_update") else ()
            if self.has_org_perm("msgs.broadcast_create"):
                actions += ("send",)
            if self.has_org_perm("flows.flow_start"):
                actions += ("start-flow",)
            return actions

        def has_context_menu(self):
            return self.has_org_perm("contacts.contact_create") or self.has_org_perm("contacts.contactgroup_create")

        def build_context_menu(self, menu):
            if search := self.request.GET.get("search"):
                try:
                    parsed = mailroom.get_client().contact_parse_query(self.request.org, search)
                    self.parsed_query = parsed.query
                    self.search_is_saveable = parsed.metadata.allow_as_group
                except mailroom.QueryValidationException as e:
                    self.search_error = str(e)

            if self.has_org_perm("contacts.contactgroup_create") and self.search_is_saveable:
                menu.add_modax(
                    _("Create Smart Group"),
                    "create-smartgroup",
                    f"{reverse('contacts.contactgroup_create')}?search={quote_plus(self.parsed_query)}",
                    as_button=True,
                )

            if self.has_org_perm("contacts.contact_create"):
                menu.add_modax(
                    _("New Contact"), "new-contact", reverse("contacts.contact_create"), title=_("New Contact")
                )

            if self.has_org_perm("contacts.contactgroup_create"):
                menu.add_modax(
                    _("New Group"), "new-group", reverse("contacts.contactgroup_create"), title=_("New Group")
                )

            if self.has_org_perm("contacts.contact_export") and not self.search_error:
                menu.add_modax(_("Export"), "export-contacts", self.derive_export_url(), title=_("Export Contacts"))

    class Blocked(ContextMenuMixin, ContactListView):
        title = _("Blocked")
        system_group = ContactGroup.TYPE_DB_BLOCKED

        def get_bulk_actions(self):
            return ("restore", "archive") if self.has_org_perm("contacts.contact_update") else ()

        def build_context_menu(self, menu):
            if self.has_org_perm("contacts.contact_export"):
                menu.add_modax(_("Export"), "export-contacts", self.derive_export_url(), title=_("Export Contacts"))

        def get_context_data(self, *args, **kwargs):
            context = super().get_context_data(*args, **kwargs)
            context["reply_disabled"] = True
            return context

    class Stopped(ContextMenuMixin, ContactListView):
        title = _("Stopped")
        template_name = "contacts/contact_stopped.html"
        system_group = ContactGroup.TYPE_DB_STOPPED
        subtitle = _(
            "These contacts have opted out and you can no longer send them messages, but inbound messages will "
            "unstop them. They have also been removed from all groups."
        )

        def get_bulk_actions(self):
            return ("restore", "archive") if self.has_org_perm("contacts.contact_update") else ()

        def build_context_menu(self, menu):
            if self.has_org_perm("contacts.contact_export"):
                menu.add_modax(_("Export"), "export-contacts", self.derive_export_url(), title=_("Export Contacts"))

        def get_context_data(self, *args, **kwargs):
            context = super().get_context_data(*args, **kwargs)
            context["reply_disabled"] = True
            return context

    class Archived(ContextMenuMixin, ContactListView):
        title = _("Archived")
        template_name = "contacts/contact_archived.html"
        system_group = ContactGroup.TYPE_DB_ARCHIVED
        subtitle = _("These contacts have been removed from all groups and can be deleted permanently.")
        bulk_action_permissions = {"delete": "contacts.contact_delete"}

        def get_bulk_actions(self):
            actions = []
            if self.has_org_perm("contacts.contact_update"):
                actions.append("restore")
            if self.has_org_perm("contacts.contact_delete"):
                actions.append("delete")
            return actions

        def get_context_data(self, *args, **kwargs):
            context = super().get_context_data(*args, **kwargs)
            context["reply_disabled"] = True
            return context

        def build_context_menu(self, menu):
            if self.has_org_perm("contacts.contact_export"):
                menu.add_modax(_("Export"), "export-contacts", self.derive_export_url(), title=_("Export Contacts"))

            if self.has_org_perm("contacts.contact_delete"):
                menu.add_js("contacts_delete_all", _("Delete All"))

    class Group(OrgObjPermsMixin, ContextMenuMixin, ContactListView):
        template_name = "contacts/contact_group.html"

        def build_context_menu(self, menu):
            if not self.group.is_system and self.has_org_perm("contacts.contactgroup_update"):
                menu.add_modax(_("Edit"), "edit-group", reverse("contacts.contactgroup_update", args=[self.group.uuid]))

            if self.has_org_perm("contacts.contact_export"):
                menu.add_modax(_("Export"), "export-contacts", self.derive_export_url(), title=_("Export Contacts"))

            menu.add_modax(_("Usages"), "group-usages", reverse("contacts.contactgroup_usages", args=[self.group.uuid]))

            if not self.group.is_system and self.has_org_perm("contacts.contactgroup_delete"):
                menu.add_modax(
                    _("Delete"), "delete-group", reverse("contacts.contactgroup_delete", args=[self.group.uuid])
                )

        def get_bulk_actions(self):
            actions = ()
            if self.has_org_perm("contacts.contact_update"):
                # the group action ("Remove from group") leads, matching the "Group" dropdown's slot on the active list
                actions += ("block", "archive") if self.group.is_smart else ("unlabel", "block")
            if self.has_org_perm("msgs.broadcast_create"):
                actions += ("send",)
            if self.has_org_perm("flows.flow_start"):
                actions += ("start-flow",)
            return actions

        def get_bulk_action_labels(self):
            return ContactGroup.get_groups(self.request.org, manual_only=True)

        def get_context_data(self, *args, **kwargs):
            context = super().get_context_data(*args, **kwargs)
            context["current_group"] = self.group
            return context

        @classmethod
        def derive_url_pattern(cls, path, action):
            return r"^%s/%s/(?P<uuid>[^/]+)/$" % (path, action)

        def derive_menu_path(self):
            return f"/contact/group/{self.kwargs['uuid']}"

        def get_object_org(self):
            return self.group.org

        def derive_title(self):
            return self.group.name

        def derive_subtitle(self):
            # Smart (dynamic) groups are defined by a query — surface it as the
            # list subtitle so the membership rule is visible in the header.
            if self.group.is_smart:
                return self.group.query
            return super().derive_subtitle()

        def derive_group(self):
            return get_object_or_404(
                ContactGroup.objects.filter(
                    uuid=self.kwargs["uuid"],
                    group_type__in=(ContactGroup.TYPE_MANUAL, ContactGroup.TYPE_SMART),
                    is_active=True,
                )
            )

    class Create(NonAtomicMixin, ModalFormMixin, OrgPermsMixin, SmartCreateView):
        form_class = CreateContactForm
        submit_button_name = _("Create")

        def get_form_kwargs(self, *args, **kwargs):
            kwargs = super().get_form_kwargs(*args, **kwargs)
            kwargs["org"] = self.request.org
            return kwargs

        def form_valid(self, form):
            name = self.form.cleaned_data.get("name")
            phone = self.form.cleaned_data.get("phone")
            urns = ["tel:" + phone] if phone else []

            try:
                Contact.create(
                    self.request.org,
                    self.request.user,
                    name=name,
                    language="",
                    status=Contact.STATUS_ACTIVE,
                    urns=urns,
                    fields={},
                    groups=[],
                )
            except mailroom.URNValidationException as e:  # pragma: needs cover
                error = _("In use by another contact.") if e.code == "taken" else _("Not a valid phone number.")
                self.form.add_error("phone", error)
                return self.form_invalid(form)

            return self.render_modal_response(form)

    class Update(NonAtomicMixin, BaseUpdateModal):
        form_class = UpdateContactForm
        success_url = "hide"

        def derive_exclude(self):
            obj = self.get_object()
            exclude = []
            exclude.extend(self.exclude)

            if obj.status != Contact.STATUS_ACTIVE:
                exclude.append("groups")

            return exclude

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["schemes"] = URN.SCHEME_CHOICES
            return context

        def form_valid(self, form):
            obj = self.get_object()
            data = form.cleaned_data
            user = self.request.user

            status = data.get("status")
            if status and status != obj.status:
                if status == Contact.STATUS_ACTIVE:
                    obj.restore(user)
                elif status == Contact.STATUS_ARCHIVED:
                    obj.archive(user)
                elif status == Contact.STATUS_BLOCKED:
                    obj.block(user)
                elif status == Contact.STATUS_STOPPED:
                    obj.stop(user)

            mods = obj.update(data.get("name"), data.get("language"))

            new_groups = self.form.cleaned_data.get("groups")
            if new_groups is not None:
                mods += obj.update_static_groups(new_groups)

            if not obj.org.is_anon:
                urns = []

                for field_key, value in self.form.data.items():
                    if field_key.startswith("urn__") and value:
                        parts = field_key.split("__")
                        scheme = parts[1]

                        order = int(self.form.data.get("order__" + field_key, "0"))
                        urns.append((order, URN.from_parts(scheme, value)))

                new_scheme = data.get("new_scheme", None)
                new_path = data.get("new_path", None)

                if new_scheme and new_path:
                    urns.append((len(urns), URN.from_parts(new_scheme, new_path)))

                # sort our urns by the supplied order
                urns = [urn[1] for urn in sorted(urns, key=lambda x: x[0])]
                mods += obj.update_urns(urns)

            try:
                obj.modify(self.request.user, mods)
            except Exception:
                errors = form._errors.setdefault(forms.forms.NON_FIELD_ERRORS, forms.utils.ErrorList())
                errors.append(_("An error occurred updating your contact. Please try again later."))
                return self.render_to_response(self.get_context_data(form=form))

            messages.success(self.request, self.derive_success_message())

            return self.render_modal_response(form)

    class OpenTicket(BaseUpdateModal):
        """
        Opens a new ticket for this contact.
        """

        class Form(forms.Form):
            topic = forms.ModelChoiceField(queryset=Topic.objects.none(), label=_("Topic"), required=True)
            assignee = forms.ModelChoiceField(
                queryset=User.objects.none(),
                label=_("Assignee"),
                widget=SelectWidget(),
                required=False,
                empty_label=_("Unassigned"),
            )
            note = forms.CharField(
                label=_("Note"),
                widget=InputWidget(attrs={"textarea": True, "placeholder": _("Optional")}),
                required=False,
            )

            def __init__(self, instance, org, **kwargs):
                super().__init__(**kwargs)

                self.fields["topic"].queryset = org.topics.filter(is_active=True).order_by("name")
                self.fields["assignee"].queryset = org.get_users().order_by("email")

        form_class = Form
        submit_button_name = _("Open")

        def save(self, obj):
            self.ticket = obj.open_ticket(
                self.request.user,
                topic=self.form.cleaned_data["topic"],
                assignee=self.form.cleaned_data.get("assignee"),
                note=self.form.cleaned_data.get("note"),
            )

        def get_success_url(self):
            return f"{reverse('tickets.ticket_list')}all/open/{self.ticket.uuid}/"

    class Interrupt(ModalFormMixin, OrgObjPermsMixin, SmartUpdateView):
        """
        Interrupt this contact
        """

        slug_url_kwarg = "uuid"
        fields = ()
        success_url = "hide"
        submit_button_name = _("Interrupt")

        def save(self, obj):
            obj.interrupt(self.request.user)
            return obj

    class Delete(BaseDeleteModal):
        """
        Delete this contact
        """

        cancel_url = "@contacts.contact_list"
        redirect_url = "@contacts.contact_list"


class ContactGroupCRUDL(SmartCRUDL):
    model = ContactGroup
    actions = ("create", "update", "usages", "delete")

    class Create(BaseCreateModal):
        form_class = ContactGroupForm
        fields = ("name", "preselected_contacts", "group_query")
        success_url = "uuid@contacts.contact_group"
        submit_button_name = _("Create")

        def save(self, obj):
            org = self.request.org
            user = self.request.user
            name = self.form.cleaned_data.get("name")
            query = self.form.cleaned_data.get("group_query")
            preselected_contacts = self.form.cleaned_data.get("preselected_contacts")

            if query:
                self.object = ContactGroup.create_smart(org, user, name, query)
            else:
                self.object = ContactGroup.create_manual(org, user, name)

                if preselected_contacts:
                    preselected_ids = [int(c_id) for c_id in preselected_contacts.split(",") if c_id.isdigit()]
                    contacts = org.contacts.filter(id__in=preselected_ids, is_active=True)

                    on_transaction_commit(lambda: Contact.bulk_change_group(user, contacts, self.object, add=True))

        def derive_initial(self):
            initial = super().derive_initial()
            initial["group_query"] = self.request.GET.get("search", "")
            return initial

    class Update(BaseUpdateModal):
        form_class = ContactGroupForm
        success_url = "uuid@contacts.contact_group"

        def derive_fields(self):
            return ("name", "query") if self.object.is_smart else ("name",)

        def pre_save(self, obj):
            obj._prev_query = self.get_object().query

            return super().pre_save(obj)

        def post_save(self, obj):
            obj = super().post_save(obj)

            # if query actually changed, update it
            if obj.query and obj.query != obj._prev_query:
                obj.update_query(obj.query)

            return obj

    class Usages(BaseUsagesModal):
        permission = "contacts.contactgroup_read"

    class Delete(BaseDependencyDeleteModal):
        cancel_url = "uuid@contacts.contact_group"
        success_url = "@contacts.contact_list"


class ContactFieldForm(UniqueNameMixin, forms.ModelForm):
    def __init__(self, org, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.org = org

        is_already_location_type = self.instance and self.instance.value_type in (
            ContactField.TYPE_STATE,
            ContactField.TYPE_DISTRICT,
            ContactField.TYPE_WARD,
        )
        allow_location_types = "locations" in settings.FEATURES or is_already_location_type
        self.fields["value_type"].choices = (
            ContactField.TYPE_CHOICES if allow_location_types else ContactField.TYPE_CHOICES_BASIC
        )

    def clean_name(self):
        name = super().clean_name()

        if not ContactField.is_valid_name(name):
            raise forms.ValidationError(_("Can only contain letters, numbers and hypens."))

        if not ContactField.is_valid_key(ContactField.make_key(name)):
            raise forms.ValidationError(_("Can't be a reserved word."))

        return name

    def clean_value_type(self):
        value_type = self.cleaned_data["value_type"]

        if self.instance and self.instance.id:
            if (
                self.instance.campaign_events.filter(is_active=True).exists()
                and value_type != ContactField.TYPE_DATETIME
            ):
                raise forms.ValidationError(_("Can't change type of date field being used by campaign events."))
            if (
                self.instance.dependent_groups.filter(is_active=True).exists()
                and value_type != self.instance.value_type
            ):
                raise forms.ValidationError(_("Can't change type of field being used by a smart group."))

        return value_type

    class Meta:
        model = ContactField
        fields = ("name", "value_type", "show_in_table", "agent_access")
        labels = {
            "name": _("Name"),
            "value_type": _("Data Type"),
            "show_in_table": _("Featured"),
            "agent_access": _("Agent Access"),
        }
        help_texts = {
            "value_type": _("Type of the values that will be stored in this field."),
            "agent_access": _("Type of access that agent users have for this field."),
        }
        widgets = {
            "name": InputWidget(attrs={"widget_only": False}),
            "value_type": SelectWidget(attrs={"widget_only": False}),
            "show_in_table": CheckboxWidget(attrs={"widget_only": True}),
            "agent_access": SelectWidget(attrs={"widget_only": False}),
        }


class FieldLookupMixin:
    @classmethod
    def derive_url_pattern(cls, path, action):
        return r"^%s/%s/(?P<key>[^/]+)/$" % (path, action)

    def has_permission(self, request, *args, **kwargs):
        object = self.get_object()
        if object:
            return super().has_permission(request, *args, **kwargs)
        return False

    def get_object(self):
        if self.request.org:
            return self.request.org.fields.filter(key=self.kwargs["key"], is_active=True).first()
        return None


class ContactFieldCRUDL(SmartCRUDL):
    model = ContactField
    actions = ("list", "create", "update", "update_priority", "delete", "usages")

    class Create(BaseCreateModal):
        queryset = ContactField.user_fields
        form_class = ContactFieldForm
        success_url = "hide"
        submit_button_name = _("Create")

        def form_valid(self, form):
            self.object = ContactField.create(
                self.request.org,
                self.request.user,
                name=form.cleaned_data["name"],
                value_type=form.cleaned_data["value_type"],
                featured=form.cleaned_data["show_in_table"],
                agent_access=form.cleaned_data["agent_access"],
            )
            return self.render_modal_response(form)

    class Update(FieldLookupMixin, BaseUpdateModal):
        queryset = ContactField.objects.filter(is_system=False)
        form_class = ContactFieldForm
        submit_button_name = _("Update")
        success_url = "hide"

        def pre_save(self, obj):
            obj = super().pre_save(obj)

            # clear our priority if no longer featured
            if not obj.show_in_table:
                obj.priority = 0
            return obj

        def form_valid(self, form):
            super().form_valid(form)
            return self.render_modal_response(form)

    class Delete(FieldLookupMixin, BaseDependencyDeleteModal):
        cancel_url = "@contacts.contactfield_list"
        success_url = "hide"

    class UpdatePriority(OrgPermsMixin, SmartView, View):
        def post(self, request, *args, **kwargs):
            try:
                post_data = json.loads(request.body)
                with transaction.atomic():
                    for key, priority in post_data.items():
                        ContactField.user_fields.filter(key=key, org=self.request.org).update(priority=priority)

                return HttpResponse('{"status":"OK"}', status=200, content_type="application/json")

            except Exception as e:
                logger.error(f"Could not update priorities of ContactFields: {str(e)}")

                payload = {"status": "ERROR", "err_detail": str(e)}

                return HttpResponse(json.dumps(payload), status=400, content_type="application/json")

    class List(SpaMixin, ContextMenuMixin, BaseListView):
        menu_path = "/contact/fields"
        title = _("Fields")

        def build_context_menu(self, menu):
            if self.has_org_perm("contacts.contactfield_create") and not self.is_limit_reached():
                menu.add_modax(
                    _("New"),
                    "new-field",
                    f"{reverse('contacts.contactfield_create')}",
                    title=_("New Field"),
                    on_submit="handleFieldUpdated()",
                    as_button=True,
                )

    class Usages(FieldLookupMixin, BaseUsagesModal):
        permission = "contacts.contactfield_read"
        queryset = ContactField.user_fields


class ContactImportCRUDL(SmartCRUDL):
    model = ContactImport
    actions = ("create", "preview", "read")

    class Create(SpaMixin, OrgPermsMixin, SmartCreateView):
        class Form(forms.ModelForm):
            file = forms.FileField(validators=[FileExtensionValidator(allowed_extensions=("xlsx",))])

            def __init__(self, *args, org, **kwargs):
                self.org = org
                self.headers = None
                self.mappings = None
                self.num_records = None

                super().__init__(*args, **kwargs)

            def clean_file(self):
                file = self.cleaned_data["file"]

                # try to parse the file saving the mappings so we don't have to repeat parsing when saving the import
                self.mappings, self.num_records = ContactImport.try_to_parse(self.org, file.file, file.name)

                return file

            class Meta:
                model = ContactImport
                fields = ("file",)

        form_class = Form
        success_url = "id@contacts.contactimport_preview"
        menu_path = "/contact/import"

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["org"] = self.request.org
            return kwargs

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)

            org = self.request.org
            schemes = org.get_schemes(role=Channel.ROLE_SEND)
            schemes.add(URN.TEL_SCHEME)  # always show tel
            context["urn_schemes"] = [conf for conf in URN.SCHEME_CHOICES if conf[0] in schemes]
            context["explicit_clear"] = ContactImport.EXPLICIT_CLEAR
            context["max_records"] = ContactImport.MAX_RECORDS
            context["org_country"] = org.default_country
            return context

        def pre_save(self, obj):
            obj = super().pre_save(obj)
            obj.org = self.request.org
            obj.original_filename = self.form.cleaned_data["file"].name
            obj.mappings = self.form.mappings
            obj.num_records = self.form.num_records
            return obj

    class Preview(SpaMixin, OrgObjPermsMixin, SmartUpdateView):
        menu_path = "/contact/import"

        class Form(forms.ModelForm):
            GROUP_MODE_NEW = "N"
            GROUP_MODE_EXISTING = "E"

            add_to_group = forms.BooleanField(
                label=" ", required=False, initial=True, widget=CheckboxWidget(attrs={"widget_only": True})
            )
            group_mode = forms.ChoiceField(
                required=False,
                choices=(),
                initial=None,
                widget=SelectWidget(attrs={"widget_only": True}),
            )
            new_group_name = forms.CharField(
                label=" ", required=False, max_length=ContactGroup.MAX_NAME_LEN, widget=InputWidget()
            )
            existing_group = TembaChoiceField(
                label=" ",
                required=False,
                queryset=ContactGroup.objects.none(),
                widget=SelectWidget(
                    attrs={"placeholder": _("Select a group"), "widget_only": True, "searchable": True}
                ),
            )

            def __init__(self, *args, org, **kwargs):
                self.org = org
                super().__init__(*args, **kwargs)

                # Check if limits are reached
                field_limit_reached = ContactField.is_limit_reached(org)
                group_limit_reached = ContactGroup.is_limit_reached(org)

                # Modify group mode choices and initial value if group limit reached
                if group_limit_reached:
                    # If group limit reached, only allow existing groups and default to that
                    group_choices = [(self.GROUP_MODE_EXISTING, _("existing group"))]
                    group_initial = self.GROUP_MODE_EXISTING
                else:
                    group_choices = [
                        (self.GROUP_MODE_NEW, _("new group")),
                        (self.GROUP_MODE_EXISTING, _("existing group")),
                    ]
                    group_initial = self.GROUP_MODE_NEW

                # Update the group_mode field with potentially modified choices
                self.fields["group_mode"].choices = group_choices
                self.fields["group_mode"].initial = group_initial

                self.columns = []
                for i, item in enumerate(self.instance.mappings):
                    mapping = item["mapping"]
                    column = item.copy()

                    if mapping["type"] == "new_field":
                        # If field limit is reached, auto-ignore new fields
                        initial_include = not field_limit_reached
                        widget_attrs = {"widget_only": True}
                        if field_limit_reached:
                            widget_attrs["disabled"] = True

                        include_field = forms.BooleanField(
                            label=" ",
                            required=False,
                            initial=initial_include,
                            widget=CheckboxWidget(attrs=widget_attrs),
                        )
                        name_field = forms.CharField(
                            label=" ", initial=mapping["name"], required=False, widget=InputWidget()
                        )
                        value_type_field = forms.ChoiceField(
                            label=" ",
                            choices=ContactField.TYPE_CHOICES,
                            required=True,
                            initial=ContactField.TYPE_TEXT,
                            widget=SelectWidget(attrs={"widget_only": True}),
                        )

                        column_controls = OrderedDict(
                            [
                                (f"column_{i}_include", include_field),
                                (f"column_{i}_name", name_field),
                                (f"column_{i}_value_type", value_type_field),
                            ]
                        )
                        self.fields.update(column_controls)

                        column["controls"] = list(column_controls.keys())

                    self.columns.append(column)

                    self.fields["new_group_name"].initial = self.instance.get_default_group_name()
                    self.fields["existing_group"].queryset = ContactGroup.get_groups(org, manual_only=True).order_by(
                        "name"
                    )

            def get_form_values(self) -> list[dict]:
                """
                Gather form data into a list the same size as the mappings
                """
                data = []
                for i in range(len(self.instance.mappings)):
                    data.append(
                        {
                            "include": self.cleaned_data.get(f"column_{i}_include", True),
                            "name": self.cleaned_data.get(f"column_{i}_name", "").strip(),
                            "value_type": self.cleaned_data.get(f"column_{i}_value_type", ContactField.TYPE_TEXT),
                        }
                    )
                return data

            def clean(self):
                org_fields = self.org.fields.filter(is_system=False, is_active=True)
                existing_field_keys = {f.key for f in org_fields}
                used_field_keys = set()
                new_fields_to_create = []  # Track new fields that will be created
                form_values = self.get_form_values()

                for data, item in zip(form_values, self.instance.mappings):
                    header, mapping = item["header"], item["mapping"]

                    if mapping["type"] == "new_field" and data["include"]:
                        field_name = data["name"]
                        if not field_name:
                            raise ValidationError(_("Field name for '%(header)s' can't be empty.") % {"header": header})
                        else:
                            field_key = ContactField.make_key(field_name)
                            if field_key in existing_field_keys:
                                raise forms.ValidationError(
                                    _("Field name for '%(header)s' matches an existing field."),
                                    params={"header": header},
                                )

                            if not ContactField.is_valid_name(field_name) or not ContactField.is_valid_key(field_key):
                                raise forms.ValidationError(
                                    _("Field name for '%(header)s' is invalid or a reserved word."),
                                    params={"header": header},
                                )

                            if field_key in used_field_keys:
                                raise forms.ValidationError(
                                    _("Field name '%(name)s' is repeated.") % {"name": field_name}
                                )

                            used_field_keys.add(field_key)
                            new_fields_to_create.append(field_name)

                # Check if adding new fields would exceed the field limit
                if new_fields_to_create:
                    current_field_count = org_fields.count()
                    field_limit = self.org.get_limit(Org.LIMIT_FIELDS)
                    if current_field_count + len(new_fields_to_create) > field_limit:
                        raise forms.ValidationError(_("This workspace has reached its limit of fields."))

                add_to_group = self.cleaned_data["add_to_group"]
                if add_to_group:
                    group_mode = self.cleaned_data["group_mode"]
                    if group_mode == self.GROUP_MODE_NEW:
                        new_group_name = self.cleaned_data.get("new_group_name")
                        if not new_group_name:
                            self.add_error("new_group_name", _("Required."))
                        elif not ContactGroup.is_valid_name(new_group_name):
                            self.add_error("new_group_name", _("Invalid group name."))
                        elif ContactGroup.get_group_by_name(self.org, new_group_name):
                            self.add_error("new_group_name", _("Already exists."))
                    else:
                        existing_group = self.cleaned_data.get("existing_group")
                        if not existing_group:
                            self.add_error("existing_group", _("Required."))

                return self.cleaned_data

            class Meta:
                model = ContactImport
                fields = ("id",)

        form_class = Form
        success_url = "uuid@contacts.contactimport_read"

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["org"] = self.derive_org()
            return kwargs

        def pre_process(self, request, *args, **kwargs):
            obj = self.get_object()

            # can't preview an import which has already started
            if obj.started_on:
                return HttpResponseRedirect(reverse("contacts.contactimport_read", args=[obj.uuid]))

            return super().pre_process(request, *args, **kwargs)

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["num_records"] = self.get_object().num_records
            return context

        def pre_save(self, obj):
            form_values = self.form.get_form_values()

            # rewrite mappings using values from form
            for i, data in enumerate(form_values):
                mapping = obj.mappings[i]["mapping"]

                if not data["include"]:
                    mapping = ContactImport.MAPPING_IGNORE
                else:
                    if mapping["type"] == "new_field":
                        mapping["key"] = ContactField.make_key(data["name"])
                        mapping["name"] = data["name"]
                        mapping["value_type"] = data["value_type"]

                obj.mappings[i]["mapping"] = mapping

            if self.form.cleaned_data.get("add_to_group"):
                group_mode = self.form.cleaned_data["group_mode"]
                if group_mode == self.form.GROUP_MODE_NEW:
                    obj.group_name = self.form.cleaned_data["new_group_name"]
                    obj.group = None
                elif group_mode == self.form.GROUP_MODE_EXISTING:
                    obj.group = self.form.cleaned_data["existing_group"]

            return obj

        def post_save(self, obj):
            obj.start_async()
            return obj

    class Read(SpaMixin, BaseReadView):
        menu_path = "/contact/import"
        title = _("Contact Import")

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["info"] = self.import_info
            context["is_finished"] = self.is_import_finished()
            return context

        @cached_property
        def import_info(self):
            return self.object.get_info()

        def is_import_finished(self):
            return self.import_info["status"] in (ContactImport.STATUS_COMPLETE, ContactImport.STATUS_FAILED)
