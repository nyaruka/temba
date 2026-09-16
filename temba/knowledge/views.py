import magic
from smartmin.views import SmartCRUDL, SmartReadView, SmartTemplateView

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db.models.functions import Lower
from django.http import Http404, HttpResponseRedirect, JsonResponse
from django.urls import reverse
from django.utils.functional import cached_property
from django.utils.translation import gettext_lazy as _

from temba.orgs.models import Org
from temba.orgs.views.base import (
    BaseCreateModal,
    BaseDeleteModal,
    BaseMenuView,
    BaseReadView,
    BaseUpdateModal,
)
from temba.orgs.views.mixins import OrgObjPermsMixin, OrgPermsMixin, RequireFeatureMixin
from temba.utils import json
from temba.utils.views.mixins import ContextMenuMixin, PostOnlyMixin, SpaMixin

from .forms import (
    ArticleCreateForm,
    ArticleForm,
    HelpSiteDomainForm,
    HelpSiteForm,
    KnowledgeSourceForm,
    KnowledgeSourceUpdateForm,
    SectionForm,
)
from .models import Article, ArticleImage, HelpdeskImport, HelpSite, KnowledgeItem, KnowledgeSource


class KnowledgeSourceCRUDL(SmartCRUDL):
    model = KnowledgeSource
    actions = ("menu", "read", "create", "update", "delete", "upload", "shortcuts")

    class Menu(RequireFeatureMixin, BaseMenuView):
        require_feature = Org.FEATURE_AGENTS

        def derive_menu(self):
            org = self.request.org

            menu = [
                self.create_menu_item(
                    menu_id="shortcuts",
                    name=_("Shortcuts"),
                    icon="shortcut",
                    count=org.shortcuts.filter(is_active=True).count(),
                    href="knowledge.knowledgesource_shortcuts",
                    perm="knowledge.knowledgesource_read",
                ),
                self.create_menu_item(
                    menu_id="helpdesk",
                    name=_("Helpdesk"),
                    icon="help",
                    href="knowledge.article_list",
                    perm="knowledge.article_list",
                ),
            ]

            sources = org.sources.filter(is_system=False, is_active=True).order_by(Lower("name"))
            if sources:
                menu.append(self.create_divider())
                for source in sources:
                    menu.append(
                        self.create_menu_item(
                            menu_id=str(source.uuid),
                            name=source.name,
                            icon="website" if source.source_type == KnowledgeSource.TYPE_WEBSITE else "documents",
                            href=reverse("knowledge.knowledgesource_read", args=[source.uuid]),
                        )
                    )

            if not KnowledgeSource.is_limit_reached(org):
                menu.append(self.create_space())
                menu.append(
                    self.create_modax_button(
                        _("New Source"), "knowledge.knowledgesource_create", icon="add", on_submit="refreshMenu()"
                    )
                )

            return menu

    class Read(RequireFeatureMixin, SpaMixin, ContextMenuMixin, BaseReadView):
        require_feature = Org.FEATURE_AGENTS

        def derive_menu_path(self):
            return f"/knowledge/{self.object.uuid}"

        def derive_queryset(self, **kwargs):
            # the system shortcuts and helpdesk sources have their own fixed URL pages
            return super().derive_queryset(**kwargs).filter(is_system=False)

        def derive_title(self):
            return self.object.name

        def build_context_menu(self, menu):
            obj = self.get_object()  # self.object isn't set when the content menu is fetched

            if obj.source_type == KnowledgeSource.TYPE_DOCUMENTS and self.has_org_perm(
                "knowledge.knowledgesource_upload"
            ):
                menu.add_js("uploadKnowledgeItem", _("Upload"), as_button=True)

            if self.has_org_perm("knowledge.knowledgesource_update"):
                menu.add_modax(
                    _("Edit"),
                    "update-knowledge",
                    reverse("knowledge.knowledgesource_update", args=[obj.uuid]),
                    title=_("Update Source"),
                )
            if self.has_org_perm("knowledge.knowledgesource_delete"):
                menu.add_modax(
                    _("Delete"),
                    "delete-knowledge",
                    reverse("knowledge.knowledgesource_delete", args=[obj.uuid]),
                    title=_("Delete Source"),
                )

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            obj = self.object

            context["is_website"] = obj.source_type == KnowledgeSource.TYPE_WEBSITE
            context["is_documents"] = obj.source_type == KnowledgeSource.TYPE_DOCUMENTS

            if context["is_website"]:
                # pages are mailroom's to write, so there's no upload affordance here - just the list
                context["items"] = obj.items.order_by("name")
            else:
                context["items"] = obj.items.order_by("-created_on")
                context["upload_url"] = reverse("knowledge.knowledgesource_upload", args=[obj.uuid])
                context["items_limit_reached"] = obj.items.count() >= KnowledgeItem.MAX_DOCUMENTS

            return context

    class Shortcuts(RequireFeatureMixin, SpaMixin, ContextMenuMixin, OrgPermsMixin, SmartTemplateView):
        """
        The org's system shortcuts source at a fixed URL so it can be a menu item.
        """

        require_feature = Org.FEATURE_AGENTS
        permission = "knowledge.knowledgesource_read"
        title = _("Shortcuts")
        menu_path = "/knowledge/shortcuts"

        def build_context_menu(self, menu):
            if self.has_org_perm("tickets.shortcut_create"):
                menu.add_modax(
                    _("New"),
                    "new-shortcut",
                    reverse("tickets.shortcut_create"),
                    title=_("New Shortcut"),
                    as_button=True,
                )

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)

            obj = self.request.org.sources.filter(
                source_type=KnowledgeSource.TYPE_SHORTCUTS, is_system=True, is_active=True
            ).first()
            if not obj:
                raise Http404()

            context["object"] = obj
            context["shortcuts_endpoint"] = f"{reverse('api.internal.shortcuts')}.json"
            return context

    class Create(RequireFeatureMixin, BaseCreateModal):
        require_feature = Org.FEATURE_AGENTS
        form_class = KnowledgeSourceForm
        title = _("New Source")

        def save(self, obj):
            # must set self.object as smartmin ignores the return value
            org, user, data = self.request.org, self.request.user, self.form.cleaned_data

            if data["source_type"] == KnowledgeSource.TYPE_WEBSITE:
                self.object = KnowledgeSource.create_website(
                    org,
                    user,
                    data["name"],
                    data["url"],
                    max_pages=data.get("max_pages"),
                    refresh=data.get("refresh"),
                )
            else:
                self.object = KnowledgeSource.create_documents(org, user, data["name"])

        def get_success_url(self):
            return reverse("knowledge.knowledgesource_read", args=[self.object.uuid])

    class Update(RequireFeatureMixin, BaseUpdateModal):
        require_feature = Org.FEATURE_AGENTS
        form_class = KnowledgeSourceUpdateForm

        def pre_save(self, obj):
            obj = super().pre_save(obj)

            if obj.source_type == KnowledgeSource.TYPE_WEBSITE:
                data = self.form.cleaned_data
                new_config = {
                    KnowledgeSource.CONFIG_URL: data["url"],
                    KnowledgeSource.CONFIG_MAX_DEPTH: obj.config.get(
                        KnowledgeSource.CONFIG_MAX_DEPTH, KnowledgeSource.DEFAULT_MAX_DEPTH
                    ),
                    KnowledgeSource.CONFIG_MAX_PAGES: data.get("max_pages") or KnowledgeSource.DEFAULT_MAX_PAGES,
                    KnowledgeSource.CONFIG_REFRESH: data.get("refresh") or KnowledgeSource.REFRESH_WEEKLY,
                }
                # anything that changes what gets crawled means it needs reindexing
                if new_config != obj.config:
                    obj.status = KnowledgeSource.STATUS_PENDING
                    obj.error = None
                obj.config = new_config

            return obj

        def get_success_url(self):
            return reverse("knowledge.knowledgesource_read", args=[self.object.uuid])

    class Delete(RequireFeatureMixin, BaseDeleteModal):
        require_feature = Org.FEATURE_AGENTS
        cancel_url = "@knowledge.knowledgesource_shortcuts"
        redirect_url = "@knowledge.knowledgesource_shortcuts"
        success_message = _("Your knowledge source has been deleted.")

    class Upload(RequireFeatureMixin, PostOnlyMixin, OrgObjPermsMixin, SmartReadView):
        """
        Multipart in, JSON out - mirrors msgs.media_upload. Always 200; errors are {"error": "..."}.
        """

        require_feature = Org.FEATURE_AGENTS
        permission = "knowledge.knowledgesource_upload"
        slug_url_kwarg = "uuid"

        def post(self, request, *args, **kwargs):
            obj = self.get_object()

            # only document sets accept uploads - website pages are mailroom's to create
            if obj.source_type != KnowledgeSource.TYPE_DOCUMENTS:
                return JsonResponse({"error": _("Files can only be added to document sets.")})
            if obj.items.count() >= KnowledgeItem.MAX_DOCUMENTS:
                return JsonResponse({"error": _("Limit of %d documents reached.") % KnowledgeItem.MAX_DOCUMENTS})

            file = request.FILES["file"]
            detected_type = magic.from_buffer(next(file.chunks(chunk_size=2048)), mime=True)

            if not KnowledgeItem.is_allowed_type(detected_type):
                return JsonResponse({"error": _("Unsupported file type")})
            if file.size > KnowledgeItem.MAX_UPLOAD_SIZE:
                limit_MB = KnowledgeItem.MAX_UPLOAD_SIZE / (1024 * 1024)
                return JsonResponse({"error": _("Limit for file uploads is %s MB") % limit_MB})

            file.content_type = detected_type  # trust the sniffed type, not the browser's
            item = KnowledgeItem.from_upload(obj, request.user, file)

            return JsonResponse({"uuid": str(item.uuid), "name": item.name, "size": item.size, "status": "pending"})


class KnowledgeItemCRUDL(SmartCRUDL):
    model = KnowledgeItem
    actions = ("delete",)

    class Delete(RequireFeatureMixin, BaseDeleteModal):
        require_feature = Org.FEATURE_AGENTS
        model_org_lookup = "source__org"
        cancel_url = "@knowledge.knowledgesource_shortcuts"
        submit_button_name = _("Delete")

        def post(self, request, *args, **kwargs):
            self.object = self.get_object()
            source = self.object.source
            self.object.delete()  # hard delete - purges chunks then the storage object

            return HttpResponseRedirect(reverse("knowledge.knowledgesource_read", args=[source.uuid]))


class HelpdeskMixin(RequireFeatureMixin):
    """
    Common to every article view: the agents feature gate, and the org's system helpdesk source, which is the only
    place articles can live - so it's resolved here rather than taken from the URL.
    """

    require_feature = Org.FEATURE_AGENTS

    @cached_property
    def helpdesk(self):
        obj = self.request.org.sources.filter(
            source_type=KnowledgeSource.TYPE_HELPDESK, is_system=True, is_active=True
        ).first()
        if not obj:
            raise Http404()
        return obj


class ArticleCRUDL(SmartCRUDL):
    model = Article
    actions = ("list", "create", "update", "delete", "publish", "sort", "upload", "colors")

    class BaseObject(HelpdeskMixin):
        """
        Scopes a view of a single article to this org's helpdesk.
        """

        slug_url_kwarg = "uuid"
        model_org_lookup = "source__org"

        def derive_queryset(self, **kwargs):
            return super().derive_queryset(**kwargs).filter(source=self.helpdesk)

    class List(HelpdeskMixin, SpaMixin, ContextMenuMixin, OrgPermsMixin, SmartTemplateView):
        """
        The helpdesk itself - the article tree, which the list component fetches and reorders for itself. Articles are
        opened, written and published in a dialog here, so this is the only page the authoring surface has.
        """

        title = _("Helpdesk")
        menu_path = "/knowledge/helpdesk"

        def build_context_menu(self, menu):
            # the menu makes sections; articles are added from the card of the section they go in
            if self.has_org_perm("knowledge.article_create"):
                menu.add_modax(
                    _("New Section"),
                    "new-section",
                    reverse("knowledge.article_create"),
                    title=_("New Section"),
                    as_button=True,
                )

            # the public site is the helpdesk's, so it's set up from here - its domain from the card at the top of
            # the page, the rest from the menu
            if self.has_org_perm("knowledge.helpsite_update"):
                menu.add_modax(
                    _("Site Settings"),
                    "site-settings",
                    reverse("knowledge.helpsite_update"),
                    title=_("Site Settings"),
                )

            # a help site elsewhere can be brought over wholesale, from whichever sites the deployment knows how to
            # import, with progress shown on the page as it comes
            if self.has_org_perm("knowledge.helpdeskimport_create"):
                for imp_type in HelpdeskImport.get_types():
                    if imp_type.is_available_to(self.request.org, self.request.user):
                        title = _("Import from %(name)s") % {"name": imp_type.name}
                        menu.add_modax(
                            title,
                            f"import-{imp_type.slug}",
                            reverse("knowledge.helpdeskimport_create", args=[imp_type.slug]),
                            title=title,
                            on_submit="refreshHelpdesk()",
                        )

        def derive_article_to_edit(self):
            """
            The article the editor should open on arrival, named by the create modal so that titling a new one drops
            you straight into writing it.
            """
            uuid = self.request.GET.get("edit", "")
            if not uuid:
                return None

            try:
                return self.helpdesk.articles.filter(uuid=uuid, is_active=True).first()
            except ValidationError:  # not a uuid at all
                return None

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["object"] = self.helpdesk
            context["articles_endpoint"] = f"{reverse('api.internal.articles')}.json"

            # without the permission the component is given nowhere to post to, so it offers no drag at all - and
            # likewise no publish switch, leaving the status as something a row states rather than something it does
            if self.has_org_perm("knowledge.article_sort"):
                context["sort_url"] = reverse("knowledge.article_sort")
            if self.has_org_perm("knowledge.article_publish"):
                context["publish_url"] = reverse("knowledge.article_publish")
            if self.has_org_perm("knowledge.article_create"):
                context["create_url"] = reverse("knowledge.article_create")

            context["preview_url"] = reverse("knowledge.site_home")

            # the site card heads the page - the domain, so it's plain whether the site is out there and where
            # setting one up or verifying it is picked up, and beside it the site's preview
            site = HelpSite.objects.filter(source=self.helpdesk).first()
            if self.has_org_perm("knowledge.helpsite_domain"):
                context["domain_url"] = reverse("knowledge.helpsite_domain")
            if site and site.domain:
                context["site"] = site

            # an import underway is shown as a bar the page keeps current; one that failed, as why, with the offer
            # to try again if its kind of import is still on
            latest_import = HelpdeskImport.get_latest(self.helpdesk)
            if latest_import and (
                not latest_import.is_finished or latest_import.status == HelpdeskImport.STATUS_FAILED
            ):
                imp_type = latest_import.type
                context["helpdesk_import"] = latest_import
                context["import_type_name"] = imp_type.name if imp_type else latest_import.import_type
                context["import_status_url"] = reverse("knowledge.helpdeskimport_status")
                if (
                    imp_type
                    and self.has_org_perm("knowledge.helpdeskimport_create")
                    and imp_type.is_available_to(self.request.org, self.request.user)
                ):
                    context["import_url"] = reverse("knowledge.helpdeskimport_create", args=[imp_type.slug])
                    context["import_title"] = _("Import from %(name)s") % {"name": imp_type.name}

            article = self.derive_article_to_edit()
            if article:
                context["edit_article"] = article

            return context

    class Create(HelpdeskMixin, BaseCreateModal):
        """
        Makes a section, or - named a section by ?section= - an article filed under it. A section is described here
        and done; an article is only titled, and its author is dropped into the editor to write it.
        """

        @cached_property
        def section(self):
            uuid = self.request.GET.get("section")
            if not uuid:
                return None

            try:
                section = self.helpdesk.articles.filter(uuid=uuid, parent=None, is_active=True).first()
            except ValidationError:  # not a uuid at all
                section = None
            if not section:
                raise Http404("no such section")
            return section

        def get_form_class(self):
            return ArticleCreateForm if self.section else SectionForm

        def derive_title(self):
            return _("New Article") if self.section else _("New Section")

        def get_blocker(self) -> str:
            if self.helpdesk.articles.filter(is_active=True).count() >= Article.MAX_ARTICLES:
                return "limit_reached"
            return ""

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["blocker"] = self.get_blocker()
            context["max_articles"] = Article.MAX_ARTICLES
            return context

        def form_valid(self, form):
            if self.get_blocker():
                return self.form_invalid(form)
            return super().form_valid(form)

        def pre_save(self, obj):
            return obj  # articles belong to a helpdesk rather than directly to the org

        def save(self, obj):
            # must set self.object as smartmin ignores the return value
            self.object = Article.create(
                self.helpdesk,
                self.request.user,
                obj.title,
                description=self.form.cleaned_data.get("description", ""),
                parent=self.section,
            )

        def get_success_url(self):
            # back to the helpdesk - which, for an article, opens the editor on what we just made. A section is
            # complete as described, so there's nothing to open.
            if self.section:
                return f"{reverse('knowledge.article_list')}?edit={self.object.uuid}"
            return reverse("knowledge.article_list")

    class Update(BaseObject, BaseUpdateModal):
        """
        The editor, opened as a dialog from the helpdesk. It renders the article rather than its markdown, so it's also
        how an article is read - there's no separate read page. Publishing is done from the article's row; in here the
        status is a pill riding the title, stating rather than doing.
        """

        success_url = "hide"  # the helpdesk refreshes its tree rather than navigating anywhere
        success_message = ""

        def get_form_class(self):
            # a section is described rather than written, so it gets the plain form instead of the editor
            return SectionForm if self.get_object().is_section else ArticleForm

        def get_form(self):
            form = super().get_form()
            if "body" not in form.fields:
                return form

            # the dialog carries no title bar of its own: the title heads the article inside the editor, as it does on
            # the site - the title field is slotted into the editor rather than rendered above it - so the article
            # needs no label either
            widget = form.fields["body"].widget
            widget.title = form["title"]
            attrs = widget.attrs
            attrs.update(
                {
                    "hide_label": True,
                    # the editor takes the height the dialog gives it and scrolls the article inside itself, so a long
                    # one is written in the same window as a short one
                    "fill": True,
                    # the editor uploads screenshots against this article
                    "endpoint": reverse("knowledge.article_upload", args=[self.get_object().uuid]),
                    "accept": ",".join(ArticleImage.ALLOWED_CONTENT_TYPES),
                    # and resolves column colors against the org's shared palette
                    "colors-endpoint": reverse("knowledge.article_colors"),
                    # and offers the helpdesk's other articles to link to
                    "articles-endpoint": f"{reverse('api.internal.articles')}.json",
                    # and shows uploaded images, which the article references by their key, from where they're served
                    "storage-url": settings.STORAGE_URL,
                }
            )

            # the editor shows the article as the site will - in the site's own colors, once it has chosen them
            site = HelpSite.objects.filter(source=self.get_object().source).first()
            if site:
                attrs["primary-color"] = site.primary_color
            return form

        def pre_save(self, obj):
            obj = super().pre_save(obj)

            # the title is the article's identity on the eventual public site, so the slug follows it
            obj.slug = Article.get_unique_slug(obj.source, obj.title, ignore=obj)
            return obj

    class Publish(HelpdeskMixin, PostOnlyMixin, OrgPermsMixin, SmartTemplateView):
        """
        Puts one article in or out of the agents' reach, posted as {uuid, status} by the switch on its row in the
        helpdesk. It's a list action rather than part of the editor: an article is published as a whole, and doing it
        from the row means never having to open one to say so.
        """

        # the status names the tree endpoint serves, which are what the switch has to send back
        STATUSES = {"published": Article.STATUS_PUBLISHED, "draft": Article.STATUS_DRAFT}

        def post(self, request, *args, **kwargs):
            try:
                payload = json.loads(request.body)
                uuid = str(payload["uuid"])
                status = self.STATUSES[payload["status"]]
            except ValueError, TypeError, KeyError:
                return JsonResponse({"error": _("Invalid request.")}, status=400)

            try:
                article = self.helpdesk.articles.filter(uuid=uuid, is_active=True).first()
            except ValidationError:  # not a uuid at all
                article = None

            if not article:
                return JsonResponse({"error": _("No such article.")}, status=404)

            if status == Article.STATUS_PUBLISHED:
                article.publish(request.user)
            else:
                article.unpublish(request.user)

            return JsonResponse({"status": "ok"})

    class Colors(HelpdeskMixin, OrgPermsMixin, SmartTemplateView):
        """
        The org's article palette - the bubble colors chosen in the help site's settings, which every author's editor
        offers for column backgrounds. Articles embed an index into it, so recoloring a bubble restyles its every use.
        """

        def get(self, request, *args, **kwargs):
            return JsonResponse({"colors": self.helpdesk.colors})

    class Delete(BaseObject, BaseDeleteModal):
        """
        A section can't go while it holds articles - they'd be left as sections themselves - so the dialog says to
        move or delete them first, and a post that tries anyway is refused.
        """

        cancel_url = "@knowledge.article_list"
        redirect_url = "@knowledge.article_list"
        submit_button_name = _("Delete")

        def get_queryset(self, **kwargs):
            return super().get_queryset(**kwargs).filter(source=self.helpdesk)

        def get_blocker(self) -> str:
            obj = self.get_object()
            if obj.is_section and obj.children.filter(is_active=True).exists():
                return "has_articles"
            return ""

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["blocker"] = self.get_blocker()
            return context

        def post(self, request, *args, **kwargs):
            if self.get_blocker():
                return self.get(request, *args, **kwargs)
            return super().post(request, *args, **kwargs)

    class Sort(HelpdeskMixin, PostOnlyMixin, OrgPermsMixin, SmartTemplateView):
        """
        Applies a new tree ordering, posted as (uuid, parent, sort_order) triples. The client's tree is never trusted -
        the model re-derives the resulting forest and rejects it if it isn't one.
        """

        def post(self, request, *args, **kwargs):
            try:
                payload = json.loads(request.body)
                if len(payload) > Article.MAX_ARTICLES:
                    raise ValueError("too many entries")

                # sort orders are clamped rather than trusted - JSON numbers are unbounded, so an enormous one is
                # either an OverflowError here or an integer out of range at the database
                order = [
                    (
                        str(i["uuid"]),
                        i["parent"] and str(i["parent"]),
                        max(0, min(int(i["sort_order"]), Article.MAX_ARTICLES)),
                    )
                    for i in payload
                ]
            except ValueError, TypeError, KeyError, OverflowError:
                return JsonResponse({"error": _("Invalid ordering.")}, status=400)

            try:
                Article.apply_sort(self.helpdesk, order)
            except ValueError as e:
                return JsonResponse({"error": str(e)}, status=400)

            return JsonResponse({"status": "ok"})

    class Upload(BaseObject, PostOnlyMixin, OrgObjPermsMixin, SmartReadView):
        """
        A screenshot for an article body. Multipart in, JSON out - always 200, errors are {"error": "..."}. The image
        goes to public storage because the eventual standalone help site will serve these directly.
        """

        def post(self, request, *args, **kwargs):
            obj = self.get_object()

            if obj.images.count() >= ArticleImage.MAX_IMAGES:
                return JsonResponse({"error": _("Limit of %d images reached.") % ArticleImage.MAX_IMAGES})

            file = request.FILES["file"]
            detected_type = magic.from_buffer(next(file.chunks(chunk_size=2048)), mime=True)

            if not ArticleImage.is_allowed_type(detected_type):
                return JsonResponse({"error": _("Unsupported file type")})
            if file.size > ArticleImage.MAX_UPLOAD_SIZE:
                limit_MB = ArticleImage.MAX_UPLOAD_SIZE / (1024 * 1024)
                return JsonResponse({"error": _("Limit for file uploads is %s MB") % limit_MB})

            file.content_type = detected_type  # trust the sniffed type, not the browser's
            image = ArticleImage.from_upload(obj, request.user, file)

            # the editor writes the path - the key in storage - into the article and shows the url, so the article
            # never holds the address storage happens to be served from
            return JsonResponse({"uuid": str(image.uuid), "name": image.name, "path": image.path, "url": image.url})


class HelpdeskImportCRUDL(SmartCRUDL):
    model = HelpdeskImport
    actions = ("create", "status")

    class Create(HelpdeskMixin, BaseCreateModal):
        """
        Starts bringing a help site over, of a kind the deployment knows how to import, given what that kind needs
        to get in. The import runs in the background from here; the helpdesk page shows how it's going.
        """

        submit_button_name = _("Import")
        success_url = "hide"
        success_message = ""

        @classmethod
        def derive_url_pattern(cls, path, action):
            return r"^%s/%s/(?P<type>[\w-]+)/$" % (path, action)

        @cached_property
        def import_type(self):
            imp_type = HelpdeskImport.get_type(self.kwargs["type"])
            if not imp_type or not imp_type.is_available_to(self.request.org, self.request.user):
                raise Http404()
            return imp_type

        def derive_title(self):
            return _("Import from %(name)s") % {"name": self.import_type.name}

        def get_form_class(self):
            return self.import_type.form_class

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["import_type"] = self.import_type
            return kwargs

        def get_template_names(self):
            return [self.import_type.template_name, "knowledge/helpdeskimport_create.html"]

        def get_blocker(self) -> str:
            return "existing-import" if HelpdeskImport.get_unfinished(self.helpdesk) else ""

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["import_type"] = self.import_type
            context["blocker"] = self.get_blocker()
            return context

        def form_valid(self, form):
            if self.get_blocker():
                return self.form_invalid(form)

            return super().form_valid(form)

        def save(self, obj):
            self.object = HelpdeskImport.create(
                self.helpdesk, self.request.user, self.import_type, self.form.get_config()
            )
            self.object.start_async()

    class Status(HelpdeskMixin, OrgPermsMixin, SmartTemplateView):
        """
        How the helpdesk's latest import is going, for the bar on the helpdesk page to keep current.
        """

        @classmethod
        def derive_url_pattern(cls, path, action):
            return r"^%s/%s/$" % (path, action)

        def render_to_response(self, context, **response_kwargs):
            latest = HelpdeskImport.get_latest(self.helpdesk)
            return JsonResponse({"results": [latest.as_json()] if latest else []})


class HelpSiteCRUDL(SmartCRUDL):
    model = HelpSite
    actions = ("update", "domain", "verify")

    class InferSite(HelpdeskMixin):
        """
        Views of the org's help site, in dialogs on the helpdesk page. The site is the org's one, inferred rather than
        named in the URL, and made the first time anyone comes here.
        """

        @classmethod
        def derive_url_pattern(cls, path, action):
            return r"^%s/%s/$" % (path, action)

        def get_object(self, *args, **kwargs):
            return HelpSite.get_or_create(self.helpdesk, self.request.user)

    class Update(InferSite, BaseUpdateModal):
        """
        The site's settings - what it says about itself, whether it's up, and its colors.
        """

        form_class = HelpSiteForm
        title = _("Site Settings")
        success_url = "hide"
        success_message = ""

        def derive_initial(self):
            initial = super().derive_initial()
            site = self.get_object()
            initial["primary_color"] = site.primary_color
            initial["header_color"] = site.header_color
            for key, color in site.bubbles.items():
                initial[f"bubble_{key}"] = color
            return initial

        def pre_save(self, obj):
            obj = super().pre_save(obj)
            obj.config = {
                **obj.config,
                HelpSite.CONFIG_PRIMARY_COLOR: self.form.cleaned_data["primary_color"],
                HelpSite.CONFIG_HEADER_COLOR: self.form.cleaned_data["header_color"],
            }
            return obj

        def post_save(self, obj):
            obj = super().post_save(obj)
            obj.set_bubbles({key: self.form.cleaned_data[f"bubble_{key}"] for key in HelpSite.BUBBLE_KEYS})
            return obj

    class Domain(InferSite, BaseUpdateModal):
        """
        The site's own domain, and the DNS records that put it into service: one pointing it at us, one proving it's
        the org's, which is checked on demand from here.
        """

        form_class = HelpSiteDomainForm
        title = _("Site Domain")
        success_url = "hide"
        success_message = ""

        def derive_initial(self):
            initial = super().derive_initial()
            initial["domain"] = self.get_object().domain
            return initial

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["cname_target"] = self.request.branding["domain"]
            context["verification_record_prefix"] = HelpSite.VERIFICATION_RECORD
            context["verify_url"] = reverse("knowledge.helpsite_verify")
            return context

        def post_save(self, obj):
            obj = super().post_save(obj)
            # a change of domain starts verification over
            obj.set_domain(self.request.user, self.form.cleaned_data["domain"])
            return obj

    class Verify(InferSite, PostOnlyMixin, OrgPermsMixin, SmartTemplateView):
        """
        Checks for the TXT record that proves the site's domain is the org's, asked for by the button in the domain
        dialog once the record has been added. Verified is what gets the domain served.
        """

        def post(self, request, *args, **kwargs):
            site = self.get_object()
            if not site.domain:
                return JsonResponse({"error": _("No domain has been set.")}, status=400)

            return JsonResponse({"domain": site.domain, "verified": site.verify_domain()})
