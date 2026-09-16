from django.test.utils import override_settings
from django.urls import reverse
from django.utils import timezone

from temba.knowledge.models import Article, ArticleCount, HelpSite, KnowledgeSource
from temba.orgs.models import Org
from temba.tests import TembaTest


@override_settings(ALLOWED_HOSTS=["*"])
class SiteViewsTest(TembaTest):
    """
    The site's pages, as the public sees them on the site's domain and as the org sees them previewing.
    """

    def setUp(self):
        super().setUp()

        self.helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)
        self.org.features = [Org.FEATURE_AGENTS]
        self.org.save(update_fields=("features",))

        self.site = HelpSite.get_or_create(self.helpdesk, self.admin)
        self.site.domain = "help.nyaruka.com"
        self.site.domain_verified_on = timezone.now()
        self.site.tagline = "Answers for everyone"
        self.site.footer = "Made by Nyaruka"
        self.site.is_enabled = True
        self.site.save()

        self.flows = self.create_article("Flows", description="All about flows")
        self.nodes = self.create_article("Nodes", parent=self.flows, body="A **node** is a step in a flow.")
        self.actions = self.create_article("Actions", parent=self.flows, body="Actions do things.")
        self.actions.body = f"Actions do things. See [nodes](article:{self.nodes.uuid})."
        self.actions.save(update_fields=("body",))
        self.contacts = self.create_article("Contacts")
        self.importing = self.create_article("Importing", parent=self.contacts, body="Import from a spreadsheet.")
        self.draft = self.create_article("Drafting", parent=self.flows, published=False)
        self.hidden = self.create_article("Hidden", published=False)
        self.create_article("Visible", parent=self.hidden)

    def create_article(self, title: str, *, parent=None, body="", description="", published=True):
        article = Article.create(self.helpdesk, self.admin, title, body=body, description=description, parent=parent)
        if published:
            article.publish(self.admin)
        return article

    def public(self, path: str, host="help.nyaruka.com", **kwargs):
        return self.client.get(path, HTTP_HOST=host, **kwargs)

    def test_public_home(self):
        response = self.public("/")
        self.assertEqual(200, response.status_code)
        self.assertEqual(self.site, response.context["site"])
        self.assertEqual("", response.context["prefix"])
        self.assertFalse(response.context["is_preview"])
        self.assertEqual([self.flows, self.contacts], response.context["sections"])
        self.assertEqual([], response.context["popular"])
        self.assertContains(response, "Answers for everyone")
        self.assertContains(response, "Made by Nyaruka")
        self.assertContains(response, 'href="/flows/"')
        self.assertContains(response, "2 articles")
        self.assertContains(response, "1 article")
        self.assertNotContains(response, "Hidden")
        self.assertNotContains(response, "preview-bar")
        self.assertNotIn("X-Robots-Tag", response.headers)

        # the site's colors go into the page, with whatever text reads on the header
        self.assertContains(response, f"--primary: {HelpSite.DEFAULT_PRIMARY_COLOR};")
        self.assertContains(response, f"--header-bg: {HelpSite.DEFAULT_HEADER_COLOR};")
        self.assertContains(response, "--header-text: #1f2430;")

        self.site.set_config(self.admin, primary_color="#ff6600", header_color="#1f2937")
        response = self.public("/")
        self.assertContains(response, "--primary: #ff6600;")
        self.assertContains(response, "--header-bg: #1f2937;")
        self.assertContains(response, "--header-text: #ffffff;")

        # there's no chat widget until the site has a chat channel
        self.assertNotContains(response, "<temba-webchat")

        webchat = self.create_channel("WCH", "Site Chat", None)
        self.site.set_config(self.admin, chat_channel=str(webchat.uuid))

        with override_settings(HOSTNAME="app.nyaruka.com"):
            response = self.public("/")
            self.assertContains(response, "components/temba-webchat.js")
            self.assertContains(response, f'<temba-webchat channel="{webchat.uuid}" host="https://app.nyaruka.com">')

            # on every page of the site, including the preview
            self.assertContains(self.public("/flows/"), f'<temba-webchat channel="{webchat.uuid}"')
            self.assertContains(
                self.public("/nothing/here/"), f'<temba-webchat channel="{webchat.uuid}"', status_code=404
            )
            self.login(self.admin)
            self.assertContains(self.client.get("/helpsite/preview/"), f'<temba-webchat channel="{webchat.uuid}"')
            self.client.logout()

        # and none once the channel is gone
        webchat.release(self.admin)
        self.assertNotContains(self.public("/"), "<temba-webchat")

        # popular articles show up once there are views
        for _ in range(2):
            ArticleCount.record_view(self.importing)
        ArticleCount.record_view(self.nodes)
        response = self.public("/")
        self.assertEqual([self.importing, self.nodes], response.context["popular"])
        self.assertContains(response, 'href="/contacts/importing/"')

        # any port and a www prefix still find the site
        self.assertEqual(200, self.public("/", host="www.help.nyaruka.com:8000").status_code)

        # only the site is served on its domain - none of the app's pages
        response = self.public(reverse("orgs.org_workspace"))
        self.assertEqual(404, response.status_code)
        self.assertTemplateUsed(response, "knowledge/site/404.html")

        # a site that isn't enabled isn't served
        self.site.is_enabled = False
        self.site.save(update_fields=("is_enabled",))
        response = self.public("/")
        self.assertEqual(404, response.status_code)
        self.assertTemplateUsed(response, "knowledge/site/unavailable.html")
        self.assertContains(response, "This help site isn't available", status_code=404)

        # and a domain that isn't a site's at all gets the app
        response = self.public("/", host="help.example.com")
        self.assertNotEqual(404, response.status_code)
        self.assertNotIn("site", response.context or {})

    def test_public_section(self):
        response = self.public("/flows/")
        self.assertEqual(200, response.status_code)
        self.assertEqual(self.flows, response.context["section"])
        self.assertEqual([self.nodes, self.actions], response.context["articles"])
        self.assertContains(response, "All about flows")
        self.assertContains(response, 'href="/flows/nodes/"')
        self.assertContains(response, "A node is a step in a flow.")  # the excerpt, as plain text
        self.assertNotContains(response, "Drafting")

        self.assertEqual(404, self.public("/hidden/").status_code)
        self.assertEqual(404, self.public("/nope/").status_code)
        self.assertEqual(404, self.public("/nodes/").status_code)  # an article isn't a section

        # a section with nothing published in it isn't a page
        self.nodes.unpublish(self.admin)
        self.actions.unpublish(self.admin)
        self.assertEqual(404, self.public("/flows/").status_code)

    def test_public_article(self):
        response = self.public("/flows/nodes/")
        self.assertEqual(200, response.status_code)
        self.assertEqual(self.flows, response.context["section"])
        self.assertEqual(self.nodes, response.context["article"])
        self.assertEqual([self.nodes, self.actions], response.context["siblings"])
        self.assertContains(response, "<p>A <strong>node</strong> is a step in a flow.</p>")
        self.assertContains(response, 'aria-current="page"')
        self.assertContains(response, "Nodes | Nyaruka")

        # links between articles resolve to the site's own addresses
        response = self.public("/flows/actions/")
        self.assertContains(response, 'See <a href="/flows/nodes/" rel="noopener noreferrer">nodes</a>.')

        # reading counts as a view
        self.assertEqual(1, ArticleCount.objects.filter(article=self.nodes, scope="views").sum())
        self.public("/flows/nodes/")
        self.assertEqual(2, ArticleCount.objects.filter(article=self.nodes, scope="views").sum())

        self.assertEqual(404, self.public("/flows/drafting/").status_code)
        self.assertEqual(404, self.public("/contacts/nodes/").status_code)  # only under its own section
        self.assertEqual(404, self.public("/hidden/visible/").status_code)
        self.assertEqual(404, self.public("/nope/nodes/").status_code)

    def test_public_search(self):
        response = self.public("/search/?q=node")
        self.assertEqual(200, response.status_code)
        self.assertEqual("node", response.context["query"])
        self.assertEqual([self.nodes], [a for a, _ in response.context["results"]])
        self.assertContains(response, "1 result for “node”")
        self.assertContains(response, "<mark>node</mark>")
        self.assertContains(response, 'value="node"')  # the query stays in the box

        response = self.public("/search/?q=xyzzy")
        self.assertEqual([], response.context["results"])
        self.assertContains(response, "No articles matched your search")

        response = self.public("/search/")
        self.assertEqual("", response.context["query"])
        self.assertEqual([], response.context["results"])
        self.assertNotContains(response, "No articles matched")

        # a query can't be unreasonably long
        response = self.public("/search/?q=" + "a" * 300)
        self.assertEqual(200, len(response.context["query"]))

    def test_redirects(self):
        # the addresses of the site the org moved from send readers on to where the articles live now
        self.site.redirects = {
            "/en/article/flow-nodes-x7ygk2": str(self.nodes.uuid),
            "/en/category/flows-6ogz7g": str(self.flows.uuid),
            "/en/category/hidden-1abc2d": str(self.hidden.uuid),
        }
        self.site.save(update_fields=("redirects",))

        response = self.public("/en/article/flow-nodes-x7ygk2/")
        self.assertEqual(301, response.status_code)
        self.assertEqual("/flows/nodes/", response.url)

        # however the address was written
        response = self.public("/EN/article/Flow-Nodes-x7ygk2?ref=1")
        self.assertEqual(301, response.status_code)
        self.assertEqual("/flows/nodes/", response.url)

        # a section's too
        response = self.public("/en/category/flows-6ogz7g/")
        self.assertEqual(301, response.status_code)
        self.assertEqual("/flows/", response.url)

        # but not to a page the site doesn't have - an address that was never mapped, or one whose article isn't
        # published, or a section with nothing published in it
        for path in ("/en/article/other-abc123/", "/en/category/hidden-1abc2d/", "/robots.txt"):
            response = self.public(path)
            self.assertEqual(404, response.status_code, path)
            self.assertTemplateUsed(response, "knowledge/site/404.html")

        self.nodes.unpublish(self.admin)
        self.assertEqual(404, self.public("/en/article/flow-nodes-x7ygk2/").status_code)

        # and in the preview, on to the preview's own pages
        self.login(self.editor)
        response = self.client.get("/helpsite/preview/en/category/flows-6ogz7g/")
        self.assertEqual(301, response.status_code)
        self.assertEqual("/helpsite/preview/flows/", response.url)

    def test_preview(self):
        home_url = reverse("knowledge.site_home")
        self.assertEqual("/helpsite/preview/", home_url)

        # nobody sees the preview without logging in..
        response = self.client.get(home_url)
        self.assertRedirect(response, reverse("account_login"))
        self.assertEqual(f"{reverse('account_login')}?next={home_url}", response.url)

        # ..or without the feature..
        self.org.features = []
        self.org.save(update_fields=("features",))
        self.login(self.admin)
        self.assertEqual(403, self.client.get(home_url).status_code)

        self.org.features = [Org.FEATURE_AGENTS]
        self.org.save(update_fields=("features",))

        # ..or as an agent
        self.login(self.agent)
        self.assertEqual(403, self.client.get(home_url).status_code)

        # an editor can preview it, whether or not it's enabled
        self.site.is_enabled = False
        self.site.save(update_fields=("is_enabled",))

        self.login(self.editor)
        response = self.client.get(home_url)
        self.assertEqual(200, response.status_code)
        self.assertEqual(self.site, response.context["site"])
        self.assertEqual("/helpsite/preview", response.context["prefix"])
        self.assertTrue(response.context["is_preview"])
        self.assertEqual("noindex", response.headers["X-Robots-Tag"])
        self.assertContains(response, 'content="noindex"')
        self.assertContains(response, "This is a preview of your help site")
        self.assertContains(response, f'href="{reverse("knowledge.article_list")}"')
        self.assertContains(response, 'href="/helpsite/preview/flows/"')

        # the pages are the same ones, under the prefix
        response = self.client.get(reverse("knowledge.site_section", args=["flows"]))
        self.assertEqual(200, response.status_code)
        self.assertContains(response, 'href="/helpsite/preview/flows/nodes/"')

        response = self.client.get(reverse("knowledge.site_article", args=["flows", "nodes"]))
        self.assertEqual(200, response.status_code)
        self.assertContains(response, 'href="/helpsite/preview/"')

        # and so do the links between articles
        response = self.client.get(reverse("knowledge.site_article", args=["flows", "actions"]))
        self.assertContains(response, 'href="/helpsite/preview/flows/nodes/"')

        # but previewing an article isn't reading it
        self.assertEqual(0, ArticleCount.objects.count())

        response = self.client.get(reverse("knowledge.site_search") + "?q=node")
        self.assertEqual([self.nodes], [a for a, _ in response.context["results"]])

        self.assertEqual(404, self.client.get(reverse("knowledge.site_section", args=["nope"])).status_code)

        # an org without the feature has no preview
        self.login(self.admin2)
        self.assertEqual(403, self.client.get(home_url).status_code)

        # a user without a workspace is sent to pick one
        self.login(self.create_user("nobody@textit.com"))
        self.assertRedirect(self.client.get(home_url), reverse("orgs.org_choose"))

        # staff can preview any org's site when servicing it
        self.login(self.customer_support, choose_org=self.org)
        self.assertEqual(200, self.client.get(home_url).status_code)

        # a site is made for the org the first time its preview is opened
        self.site.delete()
        self.login(self.admin)
        response = self.client.get(home_url)
        self.assertEqual(200, response.status_code)
        self.assertEqual(1, HelpSite.objects.filter(source=self.helpdesk).count())

        # but not for a helpdesk that's gone
        self.helpdesk.is_active = False
        self.helpdesk.save(update_fields=("is_active",))
        self.assertEqual(404, self.client.get(home_url).status_code)
