"""
Tidies an imported article body into the layout an author would give it here: images on lines of their own, a
screenshot beside the text that explains it where the two balance, and notes set off as callouts. The layout is the
editor's own - the column tables and palette blocks it writes - so what the import makes is what the author would
have made, and can be taken apart again in the editor.
"""

import math
import re
from collections.abc import Callable

from .models import to_plain_text

# The measure the site gives an article - its column less the card's padding - and what a layout cell keeps back of
# it, in pixels. How much text a line of the site's body type holds, and how tall a line is, are estimates - they
# only have to say whether an image and its text come out about even.
ARTICLE_WIDTH = 596
CELL_PADDING = 16
CHAR_WIDTH = 7.5
LINE_HEIGHT = 28

# a screenshot is put beside its text only when both come out looking like they belong there
MIN_TEXT = 200  # an explainer this short leaves the image alone on its side
MAX_TEXT = 1200  # and one this long would tower over it
MIN_IMAGE_WIDTH = 350  # narrower than this is a crop or an icon, which is small enough where it is
MAX_ASPECT = 2.5  # wider than this is a banner, which wants the whole measure
LEGIBLE_SCALE = 0.3  # a screenshot shrunk further than this can't be read
LEGIBLE_WIDTH = 180
BALANCE = 0.4  # how far apart the two heights may be, as a share of the taller
TEXT_WIDTHS = (45, 55, 60, 70)  # the text column's share, the widths that have looked right by hand

# the palette entry callouts draw on - the first, which a site has before any other
CALLOUT_BACKGROUND = "1"
MAX_CALLOUT = 700

# what an image's size is asked of: its natural width and height, or nothing when it can't be had
Sizer = Callable[[str], tuple[int, int] | None]

IMAGE = re.compile(r"!\[(?P<alt>[^\]]*)\]\((?P<url>[^)\s]+)\)")
IMAGE_LINE = re.compile(rf"^{IMAGE.pattern}$")
IMAGE_SPLIT = re.compile(r"(!\[[^\]]*\]\([^)\s]+\))")  # the image kept, as the one group a split hands back
FENCE = re.compile(r"^\s{0,3}(```|~~~)")
HEADING = re.compile(r"^\s{0,3}#{1,6}\s")
LIST_ITEM = re.compile(r"^\s{0,3}(?:[-*+]|\d+[.)])\s+")
TABLE_ROW = re.compile(r"^\s{0,3}\|")
QUOTE = re.compile(r"^\s{0,3}>")
ROGUE = re.compile("[\u200b\u200c\u200d\u2060\ufeff]")
CALLOUT = re.compile(
    r"^[*_]{0,2}(?:note|notes|important|tip|tips|warning|please note|keep in mind|remember|reminder)[*_]{0,2}"
    "(?:\\s*[:!\\-\\u2013]|\\s+that\\b)",
    re.IGNORECASE,
)


def cleanup_body(body: str, sizer: Sizer) -> str:
    """
    The body tidied and laid out. The sizer says how big an image is, by its address, for deciding what goes beside
    what - an image it can't size is left where it is.
    """
    blocks = split_blocks(normalize(body))
    kinds = [kind_of(block) for block in blocks]
    out = []
    i = 0

    while i < len(blocks):
        block, kind = blocks[i], kinds[i]
        after = kinds[i + 1] if i + 1 < len(blocks) else None
        after_that = kinds[i + 2] if i + 2 < len(blocks) else None

        # an explainer followed by the screenshot it explains
        if kind in ("text", "step") and after == "image":
            widths = fit_beside(block, blocks[i + 1], sizer)
            if widths:
                out.append(columns(widths, cell(block), blocks[i + 1]))
                i += 2
                continue

        if kind == "image":
            # two screenshots in a row, when they come out even
            if after == "image":
                widths = fit_pair(block, blocks[i + 1], sizer)
                if widths:
                    out.append(columns(widths, block, blocks[i + 1]))
                    i += 2
                    continue

            # a screenshot followed by the text about it - as long as that text isn't the explainer of the next one
            if after in ("text", "step") and after_that != "image":
                widths = fit_beside(blocks[i + 1], block, sizer)
                if widths:
                    out.append(columns(widths, cell(blocks[i + 1]), block))
                    i += 2
                    continue

        if kind == "text" and CALLOUT.match(block) and len(block) <= MAX_CALLOUT:
            out.append(callout(cell(block)))
            i += 1
            continue

        out.append(block)
        i += 1

    return "\n\n".join(out)


def normalize(body: str) -> str:
    """
    The body with its whitespace put right: one kind of line ending, no characters that only look like spaces, no
    trailing spaces except the two that mean a line break before more text, and every image on a line of its own with
    a blank line either side of it. Fenced code is left exactly as it was.
    """
    body = body.replace("\r\n", "\n").replace("\r", "\n")
    body = ROGUE.sub("", body).replace("\xa0", " ")

    # each line trimmed, noting which ended in a hard break - two or more trailing spaces - and images given lines of
    # their own
    lines = []
    in_fence = False
    for line in body.split("\n"):
        if FENCE.match(line):
            in_fence = not in_fence
            lines.append((line.rstrip(), False))
            continue
        if in_fence or TABLE_ROW.match(line):
            lines.append((line, False))
            continue

        hard_break = line.endswith("  ")
        if IMAGE.search(line) and not IMAGE_LINE.match(line.strip()):
            pieces = [piece.strip() for piece in IMAGE_SPLIT.split(line) if piece.strip()]
            lines.extend((piece, hard_break and i == len(pieces) - 1) for i, piece in enumerate(pieces))
            continue

        lines.append((line.strip() if IMAGE_LINE.match(line.strip()) else line.rstrip(), hard_break))

    # a hard break means something before another line of text and nothing before a blank line or an image; the
    # images themselves get a blank line either side
    out = []
    in_fence = False
    for i, (line, hard_break) in enumerate(lines):
        if FENCE.match(line):
            in_fence = not in_fence
        if in_fence:
            out.append(line)
            continue

        is_image = bool(IMAGE_LINE.match(line))
        prev = out[-1] if out else ""
        nxt = lines[i + 1][0] if i + 1 < len(lines) else ""

        if is_image and prev.strip():
            out.append("")
        elif IMAGE_LINE.match(prev) and line.strip():
            out.append("")

        keep_break = hard_break and not is_image and line and nxt and not IMAGE_LINE.match(nxt)
        out.append(line + "  " if keep_break else line)

    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip("\n")


def split_blocks(text: str) -> list[str]:
    """
    The body as its blocks - what a blank line separates - except that a fenced code block is one block whatever
    blank lines it holds.
    """
    blocks = []
    current = []
    in_fence = False

    for line in text.split("\n"):
        if FENCE.match(line):
            in_fence = not in_fence
        if not line.strip() and not in_fence:
            if current:
                blocks.append("\n".join(current))
                current = []
            continue
        current.append(line)

    if current:
        blocks.append("\n".join(current))
    return blocks


def kind_of(block: str) -> str:
    """
    What a block is for laying out: an image on its own, a paragraph of text, a single step of a list - which can
    ride in a cell as the line of text it is - or something else, which stays as it is.
    """
    first = block.split("\n", 1)[0]
    if IMAGE_LINE.match(block.strip()):
        return "image"
    if FENCE.match(first) or HEADING.match(first) or TABLE_ROW.match(first) or QUOTE.match(first):
        return "other"
    if IMAGE.search(block):
        return "other"
    if LIST_ITEM.match(first):
        return "step" if "\n" not in block else "other"
    return "text"


def cell(block: str) -> str:
    """
    A block as the one line of markdown a cell holds: its line breaks as <br>s, its pipes escaped.
    """
    lines = [line.rstrip() for line in block.split("\n")]
    return "<br>".join(lines).replace("|", "\\|")


def columns(widths: tuple[int, int], left: str, right: str) -> str:
    return f"| width: {widths[0]}% | width: {widths[1]}% |\n| --- | --- |\n| {left} | {right} |"


def callout(text: str) -> str:
    return f"| background: {CALLOUT_BACKGROUND} |\n| --- |\n| {text} |"


def image_url(block: str) -> str:
    return IMAGE_LINE.match(block.strip())["url"]


def fit_beside(text: str, image: str, sizer: Sizer) -> tuple[int, int] | None:
    """
    The column widths, text then image, that put the text beside the image with the two about as tall - or nothing,
    when no widths do: the text is too short or too long for it, the image is a banner or a crop, or it can't be
    shrunk to fit beside anything and still be read.
    """
    length = len(to_plain_text(text))
    if not MIN_TEXT <= length <= MAX_TEXT:
        return None

    size = _size(image, sizer)
    if not size:
        return None
    natural_w, natural_h = size
    aspect = natural_w / natural_h
    breaks = text.count("\n")

    best = None
    for text_pct in TEXT_WIDTHS:
        image_pct = 100 - text_pct
        shown_w = min(natural_w, _content_width(image_pct))
        if shown_w < max(LEGIBLE_WIDTH, LEGIBLE_SCALE * natural_w):
            continue

        image_h = shown_w / aspect
        chars_per_line = _content_width(text_pct) / CHAR_WIDTH
        text_h = (math.ceil(length / chars_per_line) + breaks) * LINE_HEIGHT
        apart = abs(image_h - text_h) / max(image_h, text_h)
        if best is None or apart < best[0]:
            best = (apart, text_pct)

    if best and best[0] <= BALANCE:
        return best[1], 100 - best[1]
    return None


def fit_pair(first: str, second: str, sizer: Sizer) -> tuple[int, int] | None:
    """
    The column widths that put two screenshots side by side at about the same height - or nothing, when either is a
    banner or a crop, or the two can't share the measure and both be read.
    """
    sizes = _size(first, sizer), _size(second, sizer)
    if not all(sizes):
        return None
    aspects = [w / h for w, h in sizes]

    # Widths in the ratio of the aspects come out at the same height. Aspects far enough apart to want one column
    # narrower than the measure can show legibly are refused below, so the clamp only keeps the widths sensible.
    first_pct = round(100 * aspects[0] / (aspects[0] + aspects[1]))
    first_pct = max(30, min(70, first_pct))
    widths = (first_pct, 100 - first_pct)

    for (natural_w, _), pct in zip(sizes, widths):
        shown_w = min(natural_w, _content_width(pct))
        if shown_w < max(LEGIBLE_WIDTH, LEGIBLE_SCALE * natural_w):
            return None
    return widths


def _size(image: str, sizer: Sizer) -> tuple[int, int] | None:
    size = sizer(image_url(image).split("#", 1)[0])
    if not size or not all(size):
        return None
    natural_w, natural_h = size
    if natural_w < MIN_IMAGE_WIDTH or natural_w / natural_h > MAX_ASPECT:
        return None
    return size


def _content_width(pct: int) -> float:
    return ARTICLE_WIDTH * pct / 100 - 2 * CELL_PADDING
