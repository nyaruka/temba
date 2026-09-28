from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import call, patch

import dns.exception
import dns.resolver

from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.test import RequestFactory
from django.test.utils import override_settings
from django.utils import timezone

from temba.knowledge.middleware import HelpSiteMiddleware
from temba.knowledge.models import (
    Article,
    ArticleCount,
    HelpSite,
    KnowledgeSource,
    is_dark_color,
    lookup_txt,
    make_snippet,
    to_plain_text,
)
from temba.knowledge.tasks import check_helpsite_domains, squash_article_counts, trim_article_counts
from temba.mailroom.client.exceptions import RequestException
from temba.orgs.models import Org
from temba.tests import MockJsonResponse, TembaTest, mock_mailroom


class HelpSiteTest(TembaTest):
    def setUp(self):
        super().setUp()

        self.helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)
        self.org.features = [Org.FEATURE_AGENTS]
        self.org.save(update_fields=("features",))

    def create_article(self, title: str, *, parent=None, body="", description="", published=True):
        article = Article.create(self.helpdesk, self.admin, title, body=body, description=description, parent=parent)
        if published:
            article.publish(self.admin)
        return article

    def test_get_or_create(self):
        site = HelpSite.get_or_create(self.helpdesk, self.admin)

        self.assertEqual(self.helpdesk, site.source)
        self.assertEqual(self.org, site.org)
        self.assertEqual("Nyaruka", site.title)  # named for the org until told otherwise
        self.assertEqual("", site.tagline)
        self.assertFalse(site.is_enabled)
        self.assertIsNone(site.domain)
        self.assertEqual(self.admin, site.created_by)
        self.assertEqual("Nyaruka", str(site))

        # there's only ever one
        self.assertEqual(site, HelpSite.get_or_create(self.helpdesk, self.editor))
        self.assertEqual(1, HelpSite.objects.count())

        # and only for a helpdesk
        website = KnowledgeSource.create_website(self.org, self.admin, "Site", "https://nyaruka.com")
        with self.assertRaises(AssertionError):
            HelpSite.get_or_create(website, self.admin)

    def test_get_for_host(self):
        site = HelpSite.get_or_create(self.helpdesk, self.admin)

        self.assertIsNone(HelpSite.get_for_host("help.nyaruka.com"))

        # a domain that hasn't been verified isn't served
        site.set_domain(self.admin, "help.nyaruka.com")
        self.assertIsNone(HelpSite.get_for_host("help.nyaruka.com"))

        site.domain_verified_on = timezone.now()
        site.save(update_fields=("domain_verified_on",))

        self.assertEqual(site, HelpSite.get_for_host("help.nyaruka.com"))
        self.assertEqual(site, HelpSite.get_for_host("HELP.nyaruka.com:8000"))
        self.assertEqual(site, HelpSite.get_for_host("www.help.nyaruka.com"))
        self.assertIsNone(HelpSite.get_for_host("nyaruka.com"))
        self.assertIsNone(HelpSite.get_for_host(""))

        # the domains are cached, so a host that isn't a site's costs no query, and a site's costs one
        with self.assertNumQueries(0):
            self.assertIsNone(HelpSite.get_for_host("help.example.com"))
        with self.assertNumQueries(1):
            self.assertEqual(site, HelpSite.get_for_host("help.nyaruka.com"))

        # and any change to a site drops the cache - a changed domain starts unverified, so nothing is served
        site.set_domain(self.admin, "docs.nyaruka.com")
        self.assertIsNone(HelpSite.get_for_host("help.nyaruka.com"))
        self.assertIsNone(HelpSite.get_for_host("docs.nyaruka.com"))
        self.assertIsNone(site.domain_verified_on)

        site.domain_verified_on = timezone.now()
        site.save(update_fields=("domain_verified_on",))
        self.assertEqual(site, HelpSite.get_for_host("docs.nyaruka.com"))

        # setting the same domain again changes nothing
        site.set_domain(self.admin, " Docs.Nyaruka.com ")
        self.assertIsNotNone(site.domain_verified_on)

        site.delete()
        self.assertIsNone(HelpSite.get_for_host("docs.nyaruka.com"))

    @patch("temba.knowledge.models.lookup_txt")
    def test_verify_domain(self, mock_lookup):
        site = HelpSite.get_or_create(self.helpdesk, self.admin)
        self.assertEqual(32, len(site.domain_token))
        self.assertEqual("", site.verification_record)
        self.assertFalse(site.is_domain_verified)

        # nothing to verify without a domain
        self.assertFalse(site.verify_domain())
        mock_lookup.assert_not_called()

        site.set_domain(self.admin, "help.nyaruka.com")
        self.assertEqual("_helpsite-verification.help.nyaruka.com", site.verification_record)

        # the record has to hold the site's own token
        mock_lookup.return_value = []
        self.assertFalse(site.verify_domain())
        mock_lookup.return_value = None  # a lookup that failed
        self.assertFalse(site.verify_domain())
        mock_lookup.return_value = ["something-else", "v=spf1 -all"]
        self.assertFalse(site.verify_domain())
        self.assertFalse(site.is_domain_verified)
        mock_lookup.assert_called_with("_helpsite-verification.help.nyaruka.com")

        mock_lookup.return_value = ["other", site.domain_token]
        self.assertTrue(site.verify_domain())
        site.refresh_from_db()
        self.assertTrue(site.is_domain_verified)
        self.assertEqual(site, HelpSite.get_for_host("help.nyaruka.com"))

        # checking again keeps the original time
        verified_on = site.domain_verified_on
        self.assertTrue(site.verify_domain())
        site.refresh_from_db()
        self.assertEqual(verified_on, site.domain_verified_on)

        # a verified domain is one site's alone
        other = HelpSite.get_or_create(self.org2.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK), self.admin2)
        other.set_domain(self.admin2, "help.nyaruka.com")  # an unverified claim is allowed
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                other.domain_verified_on = timezone.now()
                other.save(update_fields=("domain_verified_on",))

        # verified domains are looked at again on a schedule, so one whose record has gone lapses - and can then
        # be verified by whoever has the domain now. A lookup that fails outright changes nothing
        mock_lookup.return_value = None
        self.assertEqual({"checked": 1, "lapsed": 0}, HelpSite.check_verified_domains())
        site.refresh_from_db()
        self.assertTrue(site.is_domain_verified)

        mock_lookup.return_value = ["v=spf1 -all"]
        self.assertEqual({"checked": 1, "lapsed": 1}, HelpSite.check_verified_domains())
        site.refresh_from_db()
        self.assertFalse(site.is_domain_verified)
        self.assertIsNone(HelpSite.get_for_host("help.nyaruka.com"))

        other.refresh_from_db()  # the save that failed above left the time set on the instance
        mock_lookup.return_value = [other.domain_token]
        self.assertTrue(other.verify_domain())
        self.assertEqual(other, HelpSite.get_for_host("help.nyaruka.com"))
        self.assertEqual({"checked": 1, "lapsed": 0}, check_helpsite_domains())

    def test_lookup_txt(self):
        answer = [SimpleNamespace(strings=[b"first ", b"part"]), SimpleNamespace(strings=[b"second"])]
        with patch("dns.resolver.Resolver.resolve", return_value=answer):
            self.assertEqual(["first part", "second"], lookup_txt("_helpsite-verification.help.nyaruka.com"))

        # a name that doesn't resolve or has no TXT records is no records...
        with patch("dns.resolver.Resolver.resolve", side_effect=dns.resolver.NXDOMAIN()):
            self.assertEqual([], lookup_txt("_helpsite-verification.nope.nyaruka.com"))
        with patch("dns.resolver.Resolver.resolve", side_effect=dns.resolver.NoAnswer()):
            self.assertEqual([], lookup_txt("_helpsite-verification.nope.nyaruka.com"))

        # ...while a lookup that fails says nothing either way
        with patch("dns.resolver.Resolver.resolve", side_effect=dns.exception.Timeout()):
            self.assertIsNone(lookup_txt("_helpsite-verification.help.nyaruka.com"))

        # what a domain is stored as
        self.assertEqual("help.nyaruka.com", HelpSite.clean_domain("  WWW.Help.Nyaruka.com "))
        self.assertIsNone(HelpSite.clean_domain(""))
        self.assertIsNone(HelpSite.clean_domain(None))

    def test_is_available(self):
        site = HelpSite.get_or_create(self.helpdesk, self.admin)
        self.assertFalse(site.is_available)

        site.is_enabled = True
        site.save(update_fields=("is_enabled",))
        self.assertFalse(site.is_available)  # not without a verified domain

        site.domain = "help.nyaruka.com"
        site.domain_verified_on = timezone.now()
        site.save(update_fields=("domain", "domain_verified_on"))
        self.assertTrue(site.is_available)

        # the feature going takes the site with it
        self.org.features = []
        self.org.save(update_fields=("features",))
        site = HelpSite.objects.get(id=site.id)
        self.assertFalse(site.is_available)

    def test_redirects(self):
        site = HelpSite.get_or_create(self.helpdesk, self.admin)
        flows = Article.create(self.helpdesk, self.admin, "Flows")
        nodes = Article.create(self.helpdesk, self.admin, "Nodes", parent=flows)
        for article in (flows, nodes):
            article.publish(self.admin)

        # paths are kept in one form, however they were written
        self.assertEqual("/en/article/nodes-x7ygk2", HelpSite.normalize_path("/en/article/nodes-x7ygk2/"))
        self.assertEqual("/en/article/nodes-x7ygk2", HelpSite.normalize_path(" en/Article/Nodes-X7YGK2?a=1#b "))

        self.assertIsNone(site.get_redirect("/en/article/nodes-x7ygk2/"))

        site.redirects = {"/en/article/nodes-x7ygk2": str(nodes.uuid), "/en/category/flows-6ogz7g": str(flows.uuid)}
        site.save(update_fields=("redirects",))

        self.assertEqual("/flows/nodes/", site.get_redirect("/EN/article/Nodes-x7ygk2?ref=1"))
        self.assertEqual(
            "/helpsite/preview/flows/", site.get_redirect("/en/category/flows-6ogz7g/", "/helpsite/preview")
        )
        self.assertIsNone(site.get_redirect("/en/article/other-abc123/"))

        # an old address only leads to a page the site has
        nodes.unpublish(self.admin)
        self.assertIsNone(site.get_redirect("/en/article/nodes-x7ygk2/"))
        self.assertIsNone(site.get_redirect("/en/category/flows-6ogz7g/"))

    def test_styles(self):
        site = HelpSite.get_or_create(self.helpdesk, self.admin)

        self.assertEqual(HelpSite.DEFAULT_PRIMARY_COLOR, site.primary_color)
        self.assertEqual(HelpSite.DEFAULT_HEADER_COLOR, site.header_color)
        self.assertEqual("#1f2430", site.header_text_color)
        self.assertEqual({}, site.bubbles)

        site.set_config(self.editor, primary_color="#ff6600", header_color="#1f2937")
        site.refresh_from_db()

        self.assertEqual("#ff6600", site.primary_color)
        self.assertEqual("#1f2937", site.header_color)
        self.assertEqual(self.editor, site.modified_by)

        # the header's text is whichever of dark or white reads on its background
        self.assertEqual("#ffffff", site.header_text_color)
        for color, dark in (("#000000", True), ("#ffffff", False), ("#2f6fed", True), ("#ffe8a3", False)):
            self.assertEqual(dark, is_dark_color(color), color)

        # the bubbles are the helpdesk's palette, by their keys - any other entries in it aren't bubbles
        self.helpdesk.set_colors({"0": "#000000", "2": "#FFE8A3"})
        self.assertEqual({"2": "#FFE8A3"}, site.bubbles)

        # and setting them replaces the palette with just the bubbles that are set
        site.set_bubbles({"1": "#ABCDEF", "2": "", "3": "#123456"})
        self.helpdesk.refresh_from_db()
        self.assertEqual({"1": "#abcdef", "3": "#123456"}, self.helpdesk.colors)
        self.assertEqual({"1", "3"}, set(self.helpdesk.color_styles))
        self.assertEqual({"1": "#abcdef", "3": "#123456"}, site.bubbles)

    def test_sections_and_articles(self):
        site = HelpSite.get_or_create(self.helpdesk, self.admin)

        flows = self.create_article("Flows", description="All about flows")
        nodes = self.create_article("Nodes", parent=flows, body="A node is...")
        self.create_article("Drafting", parent=flows, published=False)
        contacts = self.create_article("Contacts")
        importing = self.create_article("Importing", parent=contacts)
        empty = self.create_article("Empty")  # published, but nothing published under it
        self.create_article("Secret", parent=empty, published=False)
        hidden = self.create_article("Hidden", published=False)  # an unpublished section hides its articles
        self.create_article("Visible", parent=hidden)
        other_helpdesk = self.org2.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)
        other = Article.create(other_helpdesk, self.admin2, "Other")
        other.publish(self.admin2)

        sections = site.get_sections()
        self.assertEqual([flows, contacts], sections)
        self.assertEqual([1, 1], [s.num_articles for s in sections])

        self.assertEqual(flows, site.get_section("flows"))
        self.assertIsNone(site.get_section("hidden"))
        self.assertIsNone(site.get_section("nodes"))  # an article isn't a section
        self.assertIsNone(site.get_section("other"))

        self.assertEqual([nodes], site.get_articles(flows))
        self.assertEqual([importing], site.get_articles(contacts))
        self.assertEqual([], site.get_articles(empty))

        self.assertEqual(nodes, site.get_article(flows, "nodes"))
        self.assertIsNone(site.get_article(flows, "drafting"))
        self.assertIsNone(site.get_article(contacts, "nodes"))  # only under its own section
        self.assertIsNone(site.get_article(None, "nodes"))

        # a section moves off the site when it loses its last published article
        nodes.unpublish(self.admin)
        self.assertEqual([contacts], site.get_sections())

    def test_link_targets(self):
        site = HelpSite.get_or_create(self.helpdesk, self.admin)

        flows = self.create_article("Flows")
        nodes = self.create_article("Nodes", parent=flows)
        draft = self.create_article("Drafting", parent=flows, published=False)
        empty = self.create_article("Empty")
        hidden = self.create_article("Hidden", published=False)
        visible = self.create_article("Visible", parent=hidden)

        self.assertEqual({str(flows.uuid): "/flows/", str(nodes.uuid): "/flows/nodes/"}, site.get_link_targets())
        self.assertEqual(
            {str(flows.uuid): "/helpsite/preview/flows/", str(nodes.uuid): "/helpsite/preview/flows/nodes/"},
            site.get_link_targets("/helpsite/preview"),
        )
        for unreachable in (draft, empty, hidden, visible):
            self.assertNotIn(str(unreachable.uuid), site.get_link_targets())

        # a link resolves to wherever its target is now, and a link to nowhere is just its text
        article = self.create_article(
            "Links",
            parent=flows,
            body=f"See [nodes](article:{nodes.uuid}) and [drafting](article:{draft.uuid}) or "
            f"[ARTICLE:{str(nodes.uuid).upper()}](ARTICLE:{str(nodes.uuid).upper()}) and [google](https://google.com).",
        )
        self.assertEqual(
            '<p>See <a href="/flows/nodes/" rel="noopener noreferrer">nodes</a> and <span>drafting</span> or '
            f'<a href="/flows/nodes/" rel="noopener noreferrer">ARTICLE:{str(nodes.uuid).upper()}</a> and '
            '<a href="https://google.com" rel="noopener noreferrer">google</a>.</p>',
            article.as_html(links=site.get_link_targets()),
        )

        # without a map they're kept as article: links, normalized and bare, for whatever serves the page to resolve
        self.assertEqual(
            f'<p>See <a href="article:{nodes.uuid}">nodes</a> and <a href="article:{draft.uuid}">drafting</a> or '
            f'<a href="article:{nodes.uuid}">ARTICLE:{str(nodes.uuid).upper()}</a> and '
            '<a href="https://google.com" rel="noopener noreferrer">google</a>.</p>',
            article.as_html(),
        )

        # retitling the target moves the link with it
        nodes.title = "Flow Nodes"
        nodes.slug = Article.get_unique_slug(self.helpdesk, nodes.title, ignore=nodes)
        nodes.save(update_fields=("title", "slug"))
        self.assertIn('href="/flows/flow-nodes/"', article.as_html(links=site.get_link_targets()))

    def test_popular(self):
        site = HelpSite.get_or_create(self.helpdesk, self.admin)

        flows = self.create_article("Flows")
        nodes = self.create_article("Nodes", parent=flows)
        actions = self.create_article("Actions", parent=flows)
        draft = self.create_article("Drafting", parent=flows, published=False)
        hidden = self.create_article("Hidden", published=False)
        visible = self.create_article("Visible", parent=hidden)

        self.assertEqual([], site.get_popular())

        for _ in range(3):
            ArticleCount.record_view(nodes)
        ArticleCount.record_view(actions)
        for _ in range(5):
            ArticleCount.record_view(draft)  # not published, so not popular however often it was read
        for _ in range(5):
            ArticleCount.record_view(visible)  # nor is an article in an unpublished section

        # a view from before the window doesn't count
        ArticleCount.objects.create(
            article=actions, day=date.today() - timedelta(days=HelpSite.POPULAR_DAYS + 1), scope="views", count=10
        )

        self.assertEqual([nodes, actions], site.get_popular())
        self.assertEqual([nodes], site.get_popular(limit=1))

        # squashing doesn't change the ranking
        squash_article_counts()
        self.assertEqual(1, ArticleCount.objects.filter(article=nodes).count())
        self.assertEqual(3, ArticleCount.objects.filter(article=nodes).sum())
        self.assertEqual([nodes, actions], site.get_popular())

        # trimming drops the old view
        with override_settings(RETENTION_PERIODS={"articlecount": timedelta(days=HelpSite.POPULAR_DAYS)}):
            trim_article_counts()
        self.assertEqual(1, ArticleCount.objects.filter(article=actions).sum())

    @mock_mailroom
    def test_search(self, mr_mocks):
        site = HelpSite.get_or_create(self.helpdesk, self.admin)

        flows = self.create_article("Flows")
        nodes = self.create_article("Nodes", parent=flows, body="A **node** is a step in a flow. Nodes have actions.")
        actions = self.create_article("Actions", parent=flows, body="An action does something to a contact.")
        draft = self.create_article("Node Drafting", parent=flows, body="Unfinished node notes", published=False)
        hidden = self.create_article("Hidden", published=False)
        self.create_article("Hidden Nodes", parent=hidden, body="nodes nodes nodes")

        self.assertEqual([], site.search(""))
        self.assertEqual([], site.search("   "))

        # nothing indexed yet, so text search alone answers - titles outrank bodies, and the drafts and the hidden
        # section aren't searched
        results = site.search("node")
        self.assertEqual([nodes], [a for a, _ in results])
        self.assertEqual("A <mark>node</mark> is a step in a flow. <mark>Node</mark>s have actions.", results[0][1])

        # the site is public, so the same search again is answered from the last time - one query to check the
        # articles are still readable, rather than a scan of every body
        with self.assertNumQueries(1):
            self.assertEqual(results, site.search("  Node "))

        nodes.unpublish(self.admin)
        self.assertEqual([], site.search("node"))
        nodes.publish(self.admin)

        self.assertEqual([actions], [a for a, _ in site.search("action")])  # no stemming, so not "actions"
        self.assertEqual([], site.search("unfinished"))
        self.assertEqual([], site.search("xyzzy"))
        cache.clear()

        # once the helpdesk has been indexed, mailroom's semantic search leads, with text search filling in behind
        self.helpdesk.last_indexed_on = timezone.now()
        self.helpdesk.save(update_fields=("last_indexed_on",))

        mr_mocks.knowledge_search(
            [
                {
                    "source_uuid": str(self.helpdesk.uuid),
                    "item_key": str(actions.uuid),
                    "item_name": "Actions",
                    "text": "An action does something to a contact.",
                    "score": 0.9,
                },
                {  # and so is one for an article that isn't published
                    "source_uuid": str(self.helpdesk.uuid),
                    "item_key": str(draft.uuid),
                    "item_name": "Node Drafting",
                    "text": "Unfinished node notes",
                    "score": 0.8,
                },
                {  # a second chunk from an article already listed doesn't list it twice
                    "source_uuid": str(self.helpdesk.uuid),
                    "item_key": str(actions.uuid),
                    "item_name": "Actions",
                    "text": "More about actions.",
                    "score": 0.7,
                },
            ]
        )

        results = site.search("what is a node")
        self.assertEqual([actions, nodes], [a for a, _ in results])
        self.assertEqual("An action does something to a contact.", results[0][1])  # the chunk's own text
        self.assertEqual(
            "A <mark>node</mark> is a step in a flow. <mark>Node</mark>s have actions.", results[1][1]
        )  # from the text search
        self.assertEqual(
            call(self.org, "what is a node", sources=[self.helpdesk], limit=HelpSite.SEARCH_LIMIT * 3),
            mr_mocks.calls["knowledge_search"][0],
        )

        # and isn't asked again for the same search while the answer is fresh
        self.assertEqual([actions, nodes], [a for a, _ in site.search("what is a node")])
        self.assertEqual(1, len(mr_mocks.calls["knowledge_search"]))

        # mailroom being down doesn't take search with it
        mr_mocks.exception(RequestException("knowledge/search", {}, MockJsonResponse(500, {"error": "boom"})))
        with patch("temba.knowledge.models.logger") as mock_logger:
            self.assertEqual([nodes], [a for a, _ in site.search("node")])
        self.assertTrue(mock_logger.error.called)

        # a limit is a limit whichever search filled it
        mr_mocks.knowledge_search([])
        self.assertEqual([actions], [a for a, _ in site.search("action", limit=1)])

    def test_delete(self):
        site = HelpSite.get_or_create(self.helpdesk, self.admin)

        flows = self.create_article("Flows")
        nodes = self.create_article("Nodes", parent=flows)
        ArticleCount.record_view(nodes)

        # purging the helpdesk takes the site and the counts with it
        self.helpdesk.delete()

        self.assertFalse(HelpSite.objects.filter(id=site.id).exists())
        self.assertEqual(0, ArticleCount.objects.count())

    def test_to_plain_text(self):
        self.assertEqual(
            "Heading A node is a step. See the guide and more. one two Quote value Text",
            to_plain_text(
                "# Heading\n\nA **node** is a _step_. See [the guide](https://x.com) and ![shot](https://x.com/s.png) "
                "more.\n\n- one\n- two\n\n> Quote\n\n```\ncode\n```\n\n| width: 50% | |\n| --- | --- |\n"
                "| `value` | Text<br>|"
            ),
        )
        self.assertEqual("", to_plain_text(""))

    def test_make_snippet(self):
        text = "The quick brown fox jumps over the lazy dog. " * 10

        # no terms found - just the start
        snippet = make_snippet(text, ["cat"], length=30)
        self.assertEqual("The quick brown fox jumps…", snippet)

        # a term found - a window around it, with the term marked and everything else escaped
        snippet = make_snippet(
            "Some <b>bold</b> text about the lazy dog and more words after", ["lazy", "dog"], length=30
        )
        self.assertEqual("…about the <mark>lazy</mark> <mark>dog</mark> and more…", snippet)

        # short text needs no ellipsis
        self.assertEqual("Just <mark>this</mark>", make_snippet("Just this", ["this", ""]))
        self.assertEqual("Just this", make_snippet("Just this", []))

    def test_excerpt(self):
        article = self.create_article("Long", body="# Title\n\n" + "word " * 100)
        excerpt = article.excerpt(length=40)
        self.assertTrue(excerpt.endswith("…"))
        self.assertLessEqual(len(excerpt), 41)
        self.assertEqual("Short", self.create_article("Short", body="Short").excerpt())


class HelpSiteMiddlewareTest(TembaTest):
    def test_middleware(self):
        helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)
        site = HelpSite.get_or_create(helpdesk, self.admin)
        site.domain = "help.nyaruka.com"
        site.domain_verified_on = timezone.now()
        site.save(update_fields=("domain", "domain_verified_on"))

        seen = {}

        def get_response(request):
            seen["site"] = request.help_site
            seen["urlconf"] = getattr(request, "urlconf", None)
            return "response"

        middleware = HelpSiteMiddleware(get_response)

        # a request on the app's own domain is untouched
        with override_settings(ALLOWED_HOSTS=["*"]):
            middleware(RequestFactory().get("/", HTTP_HOST="app.rapidpro.io"))
            self.assertIsNone(seen["site"])
            self.assertIsNone(seen["urlconf"])

            # as is one on a domain nobody has claimed
            middleware(RequestFactory().get("/", HTTP_HOST="help.example.com"))
            self.assertIsNone(seen["site"])

            # but on the site's domain, the site is served and nothing else
            middleware(RequestFactory().get("/flows/", HTTP_HOST="help.nyaruka.com:443"))
            self.assertEqual(site, seen["site"])
            self.assertEqual("temba.knowledge.site_urls", seen["urlconf"])
