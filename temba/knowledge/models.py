import colorsys
import hashlib
import logging
import mimetypes
import os
import re
from collections import defaultdict
from datetime import timedelta
from html import unescape
from pathlib import Path
from typing import NamedTuple
from urllib.parse import parse_qs
from xml.etree.ElementTree import Element, SubElement

import dns.exception
import dns.resolver
import markdown
import nh3
from markdown.extensions import Extension
from markdown.extensions.toc import TocExtension, slugify_unicode
from markdown.treeprocessors import Treeprocessor
from pgvector.django import HnswIndex, VectorField

from django.conf import settings
from django.contrib.postgres.indexes import OpClass
from django.contrib.postgres.search import SearchQuery, SearchRank, SearchVector
from django.core.cache import cache
from django.core.files.storage import default_storage
from django.db import models, transaction
from django.db.models import Q, Sum
from django.db.models.functions import Lower
from django.http.request import split_domain_port
from django.utils import timezone
from django.utils.html import escape
from django.utils.safestring import mark_safe
from django.utils.text import slugify
from django.utils.translation import gettext_lazy as _

from temba import mailroom
from temba.mailroom.client.exceptions import RequestException
from temba.orgs.models import Org
from temba.utils import on_transaction_commit
from temba.utils.models import TembaModel, delete_in_batches
from temba.utils.models.counts import BaseDailyCount
from temba.utils.s3 import public_file_storage
from temba.utils.text import generate_secret
from temba.utils.uuid import uuid4

logger = logging.getLogger(__name__)


class EscapeRawHTML(Extension):
    """
    Renders raw HTML in the source as visible text instead of markup. The library has no option for this, so the
    documented way to get it is to unregister the two things that recognize HTML in the first place.
    """

    def extendMarkdown(self, md):
        md.preprocessors.deregister("html_block")
        md.inlinePatterns.deregister("html")


# the size and layout an image can be given, carried in the fragment of its URL as #size=small&layout=inline - in the
# markdown itself, so it survives any renderer. Each size is a single pixel cap (small=200, medium=400, large=640)
# that renderers apply as both max-width and max-height, bounding the long axis of any aspect ratio; no fragment means
# full size as a block, which is how markdown renders an image anyway.
IMAGE_SIZES = ("small", "medium", "large")
IMAGE_LAYOUTS = ("block", "inline")
IMAGE_CLASSES = {f"size-{s}" for s in IMAGE_SIZES} | {f"layout-{layout}" for layout in IMAGE_LAYOUTS}


# An uploaded image is referenced by its key in public storage - orgs/1/knowledge/.../shot.png - rather than by the
# address storage is served from, so an article holds nothing that storage moving would break. The address is put
# back only for a page: rendered HTML kept for serving carries the key under the storage: scheme instead, for
# whatever serves it to resolve.
RELATIVE_IMAGE = re.compile(r"^(?![a-z][a-z0-9+.-]*:)(?![/#])", re.IGNORECASE)
IMAGE_STORAGE_SCHEME = "storage:"


def resolve_image(reference: str) -> str:
    """
    The address an image reference is served from, when it's a storage key; anything with an address of its own is
    left alone. A size fragment rides along.
    """
    if not RELATIVE_IMAGE.match(reference):
        return reference
    key, hash_, fragment = reference.partition("#")
    return public_file_storage.url(key) + hash_ + fragment


def reference_image(reference: str) -> str:
    """
    The form an image reference is kept in rendered HTML: a storage key under the storage: scheme, fragment and all,
    and anything with an address of its own as it is.
    """
    return IMAGE_STORAGE_SCHEME + reference if RELATIVE_IMAGE.match(reference) else reference


class AnnotateImages(Extension):
    """
    Surfaces the size/layout fragment of each image's URL as classes on its <img> - size-small, layout-inline etc -
    for CSS to act on - and resolves a reference to an uploaded image to where storage serves it from, or when not
    resolving, keeps it as a storage: reference. The fragment
    is left on the src; a fragment on an <img> is harmless, and stripping it would make the served HTML lie about the
    markdown it came from.
    """

    def __init__(self, resolve: bool = True):
        super().__init__()
        self.resolve = resolve

    def extendMarkdown(self, md):
        md.treeprocessors.register(AnnotateImagesProcessor(md, self.resolve), "annotate_images", 5)


class AnnotateImagesProcessor(Treeprocessor):
    def __init__(self, md, resolve: bool):
        super().__init__(md)
        self.resolve = resolve

    def run(self, root):
        for img in root.iter("img"):
            reference = img.get("src", "")
            img.set("src", resolve_image(reference) if self.resolve else reference_image(reference))
            params = parse_qs(img.get("src", "").partition("#")[2])

            classes = []
            for key, allowed in (("size", IMAGE_SIZES), ("layout", IMAGE_LAYOUTS)):
                value = params.get(key, [""])[0]
                if value in allowed:
                    classes.append(f"{key}-{value}")

            if classes:
                img.set("class", " ".join(classes))


# a cell is one line of markdown - a real newline would end its row - so the editor writes line breaks inside cells
# as literal <br> text, and rendering turns them back into the breaks they mean
CELL_BREAK = re.compile(r"<br\s*/?>", re.IGNORECASE)


class CellBreaks(Extension):
    """
    Turns the literal <br>s inside table cells into the line breaks they mean. Raw HTML is escaped rather than parsed,
    so they arrive as text; a cell is one line of markdown and <br> is the only way it can carry a break. Cells only -
    everywhere else text that merely looks like a tag stays text.
    """

    def extendMarkdown(self, md):
        md.treeprocessors.register(CellBreaksProcessor(md), "cell_breaks", 5)


class CellBreaksProcessor(Treeprocessor):
    def run(self, root):
        for tag in ("th", "td"):
            for cell in root.iter(tag):
                self._reveal(cell)

    def _reveal(self, element):
        # a break can sit inside a cell's emphasis or link as easily as in the cell itself
        for child in list(element):
            self._reveal(child)

        if element.text and CELL_BREAK.search(element.text):
            parts = CELL_BREAK.split(element.text)
            element.text = parts[0]
            for at, part in enumerate(parts[1:]):
                br = Element("br")
                br.tail = part
                element.insert(at, br)

        for child in list(element):
            if child.tail and CELL_BREAK.search(child.tail):
                parts = CELL_BREAK.split(child.tail)
                child.tail = parts[0]
                at = list(element).index(child) + 1
                for offset, part in enumerate(parts[1:]):
                    br = Element("br")
                    br.tail = part
                    element.insert(at + offset, br)


# The column stylesheet a layout table's header cells can carry - `width: 40%; background: 2` in otherwise empty
# header cells, put there by the editor. Riding in the markdown itself, it survives any renderer; one that doesn't
# understand it just shows it as header text. A background is an index into the org's shared palette rather than a
# color: the article embeds the choice, the palette says what the choice currently looks like - so recoloring a
# palette entry restyles its every use, and an index the palette no longer answers for paints nothing.
COLUMN_DECLARATION = re.compile(r"^(width|background|padding|border)\s*:\s*(\S+)$", re.IGNORECASE)
COLUMN_WIDTH = re.compile(r"^\d+(px|%)$")
COLUMN_BACKGROUND = re.compile(r"^\d+$")
COLUMN_PADDING = re.compile(r"^\d+px$")


def parse_column_style(text: str) -> dict | None:
    """
    Reads a header cell's stylesheet, or returns None when its text isn't one.
    """
    out = {}
    for piece in text.split(";"):
        declaration = piece.strip()
        if not declaration:
            continue
        match = COLUMN_DECLARATION.match(declaration)
        if not match:
            return None
        key, value = match[1].lower(), match[2].lower()
        if key == "width" and not COLUMN_WIDTH.match(value):
            return None
        if key == "background" and not COLUMN_BACKGROUND.match(value):
            return None
        if key == "padding" and not COLUMN_PADDING.match(value):
            return None
        if key == "border" and value != "solid":
            return None
        out[key] = value
    return out


def _hex_to_hls(color: str) -> tuple:
    value = color.lstrip("#")
    if len(value) in (3, 4):
        value = "".join(c * 2 for c in value[:3])
    r, g, b = (int(value[i : i + 2], 16) / 255 for i in (0, 2, 4))
    return colorsys.rgb_to_hls(r, g, b)


def _hls_to_hex(h: float, l: float, s: float) -> str:
    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def text_on(background: str) -> str:
    """
    A readable text color drawn from a cell's own background: a deep shade of the same hue over a light fill, a
    pale one over a dark fill. Derived the same way the editor derives it, so author and reader see the same text.
    """
    h, l, s = _hex_to_hls(background)
    if l > 0.55:
        s, l = min(s, 0.55), 0.27
    else:
        s, l = min(s, 0.45), 0.95
    return _hls_to_hex(h, l, s)


def border_on(background: str) -> str:
    """
    The border a column can ask for, drawn from its own fill the same way its text is - the same hue, stepped a
    fixed distance from the fill's own lightness so it reads against any fill: gently darker over a light one,
    deeper still over a dark one, so a dark block sits inside a darker edge. A border with no fill to draw from is
    the stylesheet's own neutral.
    """
    h, l, s = _hex_to_hls(background)
    if l > 0.55:
        s, l = min(s, 0.5), max(l - 0.16, 0.1)
    else:
        s, l = min(s, 0.6), max(l - 0.14, 0.05)
    return _hls_to_hex(h, l, s)


class ColumnStyles(Extension):
    """
    Realizes the column stylesheets in a layout table's header cells as a colgroup, leaving the header genuinely
    empty. Every header cell has to be empty or read as a stylesheet; any real header text leaves the table alone.
    A background stays the palette index it is, as a bubble-<index> class on the column and its cells, and the page
    says what each index currently looks like - so a palette change restyles every article without rendering any.
    """

    def extendMarkdown(self, md):
        md.treeprocessors.register(ColumnStylesProcessor(md), "column_styles", 4)


class ColumnStylesProcessor(Treeprocessor):
    def run(self, root):
        for table in root.iter("table"):
            self._decorate(table)

    def _decorate(self, table):
        thead = table.find("thead")
        head = thead.findall(".//th") if thead is not None else []
        if not head:
            return

        styles = []
        for th in head:
            # a header cell with markup in it is real content, however its text reads
            parsed = parse_column_style((th.text or "").strip()) if len(th) == 0 else None
            if parsed is None:
                return
            styles.append(parsed)

        for th in head:
            th.text = ""

        bubbles = [f"bubble-{style['background']}" if style.get("background") else None for style in styles]

        if any(style.get("width") for style in styles) or any(bubbles):
            colgroup = Element("colgroup")
            for style, bubble in zip(styles, bubbles):
                col = SubElement(colgroup, "col")
                if style.get("width"):
                    col.set("style", f"width: {style['width']}")
                if bubble:
                    col.set("class", bubble)
            table.insert(0, colgroup)

        # a sized column only holds its size in a fixed layout, where the unsized columns share what's left
        if any(style.get("width") for style in styles):
            table.set("style", "table-layout: fixed; width: 100%")

        # what belongs to the cells themselves: padding, and the column's bubble, since a colgroup can paint a
        # background but can't reach the text over it or a cell's border. Any alignment the renderer put on a cell
        # stays.
        tbody = table.find("tbody")
        for tr in tbody.findall("tr") if tbody is not None else []:
            for index, td in enumerate(tr.findall("td")):
                style = styles[index] if index < len(styles) else {}
                bubble = bubbles[index] if index < len(bubbles) else None
                parts = []
                align = re.search(r"text-align:\s*(left|center|right)", td.get("style") or "")
                if align:
                    parts.append(f"text-align: {align[1]}")
                if style.get("padding"):
                    parts.append(f"padding: {style['padding']}")
                if parts:
                    td.set("style", "; ".join(parts))
                elif td.get("style"):
                    del td.attrib["style"]

                classes = [c for c in (bubble, "bordered" if style.get("border") else None) if c]
                if classes:
                    td.set("class", " ".join(classes))


def derive_color_styles(colors: dict) -> dict:
    """
    What each palette entry looks like on a page - the fill, and the text and border drawn from it - by its index.
    """
    return {key: {"fill": color, "text": text_on(color), "border": border_on(color)} for key, color in colors.items()}


# How one article links to another: [text](article:<uuid>), the target's uuid rather than its address - so the link
# holds through any retitling or refiling of either article, and is resolved to the target's current address only as
# the page is served. Riding in the markdown itself, it survives any renderer; the editor shows it as it is.
ARTICLE_LINK_SCHEME = "article:"
ARTICLE_LINK = re.compile(r"^article:([0-9a-f-]{36})$", re.IGNORECASE)


class ArticleLinks(Extension):
    """
    Links to other articles, authored as article:<uuid> - by uuid rather than by address, so a retitled or refiled
    article keeps every link to it. Given a map of uuid to address they're resolved against it, and one to an article
    that isn't in the map - unpublished, deleted, or never there - is left as its text, since there's nowhere for it to
    go. Without a map they're kept as article: links, normalized, for whatever serves the page to resolve as it does.
    """

    def __init__(self, links: dict = None):
        super().__init__()
        self.links = links

    def extendMarkdown(self, md):
        md.treeprocessors.register(ArticleLinksProcessor(md, self.links), "article_links", 4)


class ArticleLinksProcessor(Treeprocessor):
    def __init__(self, md, links: dict | None):
        super().__init__(md)
        self.links = links

    def run(self, root):
        for anchor in root.iter("a"):
            match = ARTICLE_LINK.match(anchor.get("href") or "")
            if not match:
                continue
            uuid = match[1].lower()
            if self.links is None:
                anchor.set("href", f"article:{uuid}")
            elif target := self.links.get(uuid):
                anchor.set("href", target)
            else:
                anchor.tag = "span"
                del anchor.attrib["href"]


# what an unresolved link to another article is emitted as - exactly this, so that whatever resolves them as it
# serves the page has one form to look for - so the rel the sanitizer puts on every link comes off these
ARTICLE_LINK_HTML = re.compile(r'<a href="(article:[0-9a-f-]{36})" rel="noopener noreferrer">')

# and the URL schemes those links and kept image references carry, which the sanitizer would otherwise strip
SANITIZE_URL_SCHEMES = nh3.ALLOWED_URL_SCHEMES | {"article", "storage"}


# markdown extensions we render article bodies with. Deliberately conservative - no extension that would make markdown
# itself more expressive than what the editor can round-trip.
MARKDOWN_EXTENSIONS = ("fenced_code", "tables", "sane_lists")

HEADING_TAGS = ("h1", "h2", "h3", "h4", "h5", "h6")

# what a heading's id may be: what heading_id makes, with the _1, _2 the toc extension appends to keep them unique
HEADING_ID = re.compile(r"^[\w-]+$")


class Heading(NamedTuple):
    """
    A top level heading of an article, as its page lists them - the id its element carries, and its text.
    """

    id: str
    text: str


def heading_id(text: str, separator: str) -> str:
    """
    The id a heading gets from its text - the text slugified, keeping its letters whatever the language, or "section"
    for a heading with no letters in it at all so the id still says what it anchors.
    """
    return slugify_unicode(text, separator) or "section"


# nh3's default attribute allowances plus class on images (where AnnotateImages puts one), style on tables and their
# cells and cols (where ColumnStyles and the tables extension put what they realize) and id on headings (where the
# toc extension puts one for the page to link to)
SANITIZE_ATTRIBUTES = {
    **nh3.ALLOWED_ATTRIBUTES,
    **{tag: {"id"} for tag in HEADING_TAGS},
    "img": nh3.ALLOWED_ATTRIBUTES["img"] | {"class"},
    "col": nh3.ALLOWED_ATTRIBUTES.get("col", set()) | {"style", "class"},
    "table": nh3.ALLOWED_ATTRIBUTES.get("table", set()) | {"style"},
    "td": nh3.ALLOWED_ATTRIBUTES.get("td", set()) | {"style", "class"},
    "th": nh3.ALLOWED_ATTRIBUTES.get("th", set()) | {"style"},
}

# the only declarations a cell's style may carry: the alignment the tables extension writes, and the padding
# ColumnStyles writes
CELL_DECLARATION = re.compile(r"^(text-align:\s*(left|center|right)|padding:\s*\d+px)$", re.IGNORECASE)

# and the only one a col's may: the width straight from the stylesheet
COL_DECLARATION = re.compile(r"^width:\s*\d+(px|%)$", re.IGNORECASE)

# the classes ColumnStyles puts on a col or cell: its palette index, and on a cell whether it has a border
BUBBLE_CLASS = re.compile(r"^bubble-\d+$")


def _sanitize_attribute(element: str, attribute: str, value: str) -> str | None:
    """
    Tightens what SANITIZE_ATTRIBUTES lets through: an image's class may only carry the classes AnnotateImages
    emits, a table, col or cell style or class only what our own pipeline writes, and a heading's id only what
    heading_id makes. Nothing else can put those attributes there, so like the sanitizing itself this is defense in
    depth.
    """
    if element in HEADING_TAGS and attribute == "id":
        return value if HEADING_ID.match(value) else None
    if element == "img" and attribute == "class":
        kept = [c for c in value.split() if c in IMAGE_CLASSES]
        return " ".join(kept) if kept else None
    if element == "col" and attribute == "style":
        kept = [d.strip() for d in value.split(";") if d.strip() and COL_DECLARATION.match(d.strip())]
        return "; ".join(kept) if kept else None
    if element in ("col", "td") and attribute == "class":
        kept = [c for c in value.split() if BUBBLE_CLASS.match(c) or (element == "td" and c == "bordered")]
        return " ".join(kept) if kept else None
    if element == "table" and attribute == "style":
        return value if value == "table-layout: fixed; width: 100%" else None
    if element in ("td", "th") and attribute == "style":
        kept = [d.strip() for d in value.split(";") if d.strip() and CELL_DECLARATION.match(d.strip())]
        return "; ".join(kept) if kept else None
    return value


def render_markdown(body: str, links: dict = None) -> tuple[str, list[Heading]]:
    """
    Renders authored markdown. Given a map of article uuid to address it's rendered for a page, with links to other
    articles resolved against the map and uploaded images against storage. Without one it's rendered to be kept for
    whatever serves it, and holds no address or color at all: links stay article:<uuid>, images storage:<key>, and
    column colors palette indexes. Raw HTML is escaped rather than passed through, so that a reader sees what the
    author saw - the editor renders client side and escapes it too, and text that merely looks like a tag (the `<url>`
    of our own quick reply syntax, say) survives instead of being quietly swallowed. Sanitizing stays as defense in
    depth, and still deals with the javascript: URLs markdown will happily make a link out of.

    Every heading gets an id made from its text, so a page can link to it, and the top level ones come back
    alongside the HTML in the order they appear, for the page to list them.
    """
    md = markdown.Markdown(
        extensions=[
            *MARKDOWN_EXTENSIONS,
            EscapeRawHTML(),
            AnnotateImages(resolve=links is not None),
            CellBreaks(),
            ColumnStyles(),
            ArticleLinks(links),
            TocExtension(marker="", toc_depth=1, slugify=heading_id),  # no marker, so [TOC] in an article is just text
        ]
    )
    html = nh3.clean(
        md.convert(body),
        attributes=SANITIZE_ATTRIBUTES,
        attribute_filter=_sanitize_attribute,
        url_schemes=SANITIZE_URL_SCHEMES,
    )
    html = ARTICLE_LINK_HTML.sub(r'<a href="\1">', html)

    # the extension's names are HTML with the tags stripped, so their entities are still encoded
    headings = [Heading(token["id"], unescape(token["name"])) for token in md.toc_tokens]
    return html, headings


# what to strip from markdown to read an article as plain text - for excerpts and search snippets, where the markup
# would only get in the way. Order matters: images before links, since an image is a link with a bang in front.
PLAIN_TEXT_RULES = (
    (re.compile(r"```.*?```", re.DOTALL), " "),  # fenced code
    (re.compile(r"!\[[^\]]*\]\([^)]*\)"), " "),  # images
    (re.compile(r"\[([^\]]*)\]\([^)]*\)"), r"\1"),  # links keep their text
    (re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE), ""),  # heading markers
    (re.compile(r"^\s{0,3}>\s?", re.MULTILINE), ""),  # blockquote markers
    (re.compile(r"^\s*([-*+]|\d+\.)\s+", re.MULTILINE), ""),  # list markers
    (re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$", re.MULTILINE), " "),  # table separators
    (re.compile(r"\b(width|background|padding|border)\s*:\s*[^|;\n]*;?", re.IGNORECASE), " "),  # column styles
    (re.compile(r"<br\s*/?>", re.IGNORECASE), " "),  # cell line breaks
    (re.compile(r"[*_`~]"), ""),  # emphasis and code markers
    (re.compile(r"\|"), " "),  # table pipes
    (re.compile(r"\s+"), " "),
)


def to_plain_text(body: str) -> str:
    """
    Reads authored markdown as plain text - what an excerpt or a search snippet shows of an article.
    """
    text = body
    for pattern, replacement in PLAIN_TEXT_RULES:
        text = pattern.sub(replacement, text)
    return text.strip()


def make_snippet(text: str, terms: list, *, length: int = 200) -> str:
    """
    A window of plain text around the first of the given terms it contains - or its start, when it contains none -
    with the terms marked up. Returned as HTML that's safe to render: the text is escaped and only our own <mark>s are
    markup.
    """
    lowered = text.lower()
    terms = [t.lower() for t in terms if t]
    hits = [lowered.find(t) for t in terms]
    hits = [h for h in hits if h >= 0]

    start = 0
    if hits:
        # lead in with a little context, and start on a word boundary
        start = max(0, min(hits) - length // 4)
        if start > 0:
            space = text.rfind(" ", 0, start)
            start = space + 1 if space >= 0 else start

    window = text[start : start + length]
    if start + length < len(text):
        space = window.rfind(" ")
        if space > length // 2:
            window = window[:space]
        window += "\u2026"
    if start > 0:
        window = "\u2026" + window

    html = escape(window)
    if terms:
        pattern = re.compile("|".join(re.escape(t) for t in sorted(terms, key=len, reverse=True)), re.IGNORECASE)
        html = pattern.sub(lambda m: f"<mark>{m[0]}</mark>", html)
    return mark_safe(html)


class KnowledgeSource(TembaModel):
    """
    A source of knowledge that AI agents can search semantically.

    Indexing - crawling, extracting, chunking and embedding - is performed entirely by mailroom, which this app asks to
    index a source whenever it changes what that source's index is derived from, and which also sweeps for rows needing
    work in case a request is lost. This app owns the schema, the CRUD UI and document uploads only; it never calls an
    embeddings service.
    """

    # authored types - items live in their own Django-owned table, mailroom only reads
    TYPE_SHORTCUTS = "shortcuts"  # the org's shortcuts, read by mailroom straight from tickets_shortcut
    TYPE_HELPDESK = "helpdesk"  # the org's own help articles, read from tickets_article
    # ingested types - items share tickets_knowledgeitem, mailroom owns the lifecycle
    TYPE_WEBSITE = "website"  # a crawled website
    TYPE_DOCUMENTS = "documents"  # uploaded files
    TYPE_CHOICES = (
        (TYPE_SHORTCUTS, _("Shortcuts")),
        (TYPE_HELPDESK, _("Helpdesk")),
        (TYPE_WEBSITE, _("Website")),
        (TYPE_DOCUMENTS, _("Documents")),
    )

    SYSTEM_TYPES = (TYPE_SHORTCUTS, TYPE_HELPDESK)  # one of each per org, created in Org.initialize()
    SYSTEM_NAMES = {TYPE_SHORTCUTS: "Shortcuts", TYPE_HELPDESK: "Helpdesk"}

    STATUS_PENDING = "P"  # needs (re)indexing
    STATUS_INDEXING = "I"  # mailroom is working on it
    STATUS_READY = "R"  # indexed and searchable
    STATUS_FAILED = "F"  # last indexing attempt failed, see error
    STATUS_CHOICES = (
        (STATUS_PENDING, _("Pending")),
        (STATUS_INDEXING, _("Indexing")),
        (STATUS_READY, _("Ready")),
        (STATUS_FAILED, _("Failed")),
    )

    REFRESH_NEVER = "never"
    REFRESH_DAILY = "daily"
    REFRESH_WEEKLY = "weekly"
    REFRESH_MONTHLY = "monthly"
    REFRESH_CHOICES = (
        (REFRESH_NEVER, _("Never")),
        (REFRESH_DAILY, _("Daily")),
        (REFRESH_WEEKLY, _("Weekly")),
        (REFRESH_MONTHLY, _("Monthly")),
    )

    # config keys for TYPE_WEBSITE
    CONFIG_URL = "url"
    CONFIG_MAX_DEPTH = "max_depth"
    CONFIG_MAX_PAGES = "max_pages"
    CONFIG_REFRESH = "refresh"

    # config keys for TYPE_HELPDESK
    CONFIG_COLORS = "colors"  # the org's article palette, index -> hex; articles embed the index, never the hex
    CONFIG_COLOR_STYLES = "color_styles"  # what each palette entry looks like on a page, by index

    DEFAULT_MAX_DEPTH = 3
    DEFAULT_MAX_PAGES = 500
    MAX_MAX_PAGES = 5_000
    MAX_URL_LEN = 2048

    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="sources")
    source_type = models.CharField(max_length=16, choices=TYPE_CHOICES)

    # type specific settings, e.g. for website: url, max_depth, max_pages, refresh. Empty for other types.
    config = models.JSONField(default=dict)

    # everything below is written by mailroom as it indexes - this app only reads it
    status = models.CharField(max_length=1, choices=STATUS_CHOICES, default=STATUS_PENDING)
    error = models.CharField(max_length=255, null=True)
    last_indexed_on = models.DateTimeField(null=True)
    num_items = models.IntegerField(default=0)
    num_chunks = models.IntegerField(default=0)

    org_limit_key = Org.LIMIT_KNOWLEDGE

    @classmethod
    def create_system(cls, org):
        """
        Creates the org's two system sources - its shortcut list and its helpdesk.
        """
        assert not org.sources.filter(source_type__in=cls.SYSTEM_TYPES).exists(), "org already has system knowledge"

        return [
            org.sources.create(
                name=cls.SYSTEM_NAMES[t],
                source_type=t,
                is_system=True,
                created_by=org.created_by,
                modified_by=org.modified_by,
            )
            for t in cls.SYSTEM_TYPES
        ]

    @classmethod
    def get_system(cls, org, source_type: str):
        return org.sources.filter(source_type=source_type, is_system=True, is_active=True).first()

    @classmethod
    def create_website(cls, org, user, name: str, url: str, *, max_depth=None, max_pages=None, refresh=None):
        assert cls.is_valid_name(name), f"'{name}' is not a valid knowledge name"
        assert not org.sources.filter(name__iexact=name, is_active=True).exists()

        source = org.sources.create(
            name=name,
            source_type=cls.TYPE_WEBSITE,
            config={
                cls.CONFIG_URL: url,
                cls.CONFIG_MAX_DEPTH: max_depth or cls.DEFAULT_MAX_DEPTH,
                cls.CONFIG_MAX_PAGES: max_pages or cls.DEFAULT_MAX_PAGES,
                cls.CONFIG_REFRESH: refresh or cls.REFRESH_WEEKLY,
            },
            created_by=user,
            modified_by=user,
        )
        source.request_indexing()
        return source

    @classmethod
    def create_documents(cls, org, user, name: str):
        assert cls.is_valid_name(name), f"'{name}' is not a valid knowledge name"
        assert not org.sources.filter(name__iexact=name, is_active=True).exists()

        # nothing to index until files are uploaded
        return org.sources.create(
            name=name,
            source_type=cls.TYPE_DOCUMENTS,
            status=cls.STATUS_READY,
            created_by=user,
            modified_by=user,
        )

    @property
    def url(self) -> str:
        return self.config.get(self.CONFIG_URL)

    @property
    def colors(self) -> dict:
        """
        The org's article palette, shared by every author so color use stays consistent across articles. Articles
        embed an index into this; recoloring an entry restyles its every use, removing one blanks them.
        """
        return self.config.get(self.CONFIG_COLORS, {})

    @property
    def color_styles(self) -> dict:
        """
        What each palette entry looks like on a page, kept alongside the palette so that whatever serves a page needs
        no color math of its own - see derive_color_styles.
        """
        return self.config.get(self.CONFIG_COLOR_STYLES, {})

    def set_colors(self, colors: dict):
        self.config[self.CONFIG_COLORS] = colors
        self.config[self.CONFIG_COLOR_STYLES] = derive_color_styles(colors)
        self.save(update_fields=("config", "modified_on"))

    def mark_pending(self):
        """
        Flags this source as needing (re)indexing and asks mailroom to do it. Called whenever this app changes
        something mailroom's index is derived from - website config, uploaded files, imported articles.
        """
        self.status = self.STATUS_PENDING
        self.error = None
        self.save(update_fields=("status", "error"))

        self.request_indexing()

    def request_indexing(self):
        """
        Asks mailroom to index this source's changes. That waits for the commit because mailroom indexes whatever has
        changed since it last indexed and then moves that watermark on - so if it ran first, it would skip the change.
        Mailroom collapses repeated requests for a source, but bulk changes should still make only one.
        """
        on_transaction_commit(self._request_indexing)

    def _request_indexing(self):
        # best effort - a lost request only delays indexing until mailroom's sweep finds the source stale
        try:
            mailroom.get_client().knowledge_index(self.org, self)
        except Exception:
            logger.exception("error requesting knowledge indexing from mailroom", extra={"source_id": self.id})

    def release(self, user):
        assert not (self.is_system and self.org.is_active), "can't release system knowledge"

        # deactivate first so nothing reads or indexes it while we purge
        self.is_active = False
        self.name = self._deleted_name()
        self.num_items = 0
        self.num_chunks = 0
        self.modified_by = user
        self.save(update_fields=("name", "is_active", "num_items", "num_chunks", "modified_by", "modified_on"))

        self._purge()

    def delete(self):
        self._purge()

        super().delete()

    def _purge(self):
        """
        Removes this source's chunks, items, articles and article images. Rows go first; storage objects are only
        removed once their rows are gone.
        """
        # collect storage keys before the rows that name them disappear - two different buckets
        item_paths = list(self.items.exclude(path=None).values_list("path", flat=True))
        image_paths = list(ArticleImage.objects.filter(article__source=self).values_list("path", flat=True))

        delete_in_batches(self.chunks.all())
        delete_in_batches(self.items.all())
        delete_in_batches(ArticleImage.objects.filter(article__source=self))
        delete_in_batches(ArticleCount.objects.filter(article__source=self))

        # the helpdesk's public site goes with its articles
        for site in HelpSite.objects.filter(source=self):
            site.delete()

        # parent is PROTECT so flatten the article tree before deleting it
        self.articles.exclude(parent=None).update(parent=None)
        delete_in_batches(self.articles.all())

        # ATOMIC_REQUESTS means we're inside the request's transaction, so this has to wait for the commit - otherwise
        # a later failure rolls the rows back and leaves them pointing at objects we've already destroyed
        on_transaction_commit(lambda: self._delete_storage(item_paths, image_paths))

    @staticmethod
    def _delete_storage(item_paths: list, image_paths: list):
        for path in item_paths:
            default_storage.delete(path)
        for path in image_paths:
            public_file_storage.delete(path)

    class Meta:
        constraints = [models.UniqueConstraint("org", Lower("name"), name="unique_knowledgesource_names")]
        indexes = [
            # mailroom's indexing sweep's worklist
            models.Index(name="knowledgesource_pending", fields=("id",), condition=Q(is_active=True, status="P")),
        ]


class Article(models.Model):
    """
    An article in an org's helpdesk. Written by this app, read by mailroom, which indexes only published, active
    articles.

    Deliberately not a TembaModel: TembaModel.name is capped at 64 chars and NameValidator rejects " and \\, which real
    help titles routinely contain. Soft-deleted like Shortcut so mailroom's delta index sees the tombstone - a hard
    delete would leave its chunks stranded until a full reindex.
    """

    STATUS_DRAFT = "D"  # never indexed, never public
    STATUS_PUBLISHED = "P"
    STATUS_CHOICES = ((STATUS_DRAFT, _("Draft")), (STATUS_PUBLISHED, _("Published")))

    MAX_TITLE_LEN = 255
    MAX_SLUG_LEN = 255
    MAX_BODY_LEN = 100_000  # bodies are chunked and embedded, so this bounds what one article can cost to index
    MAX_DESCRIPTION_LEN = 500  # a section says what it holds in a line or two, not an article
    MAX_DEPTH = 2  # total levels - a root and its children, no grandchildren; enforced by the reorder view
    MAX_ARTICLES = 1000  # per helpdesk

    uuid = models.UUIDField(unique=True, default=uuid4)
    source = models.ForeignKey(KnowledgeSource, on_delete=models.PROTECT, related_name="articles")

    # the tree - a plain self-FK, not mptt (that dep exists only for locations and buys nothing at help-centre depth).
    # Depth is capped at MAX_DEPTH and cycles are rejected server-side.
    parent = models.ForeignKey("self", on_delete=models.PROTECT, null=True, related_name="children")
    sort_order = models.IntegerField(default=0)

    title = models.CharField(max_length=MAX_TITLE_LEN)
    slug = models.SlugField(max_length=MAX_SLUG_LEN)
    # a root of the tree is a section: a heading over the articles filed under it, described in plain text rather
    # than written as an article. So a section has a description and no body, and an article the reverse.
    body = models.TextField(default="")  # markdown source
    description = models.TextField(default="")

    # the body as the site serves it, rendered whenever the article is saved published - the site reads these rather
    # than rendering, so a page costs it nothing but a query. Links to other articles are left as article: links in
    # here, for the site to resolve against where those articles are as of each read.
    body_html = models.TextField(default="")
    headings = models.JSONField(default=list)  # the top level headings, as [{"id": ..., "text": ...}]

    # ISO-639-3, so a helpdesk can hold articles in several languages. Translations aren't linked to each other yet -
    # retrieval doesn't need them, as multilingual-e5 embeds cross-lingually, and linking is a question for the
    # eventual public site rather than for search.
    language = models.CharField(max_length=3, default="eng")

    status = models.CharField(max_length=1, choices=STATUS_CHOICES, default=STATUS_DRAFT)
    published_on = models.DateTimeField(null=True)

    is_active = models.BooleanField(default=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_on = models.DateTimeField(default=timezone.now)
    modified_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    # auto_now is load-bearing: mailroom's staleness sweep is MAX(modified_on) > source.last_indexed_on, so an
    # unpublish or a soft-delete has to bump it for the removal to be noticed
    modified_on = models.DateTimeField(auto_now=True)

    @classmethod
    def create(
        cls, source, user, title: str, *, body: str = "", description: str = "", parent=None, language: str = None
    ):
        assert source.source_type == KnowledgeSource.TYPE_HELPDESK, "articles can only belong to a helpdesk"
        assert parent is None or parent.source_id == source.id, "parent must be in the same helpdesk"

        # new articles go to the end of their level so creating one never reshuffles the tree
        last = cls.objects.filter(source=source, parent=parent, is_active=True).order_by("-sort_order").first()

        return cls.objects.create(
            source=source,
            parent=parent,
            sort_order=(last.sort_order + 1) if last else 0,
            title=title,
            slug=cls.get_unique_slug(source, title),
            body=body,
            description=description,
            language=language or source.org.flow_languages[0],
            created_by=user,
            modified_by=user,
        )

    @classmethod
    def get_unique_slug(cls, source, title: str, ignore=None) -> str:
        base = slugify(title)[: cls.MAX_SLUG_LEN] or "article"
        qs = cls.objects.filter(source=source, is_active=True)
        if ignore:
            qs = qs.exclude(id=ignore.id)

        slug, count = base, 1
        while qs.filter(slug=slug).exists():
            count += 1
            suffix = f"-{count}"
            slug = f"{base[: cls.MAX_SLUG_LEN - len(suffix)]}{suffix}"

        return slug

    @classmethod
    def get_tree(cls, source) -> list:
        """
        Returns the helpdesk's active articles in display order - depth first, siblings by (sort_order, title) - with
        each one's depth and the uuid of the article it's shown under attached.

        parent_uuid is the parent as rendered rather than as stored, so it's null for an article whose parent has been
        deleted - which is shown as a root here and would otherwise name an article the client can't see. Articles
        stored deeper than MAX_DEPTH allows - data can predate the cap - render flattened rather than hidden: as
        siblings following their parent, under the deepest ancestor the cap does allow.
        """
        active = list(source.articles.filter(is_active=True).order_by("sort_order", "title"))
        active_ids = {a.id for a in active}

        by_parent = defaultdict(list)
        for article in active:
            # an article whose parent isn't in the active set is shown as a root rather than dropped - otherwise it
            # would be invisible here and so unmovable, while still being indexed if it's published
            by_parent[article.parent_id if article.parent_id in active_ids else None].append(article)

        ordered = []

        def visit(article, parent, depth):
            for child in by_parent[article.id if article else None]:
                child.depth = depth
                child.parent_uuid = parent.uuid if parent else None
                ordered.append(child)
                if depth + 1 < cls.MAX_DEPTH:
                    visit(child, child, depth + 1)
                else:
                    # a row at the cap can't be shown with children, so any it has render at its own depth and
                    # parent - flattened into the siblings that follow it rather than dropped
                    visit(child, parent, depth)

        visit(None, None, 0)
        return ordered

    @classmethod
    def apply_sort(cls, source, order: list):
        """
        Applies a new tree ordering given as (uuid, parent uuid or None, sort order) tuples, which need only describe
        what moved. The client's tree is never trusted - the resulting forest is re-derived here and rejected if it
        names an article that isn't in this helpdesk, introduces a cycle, or nests deeper than MAX_DEPTH.
        """
        articles = {str(a.uuid): a for a in source.articles.filter(is_active=True)}
        uuids_by_id = {a.id: uuid for uuid, a in articles.items()}

        # start from the tree as it stands so unmentioned articles keep their place
        parents = {uuid: uuids_by_id.get(a.parent_id) for uuid, a in articles.items()}
        changed = []

        for uuid, parent_uuid, sort_order in order:
            article = articles.get(uuid)
            if not article:
                raise ValueError(f"no such article: {uuid}")
            if parent_uuid is not None and parent_uuid not in articles:
                raise ValueError(f"no such article: {parent_uuid}")

            # a section is described and an article written, and which one is which is where it sits in the
            # tree - so a move can put a section elsewhere among the sections, or an article in another section,
            # but can't turn one into the other
            if (parent_uuid is None) != (article.parent_id is None):
                raise ValueError("a section can't become an article, nor an article a section")

            parents[uuid] = parent_uuid
            article.parent_id = articles[parent_uuid].id if parent_uuid else None
            article.sort_order = sort_order
            changed.append(article)

        for uuid in parents:
            seen, depth, ancestor = {uuid}, 1, parents[uuid]
            while ancestor is not None:
                if ancestor in seen:
                    raise ValueError("articles can't be their own ancestor")
                seen.add(ancestor)
                depth += 1
                if depth > cls.MAX_DEPTH:
                    raise ValueError(f"articles can't be nested more than {cls.MAX_DEPTH} deep")
                ancestor = parents[ancestor]

        # deliberately doesn't touch modified_on: ordering isn't part of what mailroom indexes, so a reorder shouldn't
        # make the helpdesk look stale and re-embed every article in it
        cls.objects.bulk_update(changed, ("parent", "sort_order"))

    @property
    def org(self):
        return self.source.org

    @property
    def is_section(self) -> bool:
        return self.parent_id is None

    def render(self, links: dict = None) -> tuple[str, list[Heading]]:
        """
        The article rendered, and its top level headings for the page to link to - for a page given a map of uuid to
        address for links to other articles to resolve against (see HelpSite.get_link_targets), and otherwise as it's
        kept for whatever serves it - see render_markdown.
        """
        return render_markdown(self.body, links)

    def prerender(self):
        """
        Renders the body into what the site serves - see body_html
        """
        self.body_html, headings = self.render()
        self.headings = [h._asdict() for h in headings]

    def save(self, *args, **kwargs):
        # a published article is served from its rendered HTML, so that follows the body whenever one is saved
        if self.status == self.STATUS_PUBLISHED:
            self.prerender()
            if update_fields := kwargs.get("update_fields"):
                kwargs["update_fields"] = (*update_fields, "body_html", "headings")

        super().save(*args, **kwargs)

    def as_html(self, links: dict = None) -> str:
        return self.render(links)[0]

    def as_plain_text(self) -> str:
        return to_plain_text(self.body)

    def excerpt(self, length: int = 160) -> str:
        """
        The article's opening, as plain text, for listing it by - a section describes itself, an article is read.
        """
        text = self.as_plain_text()
        if len(text) <= length:
            return text
        cut = text.rfind(" ", 0, length)
        return text[: cut if cut > length // 2 else length].rstrip() + "\u2026"

    def publish(self, user):
        self.status = self.STATUS_PUBLISHED
        self.published_on = timezone.now()
        self.modified_by = user
        self.save(update_fields=("status", "published_on", "modified_by", "modified_on"))

    def unpublish(self, user):
        """
        Reverts to a draft. modified_on bumps, so mailroom's next index of the helpdesk drops our chunks.
        """
        self.status = self.STATUS_DRAFT
        self.published_on = None
        self.modified_by = user
        self.save(update_fields=("status", "published_on", "modified_by", "modified_on"))

    def release(self, user):
        """
        Soft delete - a tombstone, so mailroom's next index of the helpdesk drops our chunks. A section goes only once
        it's empty, since its articles would otherwise be left as sections themselves; the images go for good, since
        nothing will render this body again.
        """
        assert not (self.is_section and self.children.filter(is_active=True).exists()), (
            "a section with articles in it can't be released"
        )

        image_paths = list(self.images.values_list("path", flat=True))
        was_published = self.status == self.STATUS_PUBLISHED

        with transaction.atomic():
            self.images.all().delete()

            self.is_active = False
            self.status = self.STATUS_DRAFT
            self.published_on = None
            self.modified_by = user
            self.save(update_fields=("is_active", "status", "published_on", "modified_by", "modified_on"))

        # ATOMIC_REQUESTS means the atomic block above is only a savepoint, so the storage objects can't go until the
        # request's transaction commits - otherwise a later failure restores the article without its screenshots
        on_transaction_commit(lambda: [public_file_storage.delete(p) for p in image_paths])

        # a draft was never indexed so there's nothing to drop
        if was_published:
            self.source.request_indexing()

    def __str__(self):
        return self.title

    class Meta:
        constraints = [
            models.UniqueConstraint("source", "slug", condition=Q(is_active=True), name="unique_article_slugs")
        ]
        indexes = [
            # the tree, in display order
            models.Index(name="article_by_tree", fields=("source", "parent", "sort_order")),
            # mailroom's staleness + delta sweep
            models.Index(name="article_by_modified", fields=("source", "modified_on")),
        ]


def get_article_image_path(article, image_uuid, content_type: str) -> str:
    # the extension comes from the sniffed content type rather than from the uploaded filename. These objects live in
    # a public, unauthenticated bucket, and storage backends serve a key by the type its extension implies - so a file
    # whose first bytes sniff as an image but which is named ".html" would otherwise be served as HTML from our own
    # domain.
    extension = mimetypes.guess_extension(content_type) or ".bin"

    return (
        f"orgs/{article.source.org_id}/knowledge/{article.source.uuid}/articles/{article.uuid}/{image_uuid}{extension}"
    )


class ArticleImage(models.Model):
    """
    A screenshot uploaded to an article and referenced from its markdown by URL. Stored in public storage because the
    eventual standalone help site serves these directly.
    """

    ALLOWED_CONTENT_TYPES = ("image/gif", "image/jpeg", "image/png", "image/webp")
    MAX_UPLOAD_SIZE = 1024 * 1024 * 10  # 10MB
    MAX_IMAGES = 50  # per article

    uuid = models.UUIDField(unique=True, default=uuid4)
    article = models.ForeignKey(Article, on_delete=models.PROTECT, related_name="images")
    name = models.CharField(max_length=255)
    path = models.CharField(max_length=2048)  # key in the public bucket
    content_type = models.CharField(max_length=255)
    size = models.IntegerField()

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_on = models.DateTimeField(default=timezone.now)

    @classmethod
    def is_allowed_type(cls, content_type: str) -> bool:
        return content_type in cls.ALLOWED_CONTENT_TYPES

    @classmethod
    def from_upload(cls, article, user, file):
        # borrows Media's filename cleaning but not the model itself - its alternates and ffmpeg processing are
        # message attachment concerns that a screenshot has no use for
        from temba.msgs.models import Media

        assert cls.is_allowed_type(file.content_type), "unsupported content type"

        uuid = uuid4()
        name = Media.clean_name(file.name, file.content_type)
        path = public_file_storage.save(get_article_image_path(article, uuid, file.content_type), file)

        return cls.objects.create(
            uuid=uuid,
            article=article,
            name=name,
            path=path,
            content_type=file.content_type,
            size=public_file_storage.size(path),
            created_by=user,
        )

    @property
    def url(self) -> str:
        return public_file_storage.url(self.path)

    def delete(self):
        path = self.path

        super().delete()

        # only remove the storage object once the deletion has committed - see Article.release
        on_transaction_commit(lambda: public_file_storage.delete(path))


class ArticleCount(BaseDailyCount):
    """
    Daily counts of article activity on the help site - for now just views, which are what the site ranks its popular
    articles by. Written as deltas by the site as it serves pages and squashed periodically.
    """

    squash_over = ("article_id", "day", "scope")

    SCOPE_VIEWS = "views"

    article = models.ForeignKey(Article, on_delete=models.PROTECT, related_name="counts", db_index=False)

    @classmethod
    def record_view(cls, article):
        cls.objects.create(article=article, day=timezone.now().date(), scope=cls.SCOPE_VIEWS, count=1)

    class Meta:
        indexes = [
            models.Index(
                "article", "day", OpClass("scope", name="varchar_pattern_ops"), name="articlecount_article_scope"
            ),
            # for squashing task
            models.Index(
                name="articlecount_unsquashed", fields=("article", "day", "scope"), condition=Q(is_squashed=False)
            ),
        ]


def lookup_txt(name: str) -> list | None:
    """
    The TXT records at a DNS name, as strings - an empty list if the name doesn't resolve or has none, and None if
    the lookup itself failed, which says nothing about what's there.
    """
    try:
        resolver = dns.resolver.Resolver()
        resolver.lifetime = 5
        answer = resolver.resolve(name, "TXT")
    except dns.resolver.NXDOMAIN, dns.resolver.NoAnswer:
        return []
    except dns.exception.DNSException, OSError, ValueError:
        return None

    return [b"".join(record.strings).decode("utf-8", errors="replace") for record in answer]


def is_dark_color(color: str) -> bool:
    """
    Whether a #rrggbb color is dark enough to want light text on it, by its relative luminance.
    """
    r, g, b = (int(color[i : i + 2], 16) / 255 for i in (1, 3, 5))

    def linear(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b) < 0.4


def generate_domain_token() -> str:
    return generate_secret(32)


class HelpSite(models.Model):
    """
    The public face of an org's helpdesk: the site its published articles are read on. Previewed from inside the app,
    and served to the world on a domain of the org's own - one they point at us by CNAME and prove is theirs with a
    TXT record, checked whenever they ask and required before the domain is served. There's one site per helpdesk,
    made the first time anyone opens its settings.
    """

    MAX_TITLE_LEN = 128
    MAX_TAGLINE_LEN = 255
    MAX_FOOTER_LEN = 255
    MAX_DOMAIN_LEN = 128

    # where the TXT record that proves a domain is the org's goes - _helpsite-verification.<domain> - and what it holds
    VERIFICATION_RECORD = "_helpsite-verification"

    # config keys
    CONFIG_PRIMARY_COLOR = "primary_color"  # links, buttons, accents
    CONFIG_HEADER_COLOR = "header_color"  # the header's background
    CONFIG_CHAT_CHANNEL = "chat_channel"  # the uuid of the WebChat channel whose widget the site embeds, if any

    DEFAULT_PRIMARY_COLOR = "#2f6fed"
    DEFAULT_HEADER_COLOR = "#ffffff"

    # The bubble colors - the backgrounds an author can give a column in an article, chosen here so every article
    # draws on the same few. They're the helpdesk's palette, keyed by these indexes, which is what articles embed.
    BUBBLE_KEYS = ("1", "2", "3")

    DOMAINS_CACHE_KEY = "helpsite_domains"
    DOMAINS_CACHE_TTL = 60 * 60  # a safety net - the entry is dropped whenever a site changes

    POPULAR_DAYS = 30  # how far back views count towards being popular
    POPULAR_LIMIT = 6
    SEARCH_LIMIT = 20
    SEARCH_CACHE_KEY = "helpsite_search:%d:%s"
    SEARCH_CACHE_TTL = 60 * 5

    uuid = models.UUIDField(unique=True, default=uuid4)
    source = models.OneToOneField(KnowledgeSource, on_delete=models.PROTECT, related_name="site")

    title = models.CharField(max_length=MAX_TITLE_LEN)
    tagline = models.CharField(max_length=MAX_TAGLINE_LEN, default="")
    footer = models.CharField(max_length=MAX_FOOTER_LEN, default="")

    # the org's own domain for the site, e.g. help.example.com, which they point at us by CNAME. Served only once
    # it's verified - a request is matched to a site by nothing but its host, so a verified domain is one site's
    # alone, while an unverified one can't keep its real owner from claiming it.
    domain = models.CharField(max_length=MAX_DOMAIN_LEN, null=True)
    domain_token = models.CharField(max_length=32, default=generate_domain_token)  # what the TXT record must hold
    domain_verified_on = models.DateTimeField(null=True)

    # whether the site is served publicly - the domain can stay configured while the site is taken down
    is_enabled = models.BooleanField(default=False)

    config = models.JSONField(default=dict)

    # the addresses of the site the org moved from, by path, to the uuid of the article or section each is now -
    # written by whatever brought the articles over, and only ever consulted for an address the site doesn't have
    redirects = models.JSONField(default=dict)

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_on = models.DateTimeField(default=timezone.now)
    modified_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    modified_on = models.DateTimeField(auto_now=True)

    @classmethod
    def get_or_create(cls, source, user):
        assert source.source_type == KnowledgeSource.TYPE_HELPDESK, "only a helpdesk has a site"

        site, _ = cls.objects.get_or_create(
            source=source,
            defaults={"title": source.org.name, "created_by": user, "modified_by": user},
        )
        return site

    @classmethod
    def get_domains(cls) -> dict:
        """
        Every configured domain and the id of its site. Every request to the app has to be checked against this, so
        it's held in the cache - there are few enough domains to hold them all - and dropped whenever a site changes.
        """
        domains = cache.get(cls.DOMAINS_CACHE_KEY)
        if domains is None:
            domains = dict(
                cls.objects.exclude(domain=None).exclude(domain_verified_on=None).values_list("domain", "id")
            )
            cache.set(cls.DOMAINS_CACHE_KEY, domains, timeout=cls.DOMAINS_CACHE_TTL)
        return domains

    @classmethod
    def get_for_host(cls, host: str):
        """
        The site served on the given host, if any. Costs nothing but a cache lookup unless the host is a site's.
        """
        domain, _ = split_domain_port(host)
        domain = domain.lower().removeprefix("www.")
        site_id = cls.get_domains().get(domain) if domain else None
        if not site_id:
            return None

        return cls.objects.filter(id=site_id).select_related("source__org").first()

    @classmethod
    def clean_domain(cls, value: str) -> str | None:
        return (value or "").strip().lower().removeprefix("www.") or None

    @property
    def is_domain_verified(self) -> bool:
        return bool(self.domain and self.domain_verified_on)

    @property
    def verification_record(self) -> str:
        """
        The name of the TXT record that proves the domain is the org's.
        """
        return f"{self.VERIFICATION_RECORD}.{self.domain}" if self.domain else ""

    def set_domain(self, user, domain: str | None):
        """
        Points the site at a domain of the org's own - which then has to be verified before it's served. Setting the
        same domain again changes nothing, so a verified domain stays verified.
        """
        domain = self.clean_domain(domain)
        if domain == self.domain:
            return

        self.domain = domain
        self.domain_verified_on = None
        self.modified_by = user
        self.save(update_fields=("domain", "domain_verified_on", "modified_by", "modified_on"))

    def verify_domain(self) -> bool:
        """
        Looks for the TXT record that proves the domain is the org's, and marks the domain verified - and so served -
        when it's there. Asked for on demand: DNS takes its time, and there's nothing to poll for otherwise.
        """
        if not self.domain:
            return False

        if self.domain_token not in (lookup_txt(self.verification_record) or []):
            return False

        if not self.domain_verified_on:
            self.domain_verified_on = timezone.now()
            self.save(update_fields=("domain_verified_on", "modified_on"))
        return True

    @classmethod
    def check_verified_domains(cls) -> dict:
        """
        Looks again for every verified domain's record, so a domain an org has let go of - and may not own any more -
        stops being served and can be verified by whoever has it now. A lookup that fails outright proves nothing
        either way and is left for next time.
        """
        num_checked, num_lapsed = 0, 0

        for site in cls.objects.exclude(domain_verified_on=None).exclude(domain=None):
            num_checked += 1
            records = lookup_txt(site.verification_record)
            if records is not None and site.domain_token not in records:
                site.domain_verified_on = None
                site.save(update_fields=("domain_verified_on", "modified_on"))
                num_lapsed += 1

        return {"checked": num_checked, "lapsed": num_lapsed}

    @property
    def org(self):
        return self.source.org

    @property
    def is_available(self) -> bool:
        """
        Whether the site can be served publicly - enabled, and belonging to a live helpdesk of an org that still has
        the feature.
        """
        return (
            self.is_enabled
            and self.is_domain_verified
            and self.source.is_active
            and self.org.is_active
            and Org.FEATURE_AGENTS in self.org.features
        )

    @property
    def primary_color(self) -> str:
        return self.config.get(self.CONFIG_PRIMARY_COLOR) or self.DEFAULT_PRIMARY_COLOR

    @property
    def header_color(self) -> str:
        return self.config.get(self.CONFIG_HEADER_COLOR) or self.DEFAULT_HEADER_COLOR

    @property
    def header_text_color(self) -> str:
        """
        What's legible on the header - the page's own dark text on a light header, white on a dark one.
        """
        return "#ffffff" if is_dark_color(self.header_color) else "#1f2430"

    @classmethod
    def get_chat_channels(cls, org):
        """
        The org's WebChat channels - the ones a site can embed the chat widget of.
        """
        from temba.channels.types.webchat import WebChatType

        return org.channels.filter(channel_type=WebChatType.code, is_active=True).order_by("name")

    @property
    def chat_channel(self):
        """
        The WebChat channel readers chat through from the site's pages, if one is configured and still active - a
        channel that's been removed since just leaves the site without chat.
        """
        uuid = self.config.get(self.CONFIG_CHAT_CHANNEL)
        return self.get_chat_channels(self.org).filter(uuid=uuid).first() if uuid else None

    @property
    def bubbles(self) -> dict:
        """
        The bubble colors that are set, by their palette key.
        """
        colors = self.source.colors
        return {key: colors[key] for key in self.BUBBLE_KEYS if colors.get(key)}

    def set_bubbles(self, colors: dict):
        """
        Sets the helpdesk's palette to the given bubble colors - only those keys, so a bubble cleared here stops being
        offered, and any column that embedded it paints nothing until it's set again.
        """
        self.source.set_colors({key: colors[key].lower() for key in self.BUBBLE_KEYS if colors.get(key)})

    def set_config(self, user, **values):
        self.config = {**self.config, **values}
        self.modified_by = user
        self.save(update_fields=("config", "modified_by", "modified_on"))

    def _published(self):
        return self.source.articles.filter(is_active=True, status=Article.STATUS_PUBLISHED)

    def get_sections(self) -> list:
        """
        The published sections, in display order, each with the number of published articles under it. Sections with
        nothing published in them aren't listed - there'd be nothing to read there.
        """
        counts = dict(
            self._published()
            .filter(parent__in=self._published().filter(parent=None))
            .values_list("parent_id")
            .annotate(num=models.Count("id"))
        )
        sections = []
        for section in self._published().filter(parent=None).defer("body").order_by("sort_order", "title"):
            section.num_articles = counts.get(section.id, 0)
            if section.num_articles:
                sections.append(section)
        return sections

    def get_section(self, slug: str):
        return self._published().filter(parent=None, slug=slug).first()

    def get_articles(self, section) -> list:
        """
        The published articles in a section, in display order.
        """
        return list(self._published().filter(parent=section).order_by("sort_order", "title"))

    def get_article(self, section, slug: str):
        return self._published().filter(parent=section, slug=slug).first()

    def get_link_targets(self, prefix: str = "") -> dict:
        """
        Where every readable article and section on the site currently lives, by uuid - what article: links in a
        body resolve against. Articles link by uuid rather than by address, so a retitled or refiled article keeps
        every link to it; this is the address as of now.
        """
        sections = {
            str(uuid): f"{prefix}/{slug}/"
            for uuid, slug in self._published().filter(parent=None).values_list("uuid", "slug")
        }
        articles = self._published().filter(parent__uuid__in=sections.keys())

        targets, listed = {}, set()
        for uuid, slug, parent_uuid in articles.values_list("uuid", "slug", "parent__uuid"):
            targets[str(uuid)] = f"{sections[str(parent_uuid)]}{slug}/"
            listed.add(str(parent_uuid))

        # only a section with something published in it is a page
        targets.update({uuid: address for uuid, address in sections.items() if uuid in listed})
        return targets

    @staticmethod
    def normalize_path(path: str) -> str:
        """
        The form an old address is kept and looked up in - lowercased, without any query or fragment, and with a
        leading slash but no trailing one, so the same page reached slightly differently is still the same page.
        """
        path = path.strip().split("?")[0].split("#")[0].lower()
        return "/" + path.strip("/")

    def get_redirect(self, path: str, prefix: str = "") -> str | None:
        """
        Where an address of the site the org moved from leads now, if the mapping has it and it's a page.
        """
        uuid = self.redirects.get(self.normalize_path(path))
        return self.get_link_targets(prefix).get(uuid) if uuid else None

    def get_popular(self, limit: int = POPULAR_LIMIT) -> list:
        """
        The most viewed published articles over the last POPULAR_DAYS, most viewed first. Only articles that are
        currently reachable - published, in a published section - count.
        """
        since = timezone.now().date() - timedelta(days=self.POPULAR_DAYS)
        totals = (
            ArticleCount.objects.filter(
                article__source=self.source,
                article__is_active=True,
                article__status=Article.STATUS_PUBLISHED,
                article__parent__is_active=True,
                article__parent__status=Article.STATUS_PUBLISHED,
                scope=ArticleCount.SCOPE_VIEWS,
                day__gte=since,
            )
            .values_list("article_id")
            .annotate(total=Sum("count"))
            .order_by("-total", "article_id")[:limit]
        )
        by_id = {a.id: a for a in self._published().filter(id__in=[t[0] for t in totals]).select_related("parent")}
        return [by_id[t[0]] for t in totals if t[0] in by_id]

    def search(self, query: str, limit: int = SEARCH_LIMIT) -> list:
        """
        Searches the site's articles, returning (article, snippet) pairs, best first. Semantic search through mailroom
        leads when the helpdesk has been indexed, and text search over titles and bodies fills in behind it - so a
        search works before the first index, and still finds an exact phrase the embeddings rank low.
        """
        query = query.strip()
        if not query:
            return []

        readable = self._published().filter(parent__in=self._published().filter(parent=None))

        # the site is public, and a search costs an embedding and a scan of every body - so the same question asked
        # again within a few minutes is answered from the last time, less anything unpublished since
        cache_key = self.SEARCH_CACHE_KEY % (self.id, hashlib.md5(f"{query.lower()}|{limit}".encode()).hexdigest())
        cached = cache.get(cache_key)
        if cached is not None:
            by_id = {a.id: a for a in readable.filter(id__in=[i for i, _ in cached]).select_related("parent")}
            return [(by_id[i], snippet) for i, snippet in cached if i in by_id]

        terms = [t for t in re.split(r"\W+", query) if len(t) > 2]  # worth marking in a snippet

        ordered, snippets = [], {}

        if self.source.last_indexed_on:
            try:
                # an article can match as several chunks, so ask for more than we need to still fill the limit
                results = mailroom.get_client().knowledge_search(
                    self.org, query, sources=[self.source], limit=limit * 3
                )
            except RequestException as e:
                logger.error(f"error searching knowledge: {e}", exc_info=True)
                results = []

            keys = []
            for r in results:
                if r["item_key"] not in keys:
                    keys.append(r["item_key"])
                    snippets[r["item_key"]] = make_snippet(to_plain_text(r["text"]), terms)

            by_uuid = {str(a.uuid): a for a in readable.filter(uuid__in=keys).select_related("parent")}
            ordered.extend(by_uuid[k] for k in keys if k in by_uuid)

        if len(ordered) < limit:
            # simple rather than a language config, since a helpdesk can hold articles in any language
            vector = SearchVector("title", weight="A", config="simple") + SearchVector(
                "body", weight="B", config="simple"
            )
            search = SearchQuery(query, search_type="websearch", config="simple")
            matches = (
                readable.exclude(id__in=[a.id for a in ordered])
                .annotate(rank=SearchRank(vector, search))
                .filter(rank__gt=0)
                .order_by("-rank", "title")
                .select_related("parent")[: limit - len(ordered)]
            )
            ordered.extend(matches)

        results = [(a, snippets.get(str(a.uuid)) or make_snippet(a.as_plain_text(), terms)) for a in ordered[:limit]]
        cache.set(cache_key, [(a.id, snippet) for a, snippet in results], self.SEARCH_CACHE_TTL)
        return results

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)

        cache.delete(self.DOMAINS_CACHE_KEY)

    def delete(self):
        super().delete()

        cache.delete(self.DOMAINS_CACHE_KEY)

    def __str__(self):
        return self.title

    class Meta:
        constraints = [
            # a verified domain is one site's alone; an unverified claim on it blocks nobody
            models.UniqueConstraint(
                "domain", condition=Q(domain_verified_on__isnull=False), name="unique_verified_helpsite_domains"
            )
        ]


class HelpdeskImportError(Exception):
    """
    An import that couldn't go on, with what a user can do about it.
    """

    pass


class HelpdeskImportType:
    """
    Base type for the help sites a helpdesk can be brought over from. A type asks for what it needs in its form,
    does the import in a worker, and is registered by class name in settings.HELPDESK_IMPORT_TYPES.
    """

    slug = None
    name = None

    # the form asking for what the import needs - a HelpdeskImportForm, whose cleaned data becomes the config
    form_class = None

    # config keys dropped once the import is over - what was lent for it rather than kept
    secret_config_keys = ()

    @property
    def template_name(self) -> str:
        """
        The dialog's template, which extends knowledge/helpdeskimport_create.html with the type's fields.
        """
        return f"knowledge/imports/{self.slug}/create.html"

    def is_available_to(self, org, user) -> bool:
        """
        Determines whether this import type is offered to the given user.
        """
        return True

    def perform(self, imp):  # pragma: no cover
        """
        Brings the site over into the import's helpdesk, advancing the import as it goes. Raises HelpdeskImportError
        for anything the user can do something about.
        """
        raise NotImplementedError()


class HelpdeskImport(models.Model):
    """
    A help site brought over into the helpdesk from somewhere else, done in the background once the workspace has
    handed over what its type needs to get in. The page shows its progress as it goes, and what went wrong if it
    didn't finish.
    """

    STATUS_PENDING = "P"
    STATUS_PROCESSING = "O"
    STATUS_COMPLETE = "C"
    STATUS_FAILED = "F"
    STATUS_CHOICES = (
        (STATUS_PENDING, _("Pending")),
        (STATUS_PROCESSING, _("Processing")),
        (STATUS_COMPLETE, _("Complete")),
        (STATUS_FAILED, _("Failed")),
    )

    # slugs used for statuses in JSON, since the choice labels are for display
    STATUS_SLUGS = {
        STATUS_PENDING: "pending",
        STATUS_PROCESSING: "processing",
        STATUS_COMPLETE: "complete",
        STATUS_FAILED: "failed",
    }

    # an import that never finished in this long is taken to have died with its worker rather than to be running
    UNFINISHED_WINDOW = timedelta(hours=4)

    uuid = models.UUIDField(unique=True, default=uuid4)
    org = models.ForeignKey(Org, on_delete=models.PROTECT, related_name="helpdesk_imports")
    source = models.ForeignKey(KnowledgeSource, on_delete=models.PROTECT, related_name="imports")
    import_type = models.CharField(max_length=16)  # the slug of a registered HelpdeskImportType

    # what the type needs to get in and bring the site over - its secrets are dropped once the import is over
    config = models.JSONField(default=dict)

    status = models.CharField(max_length=1, choices=STATUS_CHOICES, default=STATUS_PENDING)
    num_items = models.IntegerField(default=0)  # sections and articles to bring over, known once listed
    num_imported = models.IntegerField(default=0)
    error = models.CharField(max_length=255, null=True)

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_on = models.DateTimeField(default=timezone.now)
    modified_on = models.DateTimeField(auto_now=True)
    started_on = models.DateTimeField(null=True)
    finished_on = models.DateTimeField(null=True)

    @classmethod
    def get_types(cls):
        from .imports import TYPES

        return TYPES.values()

    @classmethod
    def get_type(cls, slug: str):
        from .imports import TYPES

        return TYPES.get(slug)

    @classmethod
    def create(cls, source, user, import_type: HelpdeskImportType, config: dict):
        assert source.source_type == KnowledgeSource.TYPE_HELPDESK, "only a helpdesk can be imported into"

        return cls.objects.create(
            org=source.org, source=source, import_type=import_type.slug, config=config, created_by=user
        )

    @classmethod
    def get_unfinished(cls, source):
        """
        The import that's running for the helpdesk, if one is - another can't be started while it is.
        """
        return cls.objects.filter(
            source=source,
            status__in=(cls.STATUS_PENDING, cls.STATUS_PROCESSING),
            created_on__gt=timezone.now() - cls.UNFINISHED_WINDOW,
        ).first()

    @classmethod
    def get_latest(cls, source):
        return cls.objects.filter(source=source).order_by("-created_on").first()

    @property
    def type(self) -> HelpdeskImportType | None:
        return self.get_type(self.import_type)

    @property
    def is_finished(self) -> bool:
        return self.status in (self.STATUS_COMPLETE, self.STATUS_FAILED)

    def start_async(self):
        from .tasks import import_helpdesk_task

        on_transaction_commit(lambda: import_helpdesk_task.delay(self.id))

    def perform(self):
        """
        Does the import, in a worker. Whatever the outcome, what was lent for it is dropped.
        """
        assert self.status == self.STATUS_PENDING, "can only perform a pending import"

        imp_type = self.type

        self.status = self.STATUS_PROCESSING
        self.started_on = timezone.now()
        self.save(update_fields=("status", "started_on", "modified_on"))

        try:
            imp_type.perform(self)
        except HelpdeskImportError as e:
            self.status = self.STATUS_FAILED
            self.error = str(e)[:255]
        except Exception:  # pragma: no cover
            logger.exception("helpdesk import failed", extra={"import_id": self.id})
            self.status = self.STATUS_FAILED
            self.error = _("Something went wrong. Please try again later.")
        else:
            self.status = self.STATUS_COMPLETE

        secrets = imp_type.secret_config_keys if imp_type else ()
        self.config = {k: v for k, v in self.config.items() if k not in secrets}
        self.finished_on = timezone.now()
        self.save(update_fields=("status", "error", "config", "finished_on", "modified_on"))

        # a failed import keeps what it brought in before failing - and this is the one request for all of it, as the
        # article changes the import made don't request indexing themselves
        if self.status == self.STATUS_COMPLETE or self.num_imported > 0:
            self.source.mark_pending()

    def set_total(self, total: int):
        self.num_items = total
        self.save(update_fields=("num_items", "modified_on"))

    def advance(self):
        self.num_imported += 1
        self.save(update_fields=("num_imported", "modified_on"))

    def as_json(self) -> dict:
        return {
            "id": self.id,
            "status": self.STATUS_SLUGS[self.status],
            "created_on": self.created_on.isoformat(),
            "modified_on": self.modified_on.isoformat(),
            "progress": {"total": self.num_items, "current": self.num_imported},
            "error": self.error,
        }

    class Meta:
        indexes = [models.Index(name="helpdeskimport_by_created", fields=("source", "-created_on"))]


def get_knowledge_item_path(source, item_uuid, filename: str) -> str:
    return f"orgs/{source.org_id}/knowledge/{source.uuid}/{item_uuid}{Path(filename).suffix.lower()}"


class KnowledgeItem(models.Model):
    """
    One page or one uploaded document in an ingested knowledge source.

    Writers are split: this app creates document rows on upload (url null, path set); mailroom creates page rows as it
    crawls (url set) and owns status/error/num_chunks for both. A page's uuid is stable across recrawls because rows
    are matched by normalised url within the source - that's what makes incremental reindexing possible, since chunks
    key off that uuid.
    """

    ALLOWED_CONTENT_TYPES = (
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",  # .docx
        "text/csv",
        "text/markdown",
        "text/plain",
    )
    MAX_UPLOAD_SIZE = 1024 * 1024 * 20  # 20MB
    MAX_DOCUMENTS = 100  # per documents source

    STATUS_PENDING = "P"
    STATUS_INDEXING = "I"
    STATUS_READY = "R"
    STATUS_FAILED = "F"
    STATUS_CHOICES = (
        (STATUS_PENDING, _("Pending")),
        (STATUS_INDEXING, _("Indexing")),
        (STATUS_READY, _("Ready")),
        (STATUS_FAILED, _("Failed")),
    )

    uuid = models.UUIDField(unique=True, default=uuid4)
    source = models.ForeignKey(KnowledgeSource, on_delete=models.PROTECT, related_name="items")
    name = models.CharField(max_length=255)  # page title, or the cleaned original filename

    # null for uploads; the normalised page URL for crawled pages, and their identity within the source
    url = models.URLField(max_length=2048, null=True)

    # storage key: set for uploads (private bucket); optionally the cached extracted text for pages
    path = models.CharField(max_length=2048, null=True)

    content_type = models.CharField(max_length=255)  # mailroom sets text/html for pages
    size = models.IntegerField()  # bytes of the stored/fetched content

    # written by mailroom as it extracts and chunks
    status = models.CharField(max_length=1, choices=STATUS_CHOICES, default=STATUS_PENDING)
    error = models.CharField(max_length=255, null=True)
    num_chunks = models.IntegerField(default=0)

    created_by = models.ForeignKey(  # null for crawled pages - nobody uploaded them
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name="+"
    )
    created_on = models.DateTimeField(default=timezone.now)

    @classmethod
    def is_allowed_type(cls, content_type: str) -> bool:
        return content_type in cls.ALLOWED_CONTENT_TYPES

    @classmethod
    def clean_name(cls, filename: str) -> str:
        base_name, extension = os.path.splitext(filename)
        base_name = re.sub(r"[^\w\-\[\]\(\) ]", "", base_name).strip()[:200] or "file"
        return base_name + extension[:50]

    @classmethod
    def from_upload(cls, source, user, file):
        assert source.source_type == KnowledgeSource.TYPE_DOCUMENTS, "can only upload to documents knowledge"
        assert cls.is_allowed_type(file.content_type), "unsupported content type"

        uuid = uuid4()
        path = default_storage.save(get_knowledge_item_path(source, uuid, file.name), file)

        obj = cls.objects.create(
            uuid=uuid,
            source=source,
            name=cls.clean_name(file.name),
            url=None,  # explicit: this is what makes it a document rather than a page
            path=path,
            content_type=file.content_type,
            size=default_storage.size(path),
            created_by=user,
        )

        source.mark_pending()
        return obj

    @property
    def org(self):
        return self.source.org

    def delete(self):
        path = self.path

        with transaction.atomic():
            # this item's chunks are no longer valid - mailroom will recompute the source's counters
            delete_in_batches(self.source.chunks.filter(item_key=self.uuid))
            super().delete()
            self.source.mark_pending()

        # only remove the storage object once the deletion has committed - with ATOMIC_REQUESTS the atomic block above
        # is just a savepoint, so this has to wait for the request's transaction
        if path:
            on_transaction_commit(lambda: default_storage.delete(path))

    class Meta:
        constraints = [
            # a page's identity within its source. Postgres treats NULLs as distinct in a unique index, so uploaded
            # documents (url null) are exempt automatically - no partial-index condition needed, and any number of
            # documents can coexist in one source.
            models.UniqueConstraint("source", "url", name="unique_knowledge_item_urls"),
        ]


class KnowledgeChunk(models.Model):
    """
    A chunk of indexed content with its embedding. Rows are written exclusively by mailroom - this app never INSERTs
    or UPDATEs them. It only DELETEs them when the user deletes the owning item or source.
    """

    EMBEDDING_DIMENSIONS = 384  # intfloat/multilingual-e5-small

    source = models.ForeignKey(KnowledgeSource, on_delete=models.PROTECT, related_name="chunks")

    # the owning item's uuid. Not an FK, because the item lives in a different table per source type: KnowledgeItem
    # for pages/documents, Shortcut for shortcuts, Article for helpdesk. One mechanism spanning all four beats an FK
    # plus fallbacks.
    item_key = models.UUIDField()
    item_name = models.CharField(max_length=255)
    item_url = models.URLField(max_length=2048, null=True)

    text = models.TextField()
    embedding = VectorField(dimensions=EMBEDDING_DIMENSIONS)

    class Meta:
        indexes = [
            # a single ANN index shared by all orgs and sources - queries filtered by knowledge source rely on
            # pgvector >= 0.8 iterative scans (enforced by migration 0092) to return complete results
            HnswIndex(
                name="knowledgechunk_embedding",
                fields=["embedding"],
                m=16,
                ef_construction=64,
                opclasses=("vector_cosine_ops",),
            ),
            # lets mailroom replace one item's chunks on reindex, and lets us delete one item's chunks
            models.Index(name="knowledgechunk_by_item", fields=("source", "item_key")),
        ]
