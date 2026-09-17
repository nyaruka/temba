from xml.etree.ElementTree import Element, SubElement

from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError
from django.test.utils import override_settings

from temba.knowledge.models import (
    Article,
    ArticleCount,
    ArticleImage,
    ColumnStylesProcessor,
    HelpSite,
    KnowledgeChunk,
    KnowledgeItem,
    KnowledgeSource,
    _sanitize_attribute,
    get_article_image_path,
    parse_column_style,
)
from temba.tests import TembaTest, cleanup
from temba.utils.s3 import public_file_storage
from temba.utils.uuid import uuid4


class KnowledgeSourceTest(TembaTest):
    def create_chunk(self, source, item_key, text: str):
        return KnowledgeChunk.objects.create(
            source=source, item_key=item_key, item_name="Test", text=text, embedding=[0.0] * 384
        )

    def create_article(self, source, title: str, *, parent=None, status=Article.STATUS_DRAFT):
        return Article.objects.create(
            source=source,
            parent=parent,
            title=title,
            slug=Article.get_unique_slug(source, title),
            status=status,
            created_by=self.admin,
            modified_by=self.admin,
        )

    def test_create_system(self):
        # both orgs got their system sources from Org.initialize()
        shortcuts = self.org.sources.get(source_type=KnowledgeSource.TYPE_SHORTCUTS)
        helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)

        self.assertEqual("Shortcuts", shortcuts.name)
        self.assertTrue(shortcuts.is_system)
        self.assertEqual("Helpdesk", helpdesk.name)
        self.assertTrue(helpdesk.is_system)
        self.assertEqual(2, self.org2.sources.filter(is_system=True).count())

        # can't create them again
        with self.assertRaises(AssertionError):
            KnowledgeSource.create_system(self.org)

    def test_create_website(self):
        website = KnowledgeSource.create_website(self.org, self.admin, "Nyaruka", "https://nyaruka.com")

        self.assertEqual("Nyaruka", website.name)
        self.assertEqual(KnowledgeSource.TYPE_WEBSITE, website.source_type)
        self.assertEqual("https://nyaruka.com", website.url)
        self.assertEqual(
            {"url": "https://nyaruka.com", "max_depth": 3, "max_pages": 500, "refresh": "weekly"}, website.config
        )
        self.assertEqual(KnowledgeSource.STATUS_PENDING, website.status)
        self.assertFalse(website.is_system)

        # explicit settings are used as given
        custom = KnowledgeSource.create_website(
            self.org, self.admin, "Custom", "https://example.com", max_depth=2, max_pages=100, refresh="daily"
        )
        self.assertEqual(
            {"url": "https://example.com", "max_depth": 2, "max_pages": 100, "refresh": "daily"}, custom.config
        )

        # try to create with an invalid name
        with self.assertRaises(AssertionError):
            KnowledgeSource.create_website(self.org, self.admin, '"Nope"', "https://nyaruka.com")

        # try to create with a name that's taken
        with self.assertRaises(AssertionError):
            KnowledgeSource.create_website(self.org, self.admin, "nyaruka", "https://nyaruka.com")

    def test_create_documents(self):
        docs = KnowledgeSource.create_documents(self.org, self.admin, "Guides")

        self.assertEqual("Guides", docs.name)
        self.assertEqual(KnowledgeSource.TYPE_DOCUMENTS, docs.source_type)
        self.assertEqual({}, docs.config)
        self.assertIsNone(docs.url)
        self.assertEqual(KnowledgeSource.STATUS_READY, docs.status)  # nothing to index yet

        with self.assertRaises(AssertionError):
            KnowledgeSource.create_documents(self.org, self.admin, '"Nope"')
        with self.assertRaises(AssertionError):
            KnowledgeSource.create_documents(self.org, self.admin, "guides")

    def test_unique_names(self):
        KnowledgeSource.create_documents(self.org, self.admin, "Guides")

        with self.assertRaises(IntegrityError):
            self.org.sources.create(
                name="GUIDES",
                source_type=KnowledgeSource.TYPE_DOCUMENTS,
                created_by=self.admin,
                modified_by=self.admin,
            )

    @override_settings(ORG_LIMIT_DEFAULTS={"knowledge": 2})
    def test_limits(self):
        # neither system row counts against the limit
        self.assertFalse(KnowledgeSource.is_limit_reached(self.org))

        KnowledgeSource.create_documents(self.org, self.admin, "Guides")
        self.assertFalse(KnowledgeSource.is_limit_reached(self.org))

        KnowledgeSource.create_website(self.org, self.admin, "Nyaruka", "https://nyaruka.com")
        self.assertTrue(KnowledgeSource.is_limit_reached(self.org))
        self.assertFalse(KnowledgeSource.is_limit_reached(self.org2))

    def test_mark_pending(self):
        docs = KnowledgeSource.create_documents(self.org, self.admin, "Guides")
        docs.status = KnowledgeSource.STATUS_FAILED
        docs.error = "boom"
        docs.save(update_fields=("status", "error"))

        docs.mark_pending()

        docs.refresh_from_db()
        self.assertEqual(KnowledgeSource.STATUS_PENDING, docs.status)
        self.assertIsNone(docs.error)

    @cleanup(s3=True)
    def test_release(self):
        docs = KnowledgeSource.create_documents(self.org, self.admin, "Guides")
        item = KnowledgeItem.from_upload(
            docs, self.admin, SimpleUploadedFile("guide.txt", b"hello", content_type="text/plain")
        )
        self.create_chunk(docs, item.uuid, "hello")
        docs.num_items = 1
        docs.num_chunks = 1
        docs.save(update_fields=("num_items", "num_chunks"))

        # can't release either system source
        for kb_type in KnowledgeSource.SYSTEM_TYPES:
            with self.assertRaises(AssertionError):
                self.org.sources.get(source_type=kb_type).release(self.admin)

        docs.release(self.admin)

        docs.refresh_from_db()
        self.assertFalse(docs.is_active)
        self.assertTrue(docs.name.startswith("deleted-"))
        self.assertEqual(0, docs.num_items)
        self.assertEqual(0, docs.num_chunks)
        self.assertEqual(0, docs.items.count())
        self.assertEqual(0, docs.chunks.count())
        self.assertFalse(default_storage.exists(item.path))

    @cleanup(s3=True)
    def test_delete(self):
        # deleting purges articles and their images - use the system helpdesk row since that's where articles live
        helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)
        parent = self.create_article(helpdesk, "Flows", status=Article.STATUS_PUBLISHED)
        child = self.create_article(helpdesk, "Nodes", parent=parent)
        self.create_chunk(helpdesk, parent.uuid, "flows are...")

        image_path = public_file_storage.save(
            get_article_image_path(parent, uuid4(), "image/png"), SimpleUploadedFile("shot1.png", b"png")
        )
        ArticleImage.objects.create(
            article=parent,
            name="shot1.png",
            path=image_path,
            content_type="image/png",
            size=3,
            created_by=self.admin,
        )
        ArticleCount.record_view(parent)
        site = HelpSite.get_or_create(helpdesk, self.admin)

        helpdesk.delete()

        self.assertFalse(KnowledgeSource.objects.filter(id=helpdesk.id).exists())
        self.assertFalse(Article.objects.filter(id__in=(parent.id, child.id)).exists())
        self.assertEqual(0, ArticleImage.objects.count())
        self.assertEqual(0, ArticleCount.objects.count())
        self.assertFalse(HelpSite.objects.filter(id=site.id).exists())
        self.assertEqual(0, KnowledgeChunk.objects.count())
        self.assertFalse(public_file_storage.exists(image_path))


class KnowledgeItemTest(TembaTest):
    def create_chunk(self, source, item_key, text: str):
        return KnowledgeChunk.objects.create(
            source=source, item_key=item_key, item_name="Test", text=text, embedding=[0.0] * 384
        )

    def test_clean_name(self):
        self.assertEqual("guide.pdf", KnowledgeItem.clean_name("guide.pdf"))
        self.assertEqual("guide (1) [final].pdf", KnowledgeItem.clean_name("guide (1) [final].pdf"))
        self.assertEqual("etcpasswd", KnowledgeItem.clean_name("/etc/passwd"))
        self.assertEqual("file.pdf", KnowledgeItem.clean_name("!!!.pdf"))
        self.assertEqual("x" * 200 + ".pdf", KnowledgeItem.clean_name("x" * 300 + ".pdf"))

    def test_is_allowed_type(self):
        self.assertTrue(KnowledgeItem.is_allowed_type("application/pdf"))
        self.assertTrue(KnowledgeItem.is_allowed_type("text/plain"))
        self.assertFalse(KnowledgeItem.is_allowed_type("image/png"))

    @cleanup(s3=True)
    def test_from_upload(self):
        docs = KnowledgeSource.create_documents(self.org, self.admin, "Guides")
        self.assertEqual(KnowledgeSource.STATUS_READY, docs.status)

        item = KnowledgeItem.from_upload(
            docs, self.admin, SimpleUploadedFile("A Guide!.txt", b"hello world", content_type="text/plain")
        )

        self.assertEqual(docs, item.source)
        self.assertEqual("A Guide.txt", item.name)
        self.assertIsNone(item.url)
        self.assertEqual(f"orgs/{self.org.id}/knowledge/{docs.uuid}/{item.uuid}.txt", item.path)
        self.assertEqual("text/plain", item.content_type)
        self.assertEqual(11, item.size)
        self.assertEqual(KnowledgeItem.STATUS_PENDING, item.status)
        self.assertEqual(self.admin, item.created_by)
        self.assertEqual(self.org, item.org)
        self.assertTrue(default_storage.exists(item.path))

        # the parent source now needs reindexing
        docs.refresh_from_db()
        self.assertEqual(KnowledgeSource.STATUS_PENDING, docs.status)

    @cleanup(s3=True)
    def test_delete(self):
        docs = KnowledgeSource.create_documents(self.org, self.admin, "Guides")
        item1 = KnowledgeItem.from_upload(
            docs, self.admin, SimpleUploadedFile("one.txt", b"one", content_type="text/plain")
        )
        item2 = KnowledgeItem.from_upload(
            docs, self.admin, SimpleUploadedFile("two.txt", b"two", content_type="text/plain")
        )
        self.create_chunk(docs, item1.uuid, "one")
        chunk2 = self.create_chunk(docs, item2.uuid, "two")

        docs.status = KnowledgeSource.STATUS_READY
        docs.save(update_fields=("status",))

        item1_path = item1.path
        item1.delete()

        # only item1's chunks are gone and the source is pending again
        self.assertFalse(KnowledgeItem.objects.filter(id=item1.id).exists())
        self.assertEqual([chunk2], list(docs.chunks.all()))
        self.assertFalse(default_storage.exists(item1_path))
        self.assertTrue(default_storage.exists(item2.path))
        docs.refresh_from_db()
        self.assertEqual(KnowledgeSource.STATUS_PENDING, docs.status)

        # a crawled page row has no storage object - deleting it is a no-op on storage
        website = KnowledgeSource.create_website(self.org, self.admin, "Nyaruka", "https://nyaruka.com")
        page = KnowledgeItem.objects.create(
            source=website, name="Home", url="https://nyaruka.com/", content_type="text/html", size=1024
        )
        page.delete()
        self.assertFalse(KnowledgeItem.objects.filter(id=page.id).exists())

    def test_unique_urls(self):
        website = KnowledgeSource.create_website(self.org, self.admin, "Nyaruka", "https://nyaruka.com")
        KnowledgeItem.objects.create(
            source=website, name="Home", url="https://nyaruka.com/", content_type="text/html", size=1024
        )

        # same url within the source collides
        with self.assertRaises(IntegrityError):
            KnowledgeItem.objects.create(
                source=website, name="Home Again", url="https://nyaruka.com/", content_type="text/html", size=1024
            )

    def test_null_urls_can_coexist(self):
        # the subtle side of unique_knowledge_item_urls: NULLs are distinct, so documents are exempt
        docs = KnowledgeSource.create_documents(self.org, self.admin, "Guides")
        KnowledgeItem.objects.create(
            source=docs, name="one.txt", url=None, path="a/b/one.txt", content_type="text/plain", size=3
        )
        KnowledgeItem.objects.create(
            source=docs, name="two.txt", url=None, path="a/b/two.txt", content_type="text/plain", size=3
        )

        self.assertEqual(2, docs.items.count())


class ArticleTest(TembaTest):
    def create_article(self, source, title: str, *, parent=None, status=Article.STATUS_DRAFT):
        return Article.objects.create(
            source=source,
            parent=parent,
            title=title,
            slug=Article.get_unique_slug(source, title),
            status=status,
            created_by=self.admin,
            modified_by=self.admin,
        )

    def setUp(self):
        super().setUp()

        self.helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)

    def test_get_unique_slug(self):
        self.assertEqual("getting-started", Article.get_unique_slug(self.helpdesk, "Getting Started"))

        article = self.create_article(self.helpdesk, "Getting Started")
        self.assertEqual("getting-started", article.slug)
        self.assertEqual(self.org, article.org)

        # a collision gets a numeric suffix
        self.assertEqual("getting-started-2", Article.get_unique_slug(self.helpdesk, "Getting Started"))

        # unless it's with ourselves
        self.assertEqual("getting-started", Article.get_unique_slug(self.helpdesk, "Getting Started", ignore=article))

        # a title that slugifies to nothing falls back to "article"
        self.assertEqual("article", Article.get_unique_slug(self.helpdesk, "!!!"))

        # long slugs are truncated to make room for a suffix
        long_title = "x" * 255
        self.assertEqual("x" * 255, Article.get_unique_slug(self.helpdesk, long_title))
        self.create_article(self.helpdesk, long_title)
        self.assertEqual("x" * 253 + "-2", Article.get_unique_slug(self.helpdesk, long_title))

        # a released article's slug is free for re-use
        article.release(self.admin)
        self.assertEqual("getting-started", Article.get_unique_slug(self.helpdesk, "Getting Started"))

    def test_unique_slugs(self):
        self.create_article(self.helpdesk, "Getting Started")

        with self.assertRaises(IntegrityError):
            Article.objects.create(
                source=self.helpdesk,
                title="Getting Started",
                slug="getting-started",
                created_by=self.admin,
                modified_by=self.admin,
            )

    def test_create(self):
        article1 = Article.create(self.helpdesk, self.admin, "Getting Started")

        self.assertEqual(self.helpdesk, article1.source)
        self.assertIsNone(article1.parent)
        self.assertEqual(0, article1.sort_order)
        self.assertEqual("getting-started", article1.slug)
        self.assertEqual("", article1.body)
        self.assertEqual("", article1.description)
        self.assertTrue(article1.is_section)  # a root of the tree is a section
        self.assertEqual(Article.STATUS_DRAFT, article1.status)  # new articles are always drafts
        self.assertIsNone(article1.published_on)
        self.assertEqual("eng", article1.language)  # defaults to the workspace's primary flow language

        # new articles go to the end of their level so creating one never reshuffles the tree
        article2 = Article.create(
            self.helpdesk, self.admin, "Flows", body="# Flows", description="All about flows.", language="spa"
        )
        self.assertEqual(1, article2.sort_order)
        self.assertEqual("# Flows", article2.body)
        self.assertEqual("All about flows.", article2.description)
        self.assertEqual("spa", article2.language)

        child = Article.create(self.helpdesk, self.admin, "Nodes", parent=article2)
        self.assertEqual(article2, child.parent)
        self.assertEqual(0, child.sort_order)
        self.assertFalse(child.is_section)

    def test_get_tree(self):
        flows = self.create_article(self.helpdesk, "Flows")
        contacts = self.create_article(self.helpdesk, "Contacts")
        nodes = self.create_article(self.helpdesk, "Nodes", parent=flows)
        edges = self.create_article(self.helpdesk, "Edges", parent=flows)
        deleted = self.create_article(self.helpdesk, "Old", parent=flows)

        Article.objects.filter(id=contacts.id).update(sort_order=1)
        Article.objects.filter(id=nodes.id).update(sort_order=1)
        deleted.release(self.admin)

        tree = Article.get_tree(self.helpdesk)

        # depth first, siblings by sort order then title, and released articles omitted
        self.assertEqual([flows, edges, nodes, contacts], tree)
        self.assertEqual([0, 1, 1, 0], [a.depth for a in tree])
        self.assertEqual([None, flows.uuid, flows.uuid, None], [a.parent_uuid for a in tree])

        # an article stored deeper than the cap allows - data can predate it - renders flattened rather than hidden:
        # as a sibling following its parent, under the deepest ancestor the cap does allow
        grand = self.create_article(self.helpdesk, "Grand", parent=edges)

        tree = Article.get_tree(self.helpdesk)

        self.assertEqual([flows, edges, grand, nodes, contacts], tree)
        self.assertEqual([0, 1, 1, 1, 0], [a.depth for a in tree])
        self.assertEqual([None, flows.uuid, flows.uuid, flows.uuid, None], [a.parent_uuid for a in tree])

        grand.release(self.admin)

        # an article orphaned by its parent going inactive is shown as a root rather than dropped - otherwise it would
        # be invisible here, and so unmovable, while still being indexed if it were published
        Article.objects.filter(id=flows.id).update(is_active=False)

        tree = Article.get_tree(self.helpdesk)

        self.assertEqual([edges, contacts, nodes], tree)
        self.assertEqual([0, 0, 0], [a.depth for a in tree])

        # and shown as a root means shown with no parent, rather than naming one that isn't in the tree
        self.assertEqual([None, None, None], [a.parent_uuid for a in tree])

    def test_apply_sort(self):
        flows = self.create_article(self.helpdesk, "Flows")
        contacts = self.create_article(self.helpdesk, "Contacts")
        nodes = self.create_article(self.helpdesk, "Nodes", parent=flows)
        other = self.create_article(self.org2.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK), "Other")
        modified_on = flows.modified_on

        # sections can be reordered, and an article moved to another section
        Article.apply_sort(
            self.helpdesk,
            [(str(contacts.uuid), None, 0), (str(flows.uuid), None, 1), (str(nodes.uuid), str(contacts.uuid), 0)],
        )

        self.assertEqual([contacts, nodes, flows], Article.get_tree(self.helpdesk))
        self.assertEqual([0, 1, 0], [a.depth for a in Article.get_tree(self.helpdesk)])

        # reordering isn't something mailroom indexes, so it doesn't make articles look stale
        flows.refresh_from_db()
        self.assertEqual(modified_on, flows.modified_on)

        # an article we don't own can't be moved into our tree, or be made a parent in it
        with self.assertRaises(ValueError):
            Article.apply_sort(self.helpdesk, [(str(other.uuid), None, 0)])
        with self.assertRaises(ValueError):
            Article.apply_sort(self.helpdesk, [(str(nodes.uuid), str(other.uuid), 0)])

        # a section can't be made an article, nor an article a section - what each is, is where it sits
        with self.assertRaises(ValueError):
            Article.apply_sort(self.helpdesk, [(str(flows.uuid), str(contacts.uuid), 0)])
        with self.assertRaises(ValueError):
            Article.apply_sort(self.helpdesk, [(str(nodes.uuid), None, 0)])

        # nor can an article be its own ancestor
        with self.assertRaises(ValueError):
            Article.apply_sort(self.helpdesk, [(str(nodes.uuid), str(nodes.uuid), 0)])

        # nesting is allowed up to the cap...
        deep = self.create_article(self.helpdesk, "Deep", parent=flows)
        deeper = self.create_article(self.helpdesk, "Deeper", parent=contacts)
        Article.apply_sort(self.helpdesk, [(str(deep.uuid), str(contacts.uuid), 1)])

        # ...but no further - deep's parent comes from the part of the tree the client didn't mention
        with self.assertRaises(ValueError):
            Article.apply_sort(self.helpdesk, [(str(deeper.uuid), str(deep.uuid), 0)])

        # none of the rejected moves changed anything
        self.assertEqual([contacts, deeper, nodes, deep, flows], Article.get_tree(self.helpdesk))
        self.assertEqual([0, 1, 1, 1, 0], [a.depth for a in Article.get_tree(self.helpdesk)])

    def test_as_html(self):
        article = self.create_article(self.helpdesk, "Getting Started")

        article.body = "# Heading\n\nSome **bold** text with a [link](https://nyaruka.com).\n\n* one\n* two"
        self.assertEqual(
            '<h1 id="heading">Heading</h1>\n<p>Some <strong>bold</strong> text with a <a href="https://nyaruka.com" '
            'rel="noopener noreferrer">link</a>.</p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>',
            article.as_html(),
        )

        # tables and fenced code blocks are rendered
        article.body = "| a | b |\n| - | - |\n| 1 | 2 |"
        self.assertIn("<table>", article.as_html())

        # raw HTML in the source is escaped rather than rendered, the way the editor shows it to the author, and the
        # javascript: URLs markdown will make a link out of are still sanitized away
        article.body = "<script>alert(1)</script><p onclick='x'>hi</p>\n\n[bad](javascript:alert(1))"
        self.assertEqual(
            "<p>&lt;script&gt;alert(1)&lt;/script&gt;&lt;p onclick='x'&gt;hi&lt;/p&gt;</p>\n"
            '<p><a rel="noopener noreferrer">bad</a></p>',
            article.as_html(),
        )

        # so text that only looks like a tag survives instead of being quietly swallowed as an unknown one
        article.body = "Quick replies use `<url>Visit<extra>https://example.com`, and a bare <url> survives too"
        self.assertEqual(
            "<p>Quick replies use <code>&lt;url&gt;Visit&lt;extra&gt;https://example.com</code>, "
            "and a bare &lt;url&gt; survives too</p>",
            article.as_html(),
        )

        # images survive, since screenshots are the point of them
        article.body = "![shot](https://example.com/shot.png)"
        self.assertEqual('<p><img alt="shot" src="https://example.com/shot.png"></p>', article.as_html())

        # an uploaded image is referenced by its storage key, which is resolved to where storage serves it from only
        # as the article is rendered - the fragment riding along
        article.body = "![shot](orgs/1/knowledge/shot.png#size=small) ![abs](/local/shot.png)"
        self.assertEqual(
            f'<p><img alt="shot" class="size-small" src="{public_file_storage.url("orgs/1/knowledge/shot.png")}#size=small"> '
            '<img alt="abs" src="/local/shot.png"></p>',
            article.as_html(),
        )

        # the size and layout an image was given ride the fragment of its URL and come out as classes on the <img>,
        # with the src untouched - fragment and all
        for fragment, classes in (
            ("#size=small", "size-small"),
            ("#size=medium", "size-medium"),
            ("#size=large", "size-large"),
            ("#layout=block", "layout-block"),
            ("#layout=inline", "layout-inline"),
            ("#size=small&layout=inline", "size-small layout-inline"),
            ("#size=large&layout=block", "size-large layout-block"),
        ):
            article.body = f"![shot](https://example.com/shot.png{fragment})"
            src = f"https://example.com/shot.png{fragment}".replace("&", "&amp;")
            self.assertEqual(
                f'<p><img alt="shot" class="{classes}" src="{src}"></p>', article.as_html(), f"for fragment {fragment}"
            )

        # a size or layout we don't have is ignored rather than guessed at, as is a fragment that isn't ours at all
        for fragment in ("#size=huge", "#layout=diagonal", "#section-2", "#size=small=small"):
            article.body = f"![shot](https://example.com/shot.png{fragment})"
            self.assertEqual(
                f'<p><img alt="shot" src="https://example.com/shot.png{fragment}"></p>',
                article.as_html(),
                f"for fragment {fragment}",
            )

    def test_render_headings(self):
        article = self.create_article(self.helpdesk, "Getting Started")

        # every heading is anchored by an id made from its text, and the top level ones are listed alongside the HTML
        # in the order they appear, as plain text
        article.body = (
            "Intro.\n\n# Setting *up* & running\n\nText.\n\n## Details\n\n# Configuración\n\n"
            "### Deep\n\n# 中文\n\n# ???\n\n# Setting up & running\n\n[TOC]"
        )
        html, headings = article.render()
        self.assertEqual(
            '<p>Intro.</p>\n<h1 id="setting-up-running">Setting <em>up</em> &amp; running</h1>\n<p>Text.</p>\n'
            '<h2 id="details">Details</h2>\n<h1 id="configuración">Configuración</h1>\n<h3 id="deep">Deep</h3>\n'
            '<h1 id="中文">中文</h1>\n<h1 id="section">???</h1>\n<h1 id="setting-up-running_1">Setting up &amp; running</h1>\n'
            "<p>[TOC]</p>",
            html,
        )
        self.assertEqual(
            [
                ("setting-up-running", "Setting up & running"),
                ("configuración", "Configuración"),
                ("中文", "中文"),
                ("section", "???"),
                ("setting-up-running_1", "Setting up & running"),
            ],
            headings,
        )

        # an article with no top level headings has nothing to list
        article.body = "Just text.\n\n## A subheading"
        self.assertEqual(('<p>Just text.</p>\n<h2 id="a-subheading">A subheading</h2>', []), article.render())

    def test_as_html_cell_breaks(self):
        article = self.create_article(self.helpdesk, "Getting Started")

        # a cell is one line of markdown - a real newline would end its row - so the editor writes the breaks inside
        # one as literal <br> text, and rendering turns them back into the breaks they mean. A break can sit inside a
        # cell's emphasis or link as easily as in the cell itself, and follow one as easily as open it.
        article.body = (
            "| Step | Detail |\n| - | - |\n"
            "| **One<br>Two** | plain<br>break |\n"
            "| [a<br/>b](https://x.com) tail<BR>end | x |"
        )
        self.assertEqual(
            "<table>\n<thead>\n<tr>\n<th>Step</th>\n<th>Detail</th>\n</tr>\n</thead>\n<tbody>\n"
            "<tr>\n<td><strong>One<br>Two</strong></td>\n<td>plain<br>break</td>\n</tr>\n"
            '<tr>\n<td><a href="https://x.com" rel="noopener noreferrer">a<br>b</a> tail<br>end</td>\n'
            "<td>x</td>\n</tr>\n</tbody>\n</table>",
            article.as_html(),
        )

        # cells only - everywhere else text that merely looks like a tag stays text
        article.body = "one<br>two"
        self.assertEqual("<p>one&lt;br&gt;two</p>", article.as_html())

    def test_as_html_columns(self):
        article = self.create_article(self.helpdesk, "Getting Started")

        # a helpdesk starts with no palette at all
        self.assertEqual({}, self.helpdesk.colors)

        self.helpdesk.set_colors({"1": "#ffe8a3", "2": "#123456"})

        self.helpdesk.refresh_from_db()
        self.assertEqual({"1": "#ffe8a3", "2": "#123456"}, self.helpdesk.colors)

        # the stylesheets in a layout table's header cells are realized as a colgroup, leaving the header genuinely
        # empty: widths and palette fills belong to the columns, while what a colgroup can't reach - padding, text
        # drawn from the column's own fill, a border drawn from it - goes on the cells. Alignment stays where the
        # renderer put it, and a sized column only holds its size in a fixed layout.
        article.body = (
            "| width: 40%; padding: 8px | background: 1; border: solid | background: 2; border: solid |\n"
            "| - | :-: | - |\n"
            "| one | two | three |"
        )
        self.assertEqual(
            '<table style="table-layout: fixed; width: 100%">\n'
            '<colgroup><col style="width: 40%"><col style="background: #ffe8a3">'
            '<col style="background: #123456"></colgroup>'
            '<thead>\n<tr>\n<th></th>\n<th style="text-align: center"></th>\n<th></th>\n</tr>\n</thead>\n'
            '<tbody>\n<tr>\n<td style="padding: 8px">one</td>\n'
            '<td style="text-align: center; color: #6b581f; border: 1px solid #d4be7d">two</td>\n'
            '<td style="color: #edf2f8; border: 1px solid #07101a">three</td>\n</tr>\n</tbody>\n</table>',
            article.as_html(),
        )

        # the article embeds the palette index, so recoloring the entry restyles its every use - text and border
        # included, since both are drawn from the fill
        article.body = "| background: 1 |\n| - |\n| one |"
        self.assertEqual(
            '<table>\n<colgroup><col style="background: #ffe8a3"></colgroup>'
            "<thead>\n<tr>\n<th></th>\n</tr>\n</thead>\n"
            '<tbody>\n<tr>\n<td style="color: #6b581f">one</td>\n</tr>\n</tbody>\n</table>',
            article.as_html(),
        )

        self.helpdesk.set_colors({"1": "#fc0"})

        # short palette hexes resolve the same way, and a light fill takes deep text where a dark one takes pale
        self.assertEqual(
            '<table>\n<colgroup><col style="background: #fc0"></colgroup>'
            "<thead>\n<tr>\n<th></th>\n</tr>\n</thead>\n"
            '<tbody>\n<tr>\n<td style="color: #f8f6ed">one</td>\n</tr>\n</tbody>\n</table>',
            article.as_html(),
        )

        # an index the palette no longer answers for paints nothing, while the rest of the stylesheet still holds
        article.body = "| background: 9 | width: 10px |\n| - | - |\n| one | two |"
        self.assertEqual(
            '<table style="table-layout: fixed; width: 100%">\n'
            '<colgroup><col><col style="width: 10px"></colgroup>'
            "<thead>\n<tr>\n<th></th>\n<th></th>\n</tr>\n</thead>\n"
            "<tbody>\n<tr>\n<td>one</td>\n<td>two</td>\n</tr>\n</tbody>\n</table>",
            article.as_html(),
        )

        # a border with no fill to draw from takes a plain neutral
        article.body = "| border: solid | padding: 12px |\n| - | - |\n| one | two |"

        # and columns that ask for nothing a column can carry get no colgroup and no fixed layout
        self.assertEqual(
            "<table>\n<thead>\n<tr>\n<th></th>\n<th></th>\n</tr>\n</thead>\n"
            '<tbody>\n<tr>\n<td style="border: 1px solid #d0d5dd">one</td>\n'
            '<td style="padding: 12px">two</td>\n</tr>\n</tbody>\n</table>',
            article.as_html(),
        )

        # every header cell has to be empty or read as a stylesheet - a value we don't allow, text that isn't a
        # stylesheet at all, or markup however its text reads, and the table is left exactly as written
        for header in ("| width: 40 | background: 1 |", "| Step | background: 1 |", "| **width: 40%** | width: 10px |"):
            article.body = f"{header}\n| - | - |\n| one | two |"
            self.assertNotIn("<colgroup>", article.as_html(), f"for header {header}")
            self.assertNotIn("style", article.as_html(), f"for header {header}")

    def test_parse_column_style(self):
        self.assertEqual({}, parse_column_style(""))
        self.assertEqual({"width": "40%"}, parse_column_style("width: 40%"))
        self.assertEqual({"width": "300px", "background": "3"}, parse_column_style("width: 300px; background: 3"))
        self.assertEqual({"padding": "8px", "border": "solid"}, parse_column_style("padding: 8px; border: solid"))

        # the editor's own trailing separator leaves an empty declaration, which is nothing rather than a mistake
        self.assertEqual({"width": "40%"}, parse_column_style("width: 40%; "))

        # a stylesheet is CSS-ish, so it reads like CSS does
        self.assertEqual({"background": "2"}, parse_column_style("BACKGROUND:2"))

        # a declaration we don't know, or a value we don't allow, means the cell isn't a stylesheet at all - better a
        # header that shows what was written than a table half understood
        for text in (
            "Step",
            "width",
            "color: red",
            "width: 40",
            "width: 40em",
            "background: red",
            "background: 1.5",
            "padding: 8",
            "padding: 2em",
            "border: dashed",
        ):
            self.assertIsNone(parse_column_style(text), f"for {text}")

    def test_column_styles_processor(self):
        # markdown hands the processor only tables it built itself, which always have a header row and only ever put
        # alignment on a cell - so what it does with a table that has neither is exercised directly
        root = Element("div")
        headless = SubElement(root, "table")
        td1 = SubElement(SubElement(SubElement(headless, "tbody"), "tr"), "td")
        td1.set("style", "color: red")

        styled = SubElement(root, "table")
        SubElement(SubElement(SubElement(styled, "thead"), "tr"), "th").text = "width: 40%"
        td2 = SubElement(SubElement(SubElement(styled, "tbody"), "tr"), "td")
        td2.set("style", "color: red")

        ColumnStylesProcessor(None, {}).run(root)

        # a table with no header carries no stylesheet, so it's left exactly as it was
        self.assertEqual("color: red", td1.get("style"))

        # but one that does owns its cells' styling, so anything else there goes
        self.assertIsNone(td2.get("style"))

    def test_sanitize_attribute(self):
        # the sanitizer only lets the size/layout classes through on an image, and nothing above it in the rendering
        # can put any other class there - so exercised directly, as the defense in depth it is
        self.assertEqual("size-small layout-inline", _sanitize_attribute("img", "class", "size-small layout-inline"))
        self.assertEqual("size-small", _sanitize_attribute("img", "class", "size-small sneaky"))
        self.assertIsNone(_sanitize_attribute("img", "class", "sneaky"))
        self.assertEqual("https://x.com", _sanitize_attribute("a", "href", "https://x.com"))

        # and a table, col or cell style only carries what our own pipeline writes
        self.assertEqual(
            "width: 40%; background: #ffe8a3", _sanitize_attribute("col", "style", "width: 40%; background: #ffe8a3")
        )
        self.assertEqual("width: 40%", _sanitize_attribute("col", "style", "width: 40%; position: fixed"))
        self.assertIsNone(_sanitize_attribute("col", "style", "background: url(x)"))

        self.assertEqual(
            "table-layout: fixed; width: 100%",
            _sanitize_attribute("table", "style", "table-layout: fixed; width: 100%"),
        )
        self.assertIsNone(_sanitize_attribute("table", "style", "position: fixed"))

        cell_style = "text-align: left; padding: 8px; color: #6b581f; border: 1px solid #d0d5dd"
        self.assertEqual(cell_style, _sanitize_attribute("td", "style", cell_style))
        self.assertEqual("text-align: center", _sanitize_attribute("th", "style", "text-align: center; width: 40%"))
        self.assertIsNone(_sanitize_attribute("td", "style", "position: fixed"))

    def test_publishing(self):
        article = self.create_article(self.helpdesk, "Getting Started")
        modified_on = article.modified_on

        article.publish(self.editor)

        article.refresh_from_db()
        self.assertEqual(Article.STATUS_PUBLISHED, article.status)
        self.assertIsNotNone(article.published_on)
        self.assertEqual(self.editor, article.modified_by)
        self.assertGreater(article.modified_on, modified_on)

        modified_on = article.modified_on
        article.unpublish(self.admin)

        # modified_on bumps so mailroom's sweep sees the source as stale and drops the chunks
        article.refresh_from_db()
        self.assertEqual(Article.STATUS_DRAFT, article.status)
        self.assertIsNone(article.published_on)
        self.assertGreater(article.modified_on, modified_on)

    @cleanup(s3=True)
    def test_release(self):
        section = self.create_article(self.helpdesk, "Flows", status=Article.STATUS_PUBLISHED)
        article = self.create_article(self.helpdesk, "Nodes", parent=section, status=Article.STATUS_PUBLISHED)
        modified_on = article.modified_on

        path = public_file_storage.save(
            get_article_image_path(article, uuid4(), "image/png"), SimpleUploadedFile("shot.png", b"png")
        )
        ArticleImage.objects.create(
            article=article, name="shot.png", path=path, content_type="image/png", size=3, created_by=self.admin
        )

        # a section with articles in it can't go - they'd be left as sections themselves
        with self.assertRaises(AssertionError):
            section.release(self.admin)

        section.refresh_from_db()
        self.assertTrue(section.is_active)

        article.release(self.admin)

        # soft deleted, back to draft, and modified_on bumped so mailroom's sweep sees the tombstone
        article.refresh_from_db()
        self.assertFalse(article.is_active)
        self.assertEqual(Article.STATUS_DRAFT, article.status)
        self.assertIsNone(article.published_on)
        self.assertGreater(article.modified_on, modified_on)

        # and its images are gone for good - rows first, then the storage objects
        self.assertEqual(0, ArticleImage.objects.count())
        self.assertFalse(public_file_storage.exists(path))

        # emptied, the section can go too
        section.release(self.admin)
        section.refresh_from_db()
        self.assertFalse(section.is_active)


class ArticleImageTest(TembaTest):
    @cleanup(s3=True)
    def test_from_upload(self):
        helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)
        article = Article.create(helpdesk, self.admin, "Getting Started")

        image = ArticleImage.from_upload(
            article, self.admin, SimpleUploadedFile("Screen Shot!.PNG", b"png", content_type="image/png")
        )

        self.assertEqual(article, image.article)
        self.assertEqual("Screen Shot.PNG", image.name)  # cleaned
        self.assertEqual(
            f"orgs/{self.org.id}/knowledge/{helpdesk.uuid}/articles/{article.uuid}/{image.uuid}.png", image.path
        )
        self.assertEqual("image/png", image.content_type)
        self.assertEqual(3, image.size)
        self.assertTrue(public_file_storage.exists(image.path))

        # the stored key's extension comes from the sniffed type, never the uploaded name - these live in a public
        # bucket which serves an object as whatever its extension implies, so a .html name would be served as HTML
        image = ArticleImage.from_upload(
            article, self.admin, SimpleUploadedFile("evil.html", b"png", content_type="image/png")
        )

        self.assertEqual("evil.html", image.name)
        self.assertTrue(image.path.endswith(f"{image.uuid}.png"))

    @cleanup(s3=True)
    def test_delete(self):
        helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)
        article = Article.objects.create(
            source=helpdesk,
            title="Getting Started",
            slug="getting-started",
            created_by=self.admin,
            modified_by=self.admin,
        )

        image_uuid = uuid4()
        path = public_file_storage.save(
            get_article_image_path(article, image_uuid, "image/png"), SimpleUploadedFile("shot1.png", b"png")
        )
        self.assertEqual(f"orgs/{self.org.id}/knowledge/{helpdesk.uuid}/articles/{article.uuid}/{image_uuid}.png", path)
        image = ArticleImage.objects.create(
            article=article, name="shot1.png", path=path, content_type="image/png", size=3, created_by=self.admin
        )

        self.assertEqual(public_file_storage.url(path), image.url)

        image.delete()

        self.assertEqual(0, ArticleImage.objects.count())
        self.assertFalse(public_file_storage.exists(path))
