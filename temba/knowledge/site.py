from django.conf import settings
from django.core.exceptions import PermissionDenied
from django.http import Http404, HttpResponse, HttpResponsePermanentRedirect, HttpResponseRedirect
from django.shortcuts import render
from django.urls import re_path, reverse
from django.utils.translation import gettext_lazy as _
from django.views import View
from django.views.generic import TemplateView

from temba import helpsites
from temba.orgs.models import Org

from .models import ArticleCount, HelpSite, KnowledgeSource


class PreviewView(View):
    """
    A page of the org's own help site as its readers will see it, seen from inside the app by anyone who can see the
    site's settings - whether or not the site is up yet. The pages are rendered by the service that serves the site
    publicly, so what the org previews is what its readers get: this fetches the page from there, and passes it on.
    """

    def dispatch(self, request, *args, **kwargs):
        org = request.org
        user = request.user

        if not user.is_authenticated:
            return HttpResponseRedirect(f"{reverse('account_login')}?next={request.path}")
        if not org:
            return HttpResponseRedirect(reverse("orgs.org_choose"))
        if Org.FEATURE_AGENTS not in org.features or not (
            user.is_staff or user.has_org_perm(org, "knowledge.article_list")
        ):
            raise PermissionDenied()

        helpdesk = org.sources.filter(source_type=KnowledgeSource.TYPE_HELPDESK, is_system=True, is_active=True).first()
        if not helpdesk:
            raise Http404()

        self.site = HelpSite.get_or_create(helpdesk, user)

        return super().dispatch(request, *args, **kwargs)

    def get(self, request, path: str):
        page = helpsites.get_client().preview(self.site, path, request.META.get("QUERY_STRING", ""))

        # the page as the service rendered it - a redirect included, since where it goes is under the preview too
        response = HttpResponse(page.content, status=page.status_code, content_type=page.headers.get("Content-Type"))
        if location := page.headers.get("Location"):
            response.headers["Location"] = location
        response.headers["X-Robots-Tag"] = "noindex"  # the service says so too, but a preview is never for indexing
        return response


class SiteView(TemplateView):
    """
    A page of a help site, served publicly on the org's own domain - the one the request's host names. Being replaced
    by the service that renders the previews, which serves the same pages on the domains itself.
    """

    prefix = ""  # the site's pages are at the root of its domain

    def dispatch(self, request, *args, **kwargs):
        self.site = request.help_site
        if not self.site or not self.site.is_available:
            raise Http404()

        return super().dispatch(request, *args, **kwargs)

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["site"] = self.site
        context["prefix"] = self.prefix
        context["is_preview"] = False
        context["settings_url"] = None
        context.update(chat_context(self.site))
        return context


class HomeView(SiteView):
    template_name = "knowledge/site/home.html"

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["sections"] = self.site.get_sections()
        context["popular"] = self.site.get_popular()
        return context


class SectionView(SiteView):
    template_name = "knowledge/site/section.html"

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)

        section = self.site.get_section(kwargs["section"])
        if not section:
            raise Http404()

        articles = self.site.get_articles(section)
        if not articles:
            raise Http404()  # a section with nothing published in it isn't listed either

        context["section"] = section
        context["articles"] = articles
        return context


class ArticleView(SiteView):
    template_name = "knowledge/site/article.html"

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)

        section = self.site.get_section(kwargs["section"])
        article = self.site.get_article(section, kwargs["article"]) if section else None
        if not article:
            raise Http404()

        ArticleCount.record_view(article)

        context["section"] = section
        context["article"] = article
        context["html"], context["headings"] = article.render(links=self.site.get_link_targets(self.prefix))
        context["siblings"] = self.site.get_articles(section)
        return context


class RedirectView(SiteView):
    """
    Anything else asked of the site - which is where the addresses of the site the org moved from arrive. One the
    site's mapping knows is sent on to where that page lives now; anything else is not found.
    """

    def get(self, request, *args, **kwargs):
        address = self.site.get_redirect(kwargs["path"], self.prefix)
        if not address:
            raise Http404()

        return HttpResponsePermanentRedirect(address)


class SearchView(SiteView):
    template_name = "knowledge/site/search.html"

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)

        query = self.request.GET.get("q", "").strip()[:200]
        context["query"] = query
        context["results"] = self.site.search(query) if query else []
        return context


def chat_context(site: HelpSite) -> dict:
    """
    What a page needs to embed the site's chat widget: the WebChat channel it chats on, and the platform host the
    widget talks to - a reader is on the site's own domain, not ours.
    """
    return {"chat_channel": site.chat_channel, "chat_host": f"https://{settings.HOSTNAME}"}


def site_urlpatterns() -> list:
    """
    The site's URLs, at the root of its own domain. Search comes before the section pattern so it can't be shadowed
    by a section of that name.
    """
    return [
        re_path(r"^$", HomeView.as_view(), name="knowledge.site_home"),
        re_path(r"^search/$", SearchView.as_view(), name="knowledge.site_search"),
        re_path(r"^(?P<section>[\w-]+)/$", SectionView.as_view(), name="knowledge.site_section"),
        re_path(
            r"^(?P<section>[\w-]+)/(?P<article>[\w-]+)/$",
            ArticleView.as_view(),
            name="knowledge.site_article",
        ),
        re_path(r"^(?P<path>.+)$", RedirectView.as_view(), name="knowledge.site_redirect"),
    ]


def page_not_found(request, exception=None):
    """
    A 404 on a site's own domain is styled as one of its pages rather than as one of the app's.
    """
    site = getattr(request, "help_site", None)
    if not site or not site.is_available:
        return render(request, "knowledge/site/unavailable.html", {"title": _("Not available")}, status=404)

    return render(
        request,
        "knowledge/site/404.html",
        {"site": site, "prefix": "", "is_preview": False, **chat_context(site)},
        status=404,
    )
