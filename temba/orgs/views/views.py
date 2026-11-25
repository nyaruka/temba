from collections import OrderedDict
from datetime import timedelta
from json import JSONDecodeError

from allauth.account.models import EmailAddress
from allauth.mfa.models import Authenticator
from packaging.version import Version
from smartmin.views import (
    SmartCreateView,
    SmartCRUDL,
    SmartDeleteView,
    SmartFormView,
    SmartReadView,
    SmartTemplateView,
    SmartUpdateView,
)

from django import forms
from django.conf import settings
from django.contrib import messages
from django.contrib.auth import logout
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import F, Prefetch, Q
from django.db.models.functions import Lower
from django.http import HttpResponseRedirect, JsonResponse
from django.shortcuts import get_object_or_404
from django.urls import reverse, reverse_lazy
from django.utils import timezone
from django.utils.encoding import DjangoUnicodeDecodeError, force_str
from django.utils.functional import cached_property
from django.utils.http import url_has_allowed_host_and_scheme
from django.utils.translation import gettext_lazy as _

from temba.api.models import Resthook
from temba.campaigns.models import Campaign
from temba.flows.models import Flow
from temba.formax import FormaxMixin, FormaxSectionMixin
from temba.tickets.models import Team
from temba.utils import json, languages, on_transaction_commit, str_to_bool
from temba.utils.email import parse_smtp_url
from temba.utils.fields import (
    ArbitraryJsonChoiceField,
    CheckboxWidget,
    ImagePickerWidget,
    InputWidget,
    SelectMultipleWidget,
    SelectWidget,
)
from temba.utils.text import generate_secret
from temba.utils.timezones import TimeZoneFormField
from temba.utils.views.mixins import (
    ComponentFormMixin,
    ContextMenuMixin,
    ModalFormMixin,
    NonAtomicMixin,
    NoNavMixin,
    SpaMixin,
)

from ..models import DefinitionExport, Export, IntegrationType, Invitation, Org, OrgImport, OrgMembership, OrgRole, User
from .base import BaseDeleteModal, BaseListView, BaseMenuView, BaseReadView
from .forms import SignupForm, SMTPForm
from .mixins import InferOrgMixin, InferUserMixin, OrgObjPermsMixin, OrgPermsMixin, RequireFeatureMixin
from .utils import switch_to_org


def check_login(request):
    """
    Simple view that checks whether we actually need to log in. This is needed on the live site
    because we serve the main page as http:// but the logged in pages as https:// and only store
    the cookies on the SSL connection. This view will be called in https:// land where we will
    check whether we are logged in, if so then we will redirect to the org chooser, otherwise we take
    them to the user login page.
    """

    if request.user.is_authenticated:
        return HttpResponseRedirect(reverse("orgs.org_choose"))
    else:
        return HttpResponseRedirect(reverse("account_login"))


class IntegrationFormaxView(FormaxSectionMixin, ComponentFormMixin, OrgPermsMixin, SmartFormView):
    class Form(forms.Form):
        def __init__(self, request, integration_type, **kwargs):
            self.request = request
            self.channel_type = integration_type
            super().__init__(**kwargs)

    permission = "orgs.org_manage_integrations"
    integration_type = None
    success_url = "@orgs.org_workspace"

    def __init__(self, integration_type):
        self.integration_type = integration_type

        super().__init__()

    def get_form_kwargs(self):
        kwargs = super().get_form_kwargs()
        kwargs["request"] = self.request
        kwargs["integration_type"] = self.integration_type
        return kwargs

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["integration_type"] = self.integration_type
        context["integration_connected"] = self.integration_type.is_connected(self.request.org)
        return context

    def form_valid(self, form):
        response = self.render_to_response(self.get_context_data(form=form))
        response["REDIRECT"] = self.get_success_url()
        return response


class UserCRUDL(SmartCRUDL):
    model = User
    actions = ("list", "team", "update", "delete", "edit")

    class List(RequireFeatureMixin, SpaMixin, BaseListView):
        require_feature = Org.FEATURE_USERS
        title = _("Users")
        menu_path = "/settings/users"
        search_fields = ("email__icontains", "first_name__icontains", "last_name__icontains")

        def derive_queryset(self, **kwargs):
            verified_email_qs = EmailAddress.objects.filter(verified=True)
            mfa_enabled_qs = Authenticator.objects.all()

            qs = (
                super(BaseListView, self)
                .derive_queryset(**kwargs)
                .filter(id__in=self.request.org.get_users().values_list("id", flat=True))
                .order_by(Lower("email"))
            )

            if not self.request.user.is_staff:
                qs = qs.exclude(is_system=True)

            return qs.prefetch_related(
                Prefetch("emailaddress_set", queryset=verified_email_qs, to_attr="email_verified"),
                Prefetch("authenticator_set", queryset=mfa_enabled_qs, to_attr="mfa_enabled"),
            )

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)

            # annotate the users with their roles and teams
            for user in context["object_list"]:
                membership = self.request.org.get_membership(user)
                user.role = membership.role
                user.team = membership.team

            context["has_teams"] = Org.FEATURE_TEAMS in self.request.org.features

            admins = self.request.org.get_users(roles=[OrgRole.ADMINISTRATOR])
            if not self.request.user.is_staff:
                admins = admins.exclude(is_system=True)
            context["admin_count"] = admins.count()

            return context

    class Team(RequireFeatureMixin, SpaMixin, ContextMenuMixin, BaseListView):
        permission = "users.user_list"
        require_feature = Org.FEATURE_TEAMS
        menu_path = "/settings/teams"
        search_fields = ("email__icontains", "first_name__icontains", "last_name__icontains")

        @classmethod
        def derive_url_pattern(cls, path, action):
            return r"^%s/%s/(?P<team_id>\d+)/$" % (path, action)

        def derive_title(self):
            return self.team.name

        @cached_property
        def team(self):
            from temba.tickets.models import Team

            return get_object_or_404(Team, id=self.kwargs["team_id"], org=self.request.org)

        def build_context_menu(self, menu):
            if not self.team.is_system:
                if self.has_org_perm("tickets.team_update"):
                    menu.add_modax(
                        _("Edit"),
                        "update-team",
                        reverse("tickets.team_update", args=[self.team.uuid]),
                        title=_("Edit Team"),
                        as_button=True,
                    )
                if self.has_org_perm("tickets.team_delete"):
                    menu.add_modax(
                        _("Delete"),
                        "delete-team",
                        reverse("tickets.team_delete", args=[self.team.uuid]),
                        title=_("Delete Team"),
                    )

        def derive_queryset(self, **kwargs):
            return (
                super(BaseListView, self)
                .derive_queryset(**kwargs)
                .filter(id__in=self.team.get_users().values_list("id", flat=True))
                .order_by(Lower("email"))
            )

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["team"] = self.team
            context["team_topics"] = self.team.topics.order_by(Lower("name"))
            return context

    class Update(RequireFeatureMixin, ModalFormMixin, OrgObjPermsMixin, SmartUpdateView):
        class Form(forms.ModelForm):
            role = forms.ChoiceField(choices=OrgRole.choices(), required=True, label=_("Role"), widget=SelectWidget())
            team = forms.ModelChoiceField(queryset=Team.objects.none(), required=False, widget=SelectWidget())
            can_assign = forms.BooleanField(
                required=False, label=_("Can assign tickets"), widget=CheckboxWidget(attrs={"widget_only": True})
            )
            can_reply_non_own = forms.BooleanField(
                required=False,
                label=_("Can reply to tickets not assigned to them"),
                widget=CheckboxWidget(attrs={"widget_only": True}),
            )

            def __init__(self, org, *args, **kwargs):
                self.org = org

                super().__init__(*args, **kwargs)

                self.fields["team"].queryset = org.teams.filter(is_active=True).order_by(Lower("name"))

            class Meta:
                model = User
                fields = ("role", "team", "can_assign", "can_reply_non_own")

        form_class = Form
        require_feature = Org.FEATURE_USERS

        def get_object_org(self):
            return self.request.org

        def get_queryset(self):
            return self.request.org.get_users().exclude(is_system=True)

        def derive_exclude(self):
            exclude = [] if Org.FEATURE_TEAMS in self.request.org.features else ["team"]

            # only show agent-specific fields if the current user being edited is an agent
            membership = self.request.org.get_membership(self.object)
            if membership.role != OrgRole.AGENT:
                exclude.extend(["can_assign", "can_reply_non_own"])

            return exclude

        def derive_initial(self):
            membership = self.request.org.get_membership(self.object)
            return {
                "role": membership.role.code,
                "team": membership.team,
                "can_assign": membership.can_assign,
                "can_reply_non_own": membership.can_reply_non_own,
            }

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["org"] = self.request.org
            return kwargs

        def save(self, obj):
            role = OrgRole.from_code(self.form.cleaned_data["role"])
            team = self.form.cleaned_data.get("team")
            team = (team or self.request.org.default_team) if role == OrgRole.AGENT else None

            can_assign = self.form.cleaned_data.get("can_assign", True)
            can_reply_non_own = self.form.cleaned_data.get("can_reply_non_own", True)

            # non-agent roles always have full permissions
            if role != OrgRole.AGENT:
                can_assign = True
                can_reply_non_own = True

            # don't update if user is the last administrator and role is being changed to something else
            has_other_admins = self.request.org.get_admins().exclude(id=obj.id).exists()
            if role != OrgRole.ADMINISTRATOR and not has_other_admins:
                return obj

            self.request.org.add_user(obj, role, team=team, can_assign=can_assign, can_reply_non_own=can_reply_non_own)
            return obj

        def get_success_url(self):
            return reverse("orgs.user_list") if self.has_org_perm("users.user_list") else reverse("orgs.org_start")

    class Delete(RequireFeatureMixin, OrgObjPermsMixin, SmartDeleteView):
        permission = "users.user_update"
        require_feature = Org.FEATURE_USERS
        fields = ("id",)
        submit_button_name = _("Remove")
        cancel_url = "@orgs.user_list"
        redirect_url = "@orgs.user_list"

        def get_object_org(self):
            return self.request.org

        def get_queryset(self):
            return self.request.org.get_users().exclude(is_system=True)

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["submit_button_name"] = self.submit_button_name
            return context

        def post(self, request, *args, **kwargs):
            user = self.get_object()

            # only actually remove user if they're not the last administator
            if self.request.org.get_admins().exclude(id=user.id).exists():
                self.request.org.remove_user(user)

            return HttpResponseRedirect(self.get_redirect_url())

        def get_redirect_url(self):
            still_in_org = self.request.org.has_user(self.request.user) or self.request.user.is_staff

            # if current user no longer belongs to this org, redirect to org chooser
            return reverse("orgs.user_list") if still_in_org else reverse("orgs.org_choose")

    class Edit(ComponentFormMixin, InferUserMixin, SmartUpdateView):
        class Form(forms.ModelForm):
            first_name = forms.CharField(
                label=_("First Name"), widget=InputWidget(attrs={"placeholder": _("Required")})
            )
            last_name = forms.CharField(label=_("Last Name"), widget=InputWidget(attrs={"placeholder": _("Required")}))
            avatar = forms.ImageField(
                required=False, label=_("Profile Picture"), widget=ImagePickerWidget(attrs={"shape": "circle"})
            )
            language = forms.ChoiceField(
                choices=settings.LANGUAGES, required=True, label=_("Website Language"), widget=SelectWidget()
            )

            class Meta:
                model = User
                fields = ("first_name", "last_name", "avatar", "language")

        form_class = Form
        success_url = "@orgs.user_edit"
        success_message = _("Your profile has been updated successfully.")

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["base_template"] = "allauth/layouts/base.html"
            return context

        def has_permission(self, request, *args, **kwargs):
            return self.request.user.is_authenticated

        def derive_exclude(self):
            return ["language"] if len(settings.LANGUAGES) == 1 else []

        def derive_initial(self):
            initial = super().derive_initial()
            initial["language"] = self.object.language
            initial["avatar"] = self.object.avatar
            return initial


class InvitationMixin:
    @cached_property
    def invitation(self, **kwargs):
        return Invitation.objects.filter(secret=self.kwargs["secret"], is_active=True).first()

    @classmethod
    def derive_url_pattern(cls, path, action):
        return r"^%s/%s/(?P<secret>\w+)/$" % (path, action)

    def pre_process(self, request, *args, **kwargs):
        if not self.invitation:
            messages.info(request, _("Your invitation link is invalid. Please contact your workspace administrator."))
            return HttpResponseRedirect(reverse("public.public_index"))

        return super().pre_process(request, *args, **kwargs)

    def get_object(self, **kwargs):
        return self.invitation.org

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["invitation"] = self.invitation
        return context


class OrgCRUDL(SmartCRUDL):
    model = Org
    actions = (
        "signup",
        "start",
        "switch",
        "edit",
        "update",
        "join",
        "join_accept",
        "grant",
        "choose",
        "delete",
        "menu",
        "locations",
        "languages",
        "list",
        "create",
        "export",
        "prometheus",
        "resthooks",
        "flow_smtp",
        "workspace",
    )

    class Menu(BaseMenuView):
        @classmethod
        def derive_url_pattern(cls, path, action):
            return r"^%s/%s/((?P<submenu>[A-z]+)/)?$" % (path, action)

        def has_permission(self, request, *args, **kwargs):
            # allow staff access without an org since this view includes staff menu
            if self.request.user.is_staff:
                return True

            return super().has_permission(request, *args, **kwargs)

        def derive_menu(self):
            submenu = self.kwargs.get("submenu")
            org = self.request.org

            # how this menu is made up is a wip
            # TODO: remove pragma
            if submenu == "settings":  # pragma: no cover
                menu = [
                    self.create_menu_item(
                        menu_id="workspace", name=self.request.org.name, icon="settings", href="orgs.org_workspace"
                    )
                ]

                menu.append(self.create_menu_item(name=_("API Tokens"), icon="user_token", href="api.apitoken_list"))
                menu.append(self.create_menu_item(name=_("Resthooks"), icon="resthooks", href="orgs.org_resthooks"))

                if self.has_org_perm("notifications.incident_list"):
                    menu.append(
                        self.create_menu_item(name=_("Incidents"), icon="incidents", href="notifications.incident_list")
                    )

                menu.append(self.create_menu_item(menu_id="ai", name=_("AI"), icon="ai", href="ai.llm_list"))

                if Org.FEATURE_CHILD_ORGS in org.features and self.has_org_perm("orgs.org_list"):
                    menu.append(self.create_divider())
                    menu.append(
                        self.create_menu_item(
                            name=_("Workspaces"),
                            icon="children",
                            href="orgs.org_list",
                            count=org.children.filter(is_active=True).count() + 1,
                        )
                    )
                    menu.append(
                        self.create_menu_item(
                            menu_id="dashboard",
                            name=_("Dashboard"),
                            icon="dashboard",
                            href="dashboard.dashboard_home",
                            perm="orgs.org_dashboard",
                        )
                    )

                if Org.FEATURE_USERS in org.features and self.has_org_perm("users.user_list"):
                    menu.append(self.create_divider())
                    menu.append(
                        self.create_menu_item(
                            name=_("Users"),
                            icon="users",
                            href="orgs.user_list",
                            count=org.users.count(),
                            perm="users.user_list",
                        )
                    )
                    menu.append(
                        self.create_menu_item(
                            name=_("Invitations"),
                            icon="invitations",
                            href="orgs.invitation_list",
                            count=org.invitations.filter(is_active=True).count(),
                        )
                    )
                    if Org.FEATURE_TEAMS in org.features:
                        menu.append(
                            self.create_menu_item(
                                name=_("Teams"),
                                icon="agent",
                                href="tickets.team_list",
                                count=org.teams.filter(is_active=True).count(),
                            )
                        )

                if self.has_org_perm("orgs.org_export"):
                    menu.append(self.create_divider())
                    menu.append(self.create_menu_item(name=_("Export"), icon="export", href="orgs.org_export"))

                if self.has_org_perm("orgs.orgimport_create"):
                    menu.append(self.create_menu_item(name=_("Import"), icon="import", href="orgs.orgimport_create"))

                if self.has_org_perm("channels.channel_read"):
                    from temba.channels.views import get_channel_read_url

                    items = []

                    if self.has_org_perm("channels.channel_claim"):
                        items.append(
                            self.create_menu_item(name=_("New Channel"), href="channels.channel_claim", icon="add")
                        )

                    channels = org.channels.filter(is_active=True).order_by("-is_enabled", Lower("name"))
                    for channel in channels:
                        items.append(
                            self.create_menu_item(
                                menu_id=str(channel.uuid),
                                name=channel.name,
                                href=get_channel_read_url(channel),
                                icon=channel.type.icon if channel.is_enabled else "slash-circle-01",
                            )
                        )

                    if len(items):
                        menu.append(self.create_menu_item(name=_("Channels"), items=items, inline=True))

                if self.has_org_perm("archives.archive_message"):
                    items = [
                        self.create_menu_item(
                            menu_id="message",
                            name=_("Messages"),
                            icon="message",
                            href=reverse("archives.archive_message"),
                        ),
                        self.create_menu_item(
                            menu_id="run",
                            name=_("Flow Runs"),
                            icon="flow",
                            href=reverse("archives.archive_run"),
                        ),
                    ]

                    menu.append(self.create_menu_item(name=_("Archives"), items=items, inline=True))

                return menu

            if submenu == "staff":
                return [
                    self.create_menu_item(
                        menu_id="workspaces",
                        name=_("Workspaces"),
                        icon="workspace",
                        href=reverse("staff.org_list"),
                    ),
                    self.create_menu_item(
                        menu_id="users",
                        name=_("Users"),
                        icon="users",
                        href=reverse("staff.user_list"),
                    ),
                ]

            menu = []
            if org:
                org_options = []
                has_other_orgs = User.get_orgs_for_request(self.request).exclude(id=org.id).exists()
                if has_other_orgs:
                    org_options = [
                        self.create_list(
                            "workspaces",
                            "/api/internal/orgs.json",
                            "temba-workspace-select",
                            json.dumps({"id": org.id, "name": org.name}),
                        )
                    ]
                else:
                    org_options = [
                        self.create_space(),
                        self.create_menu_item(
                            menu_id=org.id,
                            name=org.name,
                            avatar=org.name,
                            event="temba-workspace-settings",
                        ),
                    ]

                if self.has_org_perm("orgs.org_create"):
                    if Org.FEATURE_NEW_ORGS in org.features and Org.FEATURE_CHILD_ORGS not in org.features:
                        org_options.append(self.create_divider())
                        org_options.append(self.create_modax_button(name=_("New Workspace"), href="orgs.org_create"))

                menu += [
                    self.create_menu_item(
                        menu_id="workspace",
                        name=_("Workspace"),
                        avatar=org.name,
                        popup=True,
                        items=[
                            *org_options,
                            self.create_divider(),
                            self.create_menu_item(
                                menu_id="account",
                                name=_("Account"),
                                icon="account",
                                href=reverse("orgs.user_edit"),
                                posterize=True,
                            ),
                            self.create_menu_item(
                                menu_id="logout",
                                name=_("Sign Out"),
                                icon="logout",
                                href="/accounts/logout/",
                                posterize=True,
                            ),
                            self.create_space(),
                        ],
                    ),
                ]

            menu += [
                self.create_space(),
                self.create_menu_item(
                    menu_id="msg",
                    name=_("Messages"),
                    icon="messages",
                    endpoint="msgs.msg_menu",
                    href="msgs.msg_inbox",
                    perm="msgs.msg_list",
                ),
                self.create_menu_item(
                    menu_id="contact",
                    name=_("Contacts"),
                    icon="contacts",
                    endpoint="contacts.contact_menu",
                    href="contacts.contact_list",
                    perm="contacts.contact_list",
                ),
                self.create_menu_item(
                    menu_id="flow",
                    name=_("Flows"),
                    icon="flows",
                    endpoint="flows.flow_menu",
                    href="flows.flow_list",
                    perm="flows.flow_list",
                ),
                self.create_menu_item(
                    menu_id="trigger",
                    name=_("Triggers"),
                    icon="triggers",
                    endpoint="triggers.trigger_menu",
                    href="triggers.trigger_list",
                    perm="triggers.trigger_list",
                ),
                self.create_menu_item(
                    menu_id="campaign",
                    name=_("Campaigns"),
                    icon="campaigns",
                    endpoint="campaigns.campaign_menu",
                    href="campaigns.campaign_list",
                    perm="campaigns.campaign_list",
                ),
                self.create_menu_item(
                    menu_id="ticket",
                    name=_("Tickets"),
                    icon="tickets",
                    endpoint="tickets.ticket_menu",
                    href="tickets.ticket_list",
                ),
            ]

            if org:
                unseen_bubble = None
                if self.request.user.notifications.filter(org=org, is_seen=False).exists():
                    unseen_bubble = "tomato"

                menu.append(
                    self.create_menu_item(
                        menu_id="notifications",
                        name=_("Notifications"),
                        icon="notification",
                        bottom=True,
                        popup=True,
                        bubble=unseen_bubble,
                        items=[
                            self.create_list(
                                "notifications", "/api/internal/notifications.json", "temba-notification-list"
                            )
                        ],
                    )
                )

                if not self.has_org_perm("orgs.org_workspace"):
                    settings_view = "orgs.user_edit"
                else:
                    settings_view = "orgs.org_workspace"

                menu.append(
                    {
                        "id": "settings",
                        "name": _("Settings"),
                        "icon": "home",
                        "href": reverse(settings_view),
                        "endpoint": f"{reverse('orgs.org_menu')}settings/",
                        "bottom": True,
                        "show_header": True,
                    }
                )

            if self.request.user.is_staff:
                menu.append(
                    self.create_menu_item(
                        menu_id="staff",
                        name=_("Staff"),
                        icon="staff",
                        endpoint=f"{reverse('orgs.org_menu')}staff/",
                        bottom=True,
                    )
                )

            return menu

            # Other Plugins:
            # Wit.ai, Luis, Bothub, ZenDesk, DT One, Chatbase, Prometheus, Zapier/Resthooks

    class Export(SpaMixin, InferOrgMixin, OrgPermsMixin, SmartTemplateView):
        title = _("Create Export")
        menu_path = "/settings/export"
        submit_button_name = _("Export")
        success_message = _("We are preparing your export and you will get a notification when it is complete.")
        readonly_servicing = False

        def post(self, request, *args, **kwargs):
            org = self.get_object()
            user = self.request.user

            try:
                json_body = json.loads(request.body.decode("utf-8"))
            except JSONDecodeError:
                return JsonResponse({"error": _("Invalid JSON format.")}, status=400)

            # Validate the structure and content of the JSON
            if not isinstance(json_body, dict):
                return JsonResponse({"error": _("JSON body must be an object.")}, status=400)

            flows = json_body.get("flows", [])
            campaigns = json_body.get("campaigns", [])

            if not isinstance(flows, list):
                return JsonResponse({"error": _("'flows' must be a list.")}, status=400)

            try:
                flows = [int(elt) for elt in flows]
            except ValueError, TypeError:
                return JsonResponse({"error": _("'flows' must be a list of integers.")}, status=400)

            if not isinstance(campaigns, list):
                return JsonResponse({"error": _("'campaigns' must be a list.")}, status=400)

            try:
                campaigns = [int(elt) for elt in campaigns]
            except ValueError, TypeError:
                return JsonResponse({"error": _("'campaigns' must contain only integers.")}, status=400)

            flow_ids = [elt for elt in flows if elt]
            campaign_ids = [elt for elt in campaigns if elt]
            # fetch the selected flows and campaigns
            flows = Flow.objects.filter(id__in=flow_ids, org=org, is_active=True)
            campaigns = Campaign.objects.filter(id__in=campaign_ids, org=org, is_active=True)

            export = DefinitionExport.create(org=org, user=user, flows=flows, campaigns=campaigns)

            on_transaction_commit(lambda: export.start())

            messages.info(self.request, self.success_message)

            return HttpResponseRedirect(reverse("orgs.org_workspace"))

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)

            org = self.get_object()
            include_archived = bool(int(self.request.GET.get("archived", 0)))

            buckets, singles = self.generate_export_buckets(org, include_archived)

            context["archived"] = include_archived
            context["buckets"] = buckets
            context["singles"] = singles

            context["initial_flow_id"] = int(self.request.GET.get("flow", 0))
            context["initial_campaign_id"] = int(self.request.GET.get("campaign", 0))

            return context

        def generate_export_buckets(self, org, include_archived):
            """
            Generates a set of buckets of related exportable flows and campaigns
            """
            dependencies = org.generate_dependency_graph(include_archived=include_archived)

            unbucketed = set(dependencies.keys())
            buckets = []

            # helper method to add a component and its dependencies to a bucket
            def collect_component(c, bucket):
                if c in bucket:  # pragma: no cover
                    return

                unbucketed.remove(c)
                bucket.add(c)

                for d in dependencies[c]:
                    if d in unbucketed:
                        collect_component(d, bucket)

            while unbucketed:
                component = next(iter(unbucketed))

                bucket = set()
                buckets.append(bucket)

                collect_component(component, bucket)

            # collections with only one non-group component should be merged into a single "everything else" collection
            non_single_buckets = []
            singles = set()

            # items within buckets are sorted by type and name
            def sort_key(c):
                return c.__class__.__name__, c.name.lower()

            # buckets with a single item are merged into a special singles bucket
            for b in buckets:
                if len(b) > 1:
                    sorted_bucket = sorted(list(b), key=sort_key)
                    non_single_buckets.append(sorted_bucket)
                else:
                    singles.update(b)

            # put the buckets with the most items first
            non_single_buckets = sorted(non_single_buckets, key=lambda b: len(b), reverse=True)

            # sort singles
            singles = sorted(list(singles), key=sort_key)

            return non_single_buckets, singles

    class FlowSmtp(FormaxSectionMixin, InferOrgMixin, OrgPermsMixin, SmartFormView):
        form_class = SMTPForm

        def post(self, request, *args, **kwargs):
            if "disconnect" in request.POST:
                org = self.request.org
                org.flow_smtp = None
                org.modified_by = request.user
                org.save(update_fields=("flow_smtp", "modified_by", "modified_on"))

                return HttpResponseRedirect(reverse("orgs.org_workspace"))

            return super().post(request, *args, **kwargs)

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["org"] = self.request.org
            kwargs["initial"] = self.request.org.flow_smtp
            return kwargs

        def form_valid(self, form):
            org = self.request.org

            org.flow_smtp = form.cleaned_data["smtp_url"]
            org.modified_by = self.request.user
            org.save(update_fields=("flow_smtp", "modified_by", "modified_on"))

            return super().form_valid(form)

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            org = self.get_object()

            def extract_from(smtp_url: str) -> str:
                return parse_smtp_url(smtp_url)[4]

            from_email_default = settings.FLOW_FROM_EMAIL
            if org.is_child and org.parent.flow_smtp:
                from_email_default = extract_from(org.parent.flow_smtp)

            from_email_custom = extract_from(org.flow_smtp) if org.flow_smtp else None

            context["from_email_default"] = from_email_default
            context["from_email_custom"] = from_email_custom
            return context

    class Update(ModalFormMixin, OrgObjPermsMixin, SmartUpdateView):
        class Form(forms.ModelForm):
            name = forms.CharField(max_length=128, label=_("Name"), widget=InputWidget())
            timezone = TimeZoneFormField(label=_("Timezone"), widget=SelectWidget(attrs={"searchable": True}))

            class Meta:
                model = Org
                fields = ("name", "timezone", "date_format", "language")
                widgets = {"date_format": SelectWidget(), "language": SelectWidget()}

        form_class = Form
        success_url = "@orgs.org_list"

        def get_object_org(self):
            return self.request.org

        def get_queryset(self, *args, **kwargs):
            return self.request.org.children.all()

    class Delete(ModalFormMixin, OrgObjPermsMixin, SmartDeleteView):
        cancel_url = "@orgs.org_list"
        success_url = "@orgs.org_list"
        fields = ("id",)
        submit_button_name = _("Delete")

        def get_object_org(self):
            return self.request.org

        def get_queryset(self, *args, **kwargs):
            return self.request.org.children.all()

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["delete_on"] = timezone.now() + timedelta(days=Org.DELETE_DELAY_DAYS)
            return context

        def post(self, request, *args, **kwargs):
            assert self.get_object().is_child, "can only delete child orgs"

            self.object = self.get_object()
            self.object.release(request.user)
            return self.render_modal_response()

    class List(RequireFeatureMixin, SpaMixin, ContextMenuMixin, BaseListView):
        require_feature = Org.FEATURE_CHILD_ORGS
        title = _("Workspaces")
        menu_path = "/settings/workspaces"
        search_fields = ("name__icontains",)

        def build_context_menu(self, menu):
            if self.has_org_perm("orgs.org_create"):
                menu.add_modax(
                    _("New"), "new_workspace", reverse("orgs.org_create"), title=_("New Workspace"), as_button=True
                )

        def derive_queryset(self, **kwargs):
            qs = super(BaseListView, self).derive_queryset(**kwargs)

            # return this org and its children
            org = self.request.org
            return (
                qs.filter(Q(id=org.id) | Q(id__in=[c.id for c in org.children.all()]))
                .filter(is_active=True)
                .order_by("-parent", "name")
            )

    class Create(NonAtomicMixin, RequireFeatureMixin, ModalFormMixin, InferOrgMixin, OrgPermsMixin, SmartCreateView):
        class Form(forms.ModelForm):
            TYPE_CHILD = "child"
            TYPE_NEW = "new"
            TYPE_CHOICES = ((TYPE_CHILD, _("As child workspace")), (TYPE_NEW, _("As separate workspace")))

            type = forms.ChoiceField(initial=TYPE_CHILD, widget=SelectWidget(attrs={"widget_only": True}))
            name = forms.CharField(label=_("Name"), widget=InputWidget())
            timezone = TimeZoneFormField(widget=SelectWidget(attrs={"searchable": True}))

            def __init__(self, org, *args, **kwargs):
                super().__init__(*args, **kwargs)

                self.fields["type"].choices = self.TYPE_CHOICES
                self.fields["timezone"].initial = org.timezone

            class Meta:
                model = Org
                fields = ("type", "name", "timezone")

        form_class = Form
        require_feature = (Org.FEATURE_NEW_ORGS, Org.FEATURE_CHILD_ORGS)

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["org"] = self.request.org
            return kwargs

        def derive_fields(self):
            # if org supports creating both new and child orgs, need to show type as option
            features = self.request.org.features
            show_type = Org.FEATURE_NEW_ORGS in features and Org.FEATURE_CHILD_ORGS in features
            return ["type", "name", "timezone"] if show_type else ["name", "timezone"]

        def get_success_url(self):
            # if we created a child org, redirect to its management
            if self.object.is_child:
                return reverse("orgs.org_list")

            # if we created a new separate org, switch to it
            switch_to_org(self.request, self.object)
            return reverse("orgs.org_start")

        def form_valid(self, form):
            default_type = form.TYPE_CHILD if Org.FEATURE_CHILD_ORGS in self.request.org.features else form.TYPE_NEW

            self.object = self.request.org.create_new(
                self.request.user,
                form.cleaned_data["name"],
                tz=form.cleaned_data["timezone"],
                as_child=form.cleaned_data.get("type", default_type) == form.TYPE_CHILD,
            )

            if "HTTP_X_PJAX" not in self.request.META:
                return HttpResponseRedirect(self.get_success_url())
            else:  # pragma: no cover
                success_url = self.get_success_url()

                response = self.render_to_response(
                    self.get_context_data(
                        form=form,
                        success_url=success_url,
                        success_script=getattr(self, "success_script", None),
                    )
                )

                response["X-Temba-Success"] = success_url
                return response

    class Switch(NoNavMixin, OrgPermsMixin, SmartFormView):
        class SwitchForm(forms.Form):
            other_org = forms.ModelChoiceField(queryset=Org.objects.none(), widget=forms.HiddenInput())
            next = forms.CharField(widget=forms.HiddenInput(), required=False)

            def __init__(self, request, *args, **kwargs):
                super().__init__(**kwargs)
                self.request = request
                self.fields["other_org"].queryset = User.get_orgs_for_request(self.request)

            class Meta:
                fields = ("other_org", "next")

        form_class = SwitchForm
        fields = ("other_org", "next")
        title = _("Switch Workspaces")

        def pre_process(self, request, *args, **kwargs):
            # make sure the other_org is valid
            other_org_id = self.request.GET.get("other_org", self.request.POST.get("other_org"))
            if other_org_id:
                # make sure we have access to that org
                if not User.get_orgs_for_request(self.request).filter(id=other_org_id).exists():
                    return HttpResponseRedirect(reverse("orgs.org_choose"))

            return super().pre_process(request, *args, **kwargs)

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["request"] = self.request
            return kwargs

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["other_org"] = (
                User.get_orgs_for_request(self.request).filter(id=self.request.GET.get("other_org")).first()
            )
            context["next"] = self.request.GET.get("next", "")
            return context

        def derive_initial(self):
            initial = super().derive_initial()
            initial["other_org"] = self.request.GET.get("other_org", "")
            initial["next"] = self.request.GET.get("next", "")
            return initial

        # valid form means we set our org and redirect to next
        def form_valid(self, form):
            switch_to_org(self.request, form.cleaned_data["other_org"])
            success_url = form.cleaned_data["next"]
            if not success_url or not url_has_allowed_host_and_scheme(
                success_url,
                allowed_hosts={self.request.get_host()},
                require_https=self.request.is_secure(),
            ):
                success_url = reverse("orgs.org_start")
            return HttpResponseRedirect(success_url)

    class Start(SmartTemplateView):
        def has_permission(self, request, *args, **kwargs):
            return self.request.user.is_authenticated

        def pre_process(self, request, *args, **kwargs):
            user = self.request.user
            org = self.request.org

            if not org:
                return HttpResponseRedirect(reverse("orgs.org_choose"))

            role = org.get_user_role(user)
            return HttpResponseRedirect(reverse(role.start_view if role else "msgs.msg_inbox"))

    class Choose(NoNavMixin, SpaMixin, SmartFormView):
        class Form(forms.Form):
            organization = forms.ModelChoiceField(queryset=Org.objects.none(), empty_label=None)

            def __init__(self, orgs, *args, **kwargs):
                super().__init__(*args, **kwargs)

                self.fields["organization"].queryset = orgs

        form_class = Form
        fields = ("organization",)
        title = _("Select your Workspace")

        def pre_process(self, request, *args, **kwargs):
            user = self.request.user
            org = self.request.org

            # if we don't have an org, try to find one for the user
            if user.is_authenticated and request.method == "GET":
                user_orgs = User.get_orgs_for_request(self.request)
                if user_orgs.count() == 0:
                    # staff users aren't required to have an org
                    if user.is_staff:
                        return HttpResponseRedirect(f"{reverse('staff.org_list')}?filter=active")

                else:
                    # grab the most recent org membership
                    membership = (
                        OrgMembership.objects.filter(org__in=user_orgs)
                        .order_by(F("last_seen_on").desc(nulls_last=True), "-id")
                        .first()
                    )

                    if membership:
                        org = membership.org

                if org:
                    switch_to_org(self.request, org)

                    return HttpResponseRedirect(reverse("orgs.org_start"))

            if not org:
                return HttpResponseRedirect(reverse("orgs.org_signup"))

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["orgs"] = User.get_orgs_for_request(self.request)
            return context

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["orgs"] = User.get_orgs_for_request(self.request)
            return kwargs

        def has_permission(self, request, *args, **kwargs):
            return self.request.user.is_authenticated

        def form_valid(self, form):
            org = form.cleaned_data["organization"]
            switch_to_org(self.request, org)

            return HttpResponseRedirect(reverse("orgs.org_start"))

    class Join(InvitationMixin, SmartTemplateView):
        """
        Redirects users to the appropriate place to accept an invitation.
        """

        permission = False

        def pre_process(self, request, *args, **kwargs):
            resp = super().pre_process(request, *args, **kwargs)
            if resp:
                return resp

            secret = self.kwargs["secret"]

            # if user exists and is logged in then they just need to accept
            user = User.get_by_email(self.invitation.email)

            if user and request.user.is_authenticated and request.user.email.lower() == self.invitation.email.lower():
                return HttpResponseRedirect(reverse("orgs.org_join_accept", args=[secret]))

            logout(request)

            if user:
                return HttpResponseRedirect(f"{reverse('account_login')}?invite={secret}")
            else:
                return HttpResponseRedirect(f"{reverse('account_signup')}?invite={secret}")

    class JoinAccept(NoNavMixin, InvitationMixin, SmartUpdateView):
        """
        Simple join button for existing and logged in users to accept a workspace invitation.
        """

        class Form(forms.ModelForm):
            class Meta:
                model = Org
                fields = ()

        title = ""
        form_class = Form
        success_url = "@orgs.org_start"
        submit_button_name = _("Join")

        def has_permission(self, request, *args, **kwargs):
            return request.user.is_authenticated

        def pre_process(self, request, *args, **kwargs):
            resp = super().pre_process(request, *args, **kwargs)
            if resp:
                return resp

            # if user doesn't already exist or we're logged in as a different user, we shouldn't be here
            user = User.get_by_email(self.invitation.email)
            if not user or self.invitation.email.lower() != request.user.email.lower():
                return HttpResponseRedirect(reverse("orgs.org_join", args=[self.kwargs["secret"]]))

            return super().pre_process(request, *args, **kwargs)

        def save(self, obj):
            self.invitation.accept(self.request.user)

            switch_to_org(self.request, obj)

    class Grant(SpaMixin, ComponentFormMixin, NonAtomicMixin, SmartCreateView):
        class Form(forms.ModelForm):
            first_name = forms.CharField(
                help_text=_("The first name of the workspace administrator"),
                max_length=User._meta.get_field("first_name").max_length,
            )
            last_name = forms.CharField(
                help_text=_("Your last name of the workspace administrator"),
                max_length=User._meta.get_field("last_name").max_length,
            )
            email = forms.EmailField(
                help_text=_("Their email address"), max_length=User._meta.get_field("email").max_length
            )
            timezone = TimeZoneFormField(help_text=_("The timezone for the workspace"))
            password = forms.CharField(
                widget=forms.PasswordInput,
                required=False,
                help_text=_("Their password, at least eight letters please. (leave blank for existing login)"),
            )
            name = forms.CharField(label=_("Workspace"), help_text=_("The name of the new workspace"))

            def clean(self):
                data = self.cleaned_data

                email = data.get("email", None)
                password = data.get("password", None)

                # for granting new accounts, either the email maps to an existing user (and their existing password is used)
                # or both email and password must be included
                if email:
                    if User.get_by_email(email):
                        if password:
                            raise ValidationError(_("Login already exists, please do not include password."))
                    else:
                        if not password:
                            raise ValidationError(_("Password required for new login."))

                        validate_password(password)

                return data

            class Meta:
                model = Org
                fields = ("first_name", "last_name", "email", "timezone", "password", "name")

        title = _("Create Workspace Account")
        form_class = Form
        success_message = "Workspace successfully created."
        submit_button_name = _("Create")
        success_url = "@orgs.org_grant"
        menu_path = "/settings"

        def save(self, obj):
            self.object = Org.create(
                self.request.user, self.form.cleaned_data["name"], self.form.cleaned_data["timezone"]
            )

            user = User.get_or_create(
                self.form.cleaned_data["email"],
                self.form.cleaned_data["first_name"],
                self.form.cleaned_data["last_name"],
                self.form.cleaned_data["password"],
                language=settings.DEFAULT_LANGUAGE,
            )
            self.object.add_user(user, OrgRole.ADMINISTRATOR)
            return self.object

    class Signup(ComponentFormMixin, NonAtomicMixin, SmartCreateView):
        title = _("Sign Up")
        form_class = SignupForm
        permission = None

        @staticmethod
        def get_current_user_org(user) -> Org | None:
            membership = (
                OrgMembership.objects.filter(user=user, org__is_active=True)
                .select_related("org")
                .order_by(F("last_seen_on").desc(nulls_last=True), "-id")
                .first()
            )
            return membership.org if membership else None

        def get_success_url(self):
            return "%s?start" % reverse("public.public_welcome")

        def pre_process(self, request, *args, **kwargs):
            # only authenticated users can come here
            if not request.user.is_authenticated:
                return HttpResponseRedirect(reverse("account_signup"))

            # if we already have an org, just go there
            if request.org:
                return HttpResponseRedirect(reverse("orgs.org_start"))

            # if user has memberships but no org in session, switch to their most recent org
            if user_org := self.get_current_user_org(request.user):
                switch_to_org(self.request, user_org)
                return HttpResponseRedirect(reverse("orgs.org_start"))

            # if our brand doesn't allow signups, then redirect to the account page
            if "signups" not in request.branding.get("features", []):  # pragma: needs cover
                return HttpResponseRedirect(reverse("orgs.user_edit"))

            return super().pre_process(request, *args, **kwargs)

        def derive_initial(self):
            initial = super().get_initial()
            return initial

        def save(self, obj):
            # Lock the user row so concurrent signup submissions can't create multiple orgs.
            with transaction.atomic():
                user = User.objects.select_for_update().get(pk=self.request.user.pk)
                self.object = self.get_current_user_org(user)
                if not self.object:
                    self.object = Org.create(user, self.form.cleaned_data["name"], self.form.cleaned_data["timezone"])

            switch_to_org(self.request, self.object)

            return self.object

    class Resthooks(SpaMixin, ComponentFormMixin, InferOrgMixin, OrgPermsMixin, SmartUpdateView):
        class ResthookForm(forms.ModelForm):
            new_slug = forms.SlugField(
                required=False,
                label=_("New Event"),
                help_text="Enter a name for your event. ex: new-registration",
                widget=InputWidget(),
                max_length=Resthook._meta.get_field("slug").max_length,
            )

            def add_remove_fields(self):
                resthooks = []
                field_mapping = []

                for resthook in self.instance.get_resthooks():
                    check_field = forms.BooleanField(required=False, widget=CheckboxWidget())
                    field_name = "resthook_%d" % resthook.id

                    field_mapping.append((field_name, check_field))
                    resthooks.append(dict(resthook=resthook, field=field_name))

                self.fields = OrderedDict(list(self.fields.items()) + field_mapping)
                return resthooks

            def clean_new_slug(self):
                new_slug = self.data.get("new_slug")

                if new_slug:
                    if self.instance.resthooks.filter(is_active=True, slug__iexact=new_slug):
                        raise ValidationError("This event name has already been used.")

                return new_slug

            class Meta:
                model = Org
                fields = ("id", "new_slug")

        form_class = ResthookForm
        title = _("Resthooks")
        success_url = "@orgs.org_resthooks"
        menu_path = "/settings/resthooks"

        def get_form(self):
            form = super().get_form()
            self.current_resthooks = form.add_remove_fields()
            return form

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["current_resthooks"] = self.current_resthooks
            return context

        def pre_save(self, obj):
            new_slug = self.form.data.get("new_slug")
            if new_slug:
                Resthook.get_or_create(obj, new_slug, self.request.user)

            # release any resthooks that the user removed
            for resthook in self.current_resthooks:
                if self.form.data.get(resthook["field"]):
                    resthook["resthook"].release(self.request.user)

            return super().pre_save(obj)

    class Prometheus(RequireFeatureMixin, FormaxSectionMixin, InferOrgMixin, OrgPermsMixin, SmartUpdateView):
        class Form(forms.ModelForm):
            class Meta:
                model = Org
                fields = ("id",)

        form_class = Form
        success_url = "@orgs.org_workspace"
        require_feature = Org.FEATURE_PROMETHEUS

        def save(self, obj):
            org = self.request.org

            # if org has an existing Prometheus token, disable it, otherwise create one
            if org.prometheus_token:
                org.prometheus_token = None
                org.save(update_fields=("prometheus_token",))
            else:
                org.prometheus_token = generate_secret(40)
                org.save(update_fields=("prometheus_token",))

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            org = self.request.org
            context["prometheus_url"] = f"https://{org.branding['domain']}/mr/org/{org.uuid}/metrics"
            return context

    class Workspace(SpaMixin, FormaxMixin, ContextMenuMixin, InferOrgMixin, OrgPermsMixin, SmartReadView):
        title = _("Workspace")
        menu_path = "/settings/workspace"

        def derive_formax_sections(self, formax, context):
            if self.has_org_perm("orgs.org_edit"):
                formax.add_section("org", reverse("orgs.org_edit"), icon="settings")

            if self.has_org_perm("orgs.org_languages"):
                formax.add_section("languages", reverse("orgs.org_languages"), icon="language")

            if self.has_org_perm("orgs.org_locations") and "locations" in settings.FEATURES:
                formax.add_section("locations", reverse("orgs.org_locations"), icon="location")

            if self.has_org_perm("orgs.org_flow_smtp"):
                formax.add_section("email", reverse("orgs.org_flow_smtp"), icon="email")

            if self.has_org_perm("orgs.org_prometheus"):
                formax.add_section("prometheus", reverse("orgs.org_prometheus"), icon="prometheus", nobutton=True)

            if self.has_org_perm("orgs.org_manage_integrations"):
                for integration in IntegrationType.get_all():
                    if integration.is_available_to(self.request.user):
                        integration.management_ui(self.object, formax)

    class Edit(FormaxSectionMixin, InferOrgMixin, OrgPermsMixin, SmartUpdateView):
        class Form(forms.ModelForm):
            name = forms.CharField(max_length=128, label=_("Name"), widget=InputWidget())
            timezone = TimeZoneFormField(label=_("Timezone"), widget=SelectWidget(attrs={"searchable": True}))

            class Meta:
                model = Org
                fields = ("name", "timezone", "date_format", "language")
                widgets = {"date_format": SelectWidget(), "language": SelectWidget()}

        form_class = Form

        def derive_exclude(self):
            return ["language"] if len(settings.LANGUAGES) == 1 else []

    class Locations(FormaxSectionMixin, InferOrgMixin, OrgPermsMixin, SmartUpdateView):
        class CountryForm(forms.ModelForm):
            root_location = forms.ModelChoiceField(
                Org.get_possible_countries(),
                required=False,
                label=_("The country used for location values. (optional)"),
                help_text="State and district names will be searched against this country.",
                widget=SelectWidget(),
            )

            class Meta:
                model = Org
                fields = ("root_location",)

        form_class = CountryForm

    class Languages(FormaxSectionMixin, InferOrgMixin, OrgPermsMixin, SmartUpdateView):
        class LanguageForm(forms.ModelForm):
            primary_lang = ArbitraryJsonChoiceField(
                required=True,
                label=_("Default Flow Language"),
                help_text=_("Used for contacts with no language preference."),
                widget=SelectWidget(
                    attrs={
                        "placeholder": _("Select a language"),
                        "searchable": True,
                        "queryParam": "q",
                        "endpoint": reverse_lazy("orgs.org_languages"),
                    }
                ),
            )
            other_langs = ArbitraryJsonChoiceField(
                required=False,
                label=_("Additional Languages"),
                help_text=_("The languages that your flows can be translated into."),
                widget=SelectMultipleWidget(
                    attrs={
                        "placeholder": _("Select languages"),
                        "searchable": True,
                        "queryParam": "q",
                        "endpoint": reverse_lazy("orgs.org_languages"),
                    }
                ),
            )

            input_collation = forms.ChoiceField(
                required=True,
                choices=Org.COLLATION_CHOICES,
                label=_("Input Matching"),
                help_text=_("How text is matched against trigger keywords and flow split tests."),
                widget=SelectWidget(),
            )

            def __init__(self, org, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.org = org

            class Meta:
                model = Org
                fields = ("primary_lang", "other_langs", "input_collation")

        success_url = "@orgs.org_languages"
        form_class = LanguageForm

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["org"] = self.request.org
            return kwargs

        def derive_initial(self):
            initial = super().derive_initial()
            org = self.get_object()

            def lang_json(code):
                return {"value": code, "name": languages.get_name(code)}

            non_primary_langs = org.flow_languages[1:] if len(org.flow_languages) > 1 else []
            initial["other_langs"] = [lang_json(ln) for ln in non_primary_langs]
            initial["primary_lang"] = [lang_json(org.flow_languages[0])]
            return initial

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            org = self.get_object()

            primary_lang = languages.get_name(org.flow_languages[0])
            other_langs = sorted([languages.get_name(code) for code in org.flow_languages[1:]])

            context["primary_lang"] = primary_lang
            context["other_langs"] = other_langs
            return context

        def get(self, request, *args, **kwargs):
            if self.request.headers.get("Accept") == "application/json" or (
                self.request.META.get("HTTP_X_REQUESTED_WITH") == "XMLHttpRequest"
                and not self.request.META.get("HTTP_X_FORMAX", False)
            ):
                initial = self.request.GET.get("initial", "").split(",")
                matches = []

                if len(initial) > 0:
                    for iso_code in initial:
                        if iso_code:
                            lang = languages.get_name(iso_code)
                            matches.append({"value": iso_code, "name": lang})

                if len(matches) == 0:
                    search = self.request.GET.get("search", self.request.GET.get("q", "")).strip().lower()
                    matches += languages.search_by_name(search)
                return JsonResponse(dict(results=matches))

            return super().get(request, *args, **kwargs)

        def form_valid(self, form):
            user = self.request.user
            codes = [form.cleaned_data["primary_lang"]["value"]]

            for lang in form.cleaned_data["other_langs"]:
                if lang["value"] and lang["value"] not in codes:
                    codes.append(lang["value"])

            self.object.set_flow_languages(user, codes)

            return super().form_valid(form)

        @property
        def permission(self):
            if self.request.META.get("HTTP_X_REQUESTED_WITH") == "XMLHttpRequest" and self.request.method == "GET":
                return "orgs.org_languages"
            else:
                return "orgs.org_locations"


class InvitationCRUDL(SmartCRUDL):
    model = Invitation
    actions = ("list", "create", "delete")

    class List(RequireFeatureMixin, SpaMixin, ContextMenuMixin, BaseListView):
        require_feature = Org.FEATURE_USERS
        title = _("Invitations")
        menu_path = "/settings/invitations"
        default_order = ("-created_on",)

        def build_context_menu(self, menu):
            menu.add_modax(
                _("New"),
                "invitation-create",
                reverse("orgs.invitation_create"),
                title=_("New Invitation"),
                as_button=True,
            )

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["validity_days"] = settings.INVITATION_VALIDITY.days
            context["has_teams"] = Org.FEATURE_TEAMS in self.request.org.features
            return context

    class Create(RequireFeatureMixin, ModalFormMixin, OrgPermsMixin, SmartCreateView):
        readonly_servicing = False

        class Form(forms.ModelForm):
            email = forms.EmailField(widget=InputWidget(attrs={"widget_only": True, "placeholder": _("Email Address")}))
            role = forms.ChoiceField(
                choices=OrgRole.choices(), initial=OrgRole.EDITOR.code, label=_("Role"), widget=SelectWidget()
            )
            team = forms.ModelChoiceField(queryset=Team.objects.none(), required=False, widget=SelectWidget())

            def __init__(self, org, *args, **kwargs):
                self.org = org

                super().__init__(*args, **kwargs)

                self.fields["team"].queryset = org.teams.filter(is_active=True).order_by(Lower("name"))

            def clean_email(self):
                email = self.cleaned_data["email"]

                if self.org.users.filter(email__iexact=email).exists():
                    raise ValidationError(_("User is already a member of this workspace."))

                if self.org.invitations.filter(email__iexact=email, is_active=True).exists():
                    raise ValidationError(_("User has already been invited to this workspace."))

                return email

            class Meta:
                model = Invitation
                fields = ("email", "role", "team")

        form_class = Form
        require_feature = Org.FEATURE_USERS
        title = ""
        submit_button_name = _("Send")
        success_url = "@orgs.invitation_list"

        def derive_exclude(self):
            return [] if Org.FEATURE_TEAMS in self.request.org.features else ["team"]

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["org"] = self.request.org
            return kwargs

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["validity_days"] = settings.INVITATION_VALIDITY.days
            return context

        def save(self, obj):
            role = OrgRole.from_code(self.form.cleaned_data["role"])
            team = (obj.team or self.request.org.default_team) if role == OrgRole.AGENT else None

            self.object = Invitation.create(self.request.org, self.request.user, obj.email, role, team=team)

        def post_save(self, obj):
            obj.send()

            return super().post_save(obj)

    class Delete(RequireFeatureMixin, BaseDeleteModal):
        slug_url_kwarg = None  # TODO switch to uuid
        require_feature = Org.FEATURE_USERS
        cancel_url = "@orgs.invitation_list"
        redirect_url = "@orgs.invitation_list"


class OrgImportCRUDL(SmartCRUDL):
    model = OrgImport
    actions = ("create", "read")

    class Create(SpaMixin, OrgPermsMixin, SmartCreateView):
        menu_path = "/settings/import"

        class Form(forms.ModelForm):
            file = forms.FileField(help_text=_("The import file"))

            def __init__(self, org, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.org = org

            def clean_file(self):
                # check that it isn't too old
                data = self.cleaned_data["file"].read()
                try:
                    json_data = json.loads(force_str(data))
                except DjangoUnicodeDecodeError, ValueError:
                    raise ValidationError(_("This file is not a valid flow definition file."))

                if Version(str(json_data.get("version", 0))) < Version(Org.EARLIEST_IMPORT_VERSION):
                    raise ValidationError(_("This file is no longer valid. Please export a new version and try again."))

                for flow in json_data.get("flows", []):
                    spec = flow.get("spec_version")
                    if spec and Version(spec) > Version(Flow.CURRENT_SPEC_VERSION):
                        raise ValidationError(_("This file contains flows with a version that is too new."))

                return self.cleaned_data["file"]

            class Meta:
                model = OrgImport
                fields = ("file",)

        success_message = _("Import started")
        success_url = "uuid@orgs.orgimport_read"
        form_class = Form

        def derive_title(self):
            return _("Import Flows")

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["org"] = self.request.org
            return kwargs

        def pre_save(self, obj):
            obj = super().pre_save(obj)
            obj.org = self.request.org
            return obj

        def post_save(self, obj):
            obj.start()
            return obj

    class Read(SpaMixin, BaseReadView):
        menu_path = "/settings/import"

        def derive_title(self):
            return _("Import Flows and Campaigns")


class ExportCRUDL(SmartCRUDL):
    model = Export
    actions = ("download",)

    class Download(SpaMixin, ContextMenuMixin, OrgObjPermsMixin, SmartReadView):
        slug_url_kwarg = "uuid"
        menu_path = "/settings/workspace"
        title = _("Export")

        def get(self, request, *args, **kwargs):
            if str_to_bool(request.GET.get("raw", 0)):
                export = self.get_object()

                return HttpResponseRedirect(export.get_raw_url())

            return super().get(request, *args, **kwargs)

        def build_context_menu(self, menu):
            menu.add_js("export_download", _("Download"), as_button=True)

        def get_template_names(self):
            return [self.object.type.download_template]

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["extension"] = self.object.path.rsplit(".", 1)[1]
            context.update(**self.object.type.get_download_context(self.object))
            return context
