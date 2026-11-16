import json
import re
from datetime import timezone as tzone

from django import forms
from django.db.models.utils import get_blank_choice_label
from django.template.defaultfilters import register
from django.urls import reverse
from django.utils.html import escape, escapejs
from django.utils.safestring import mark_safe
from django.utils.translation import gettext_lazy as _

from temba.campaigns.models import Campaign, CampaignEvent
from temba.contacts.models import ContactGroup
from temba.flows.models import Flow
from temba.triggers.models import Trigger
from temba.utils.dates import datetime_to_str
from temba.utils.text import unsnakify

OBJECT_URLS = {
    Flow: lambda o: reverse("flows.flow_editor", args=[o.uuid]),
    Campaign: lambda o: reverse("campaigns.campaign_read", args=[o.uuid]),
    CampaignEvent: lambda o: reverse("campaigns.campaign_read", args=[o.uuid]),
    ContactGroup: lambda o: reverse("contacts.contact_group", args=[o.uuid]),
    Trigger: lambda o: reverse("triggers.trigger_list"),
}


@register.filter
def object_class_name(obj):
    return obj.__class__.__name__


@register.filter
def oxford(forloop, conjunction=_("and")):
    """
    Filter for use in a forloop to join items using oxford commas and a conjunction.
    """
    # there are only two items
    if forloop["counter"] == 1 and forloop["revcounter"] == 2:
        return f" {conjunction} "

    # we are the last in a list of 3 or more
    if forloop["revcounter"] == 2:
        return f", {conjunction} "

    if not forloop["last"]:
        return ", "

    return ""


@register.filter
def unsnake(str):
    return unsnakify(str)


@register.filter
def object_url(o):
    assert type(o) in OBJECT_URLS

    return OBJECT_URLS[type(o)](o)


@register.filter
def verbose_name_plural(object):
    return object._meta.verbose_name_plural


@register.simple_tag()
def annotated_field(field, label, help_text):
    attrs = field.field.widget.attrs
    attrs["label"] = label
    attrs["help_text"] = help_text
    attrs["errors"] = json.dumps([str(error) for error in field.errors])
    attrs.setdefault(
        "optional",
        bool(str(label).strip())
        and _is_optional(field)
        # in a form where nothing is required, marking every field says nothing
        and any(_is_required(f) for f in field.form.visible_fields()),
    )
    return field.as_widget(attrs=attrs)


def _is_required(field) -> bool:
    return field.field.required and not isinstance(field.field.widget, forms.CheckboxInput)


def _is_optional(field) -> bool:
    """
    Whether a field can be left empty and should say so. Widgets can opt out with an optional=False attr, e.g. for
    fields that are required only in some cases.
    """
    f = field.field
    if f.required or isinstance(f.widget, forms.CheckboxInput):
        return False

    # a select whose empty choice has a real name, e.g. "Unassigned", always shows a value
    blank_labels = ("---------", get_blank_choice_label())
    if isinstance(f, forms.ModelChoiceField):
        return f.empty_label is None or f.empty_label in blank_labels
    if isinstance(f, forms.ChoiceField):
        return not any(value in ("", None) and label not in blank_labels for value, label in f.choices)

    return True


@register.filter
def to_json(value):
    """
    To use a python variable in JS, we call json.dumps to serialize as JSON server-side and reconstruct using
    JSON.parse. The serialized string must be escaped appropriately before dumping into the client-side code.

    https://stackoverflow.com/a/14290542
    """
    if not isinstance(value, str):
        raise ValueError(f"Expected str got {type(value)} for to_json")

    escaped_output = escapejs(value)

    return mark_safe(f'JSON.parse("{escaped_output}")')


@register.filter
def pretty_json(value):
    """
    Pretty-prints a value as indented JSON for display, e.g. flow start params.
    """
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False)


@register.filter
def day(date):
    return _date_component(date, "date")


@register.filter
def duration(date):
    return _date_component(date, "duration")


@register.filter
def datetime(date):
    return _date_component(date, "datetime")


@register.filter
def timedate(date):
    return _date_component(date, "timedate")


def _date_component(date, display: str):
    value = date if isinstance(date, str) else date.isoformat()
    return mark_safe(f'<temba-date value="{value}" display="{display}"></temba-date>')


@register.simple_tag(takes_context=True)
def format_datetime(context, dt, seconds: bool = False):
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tzone.utc)

    tz = tzone.utc
    org = context.get("user_org")
    if org:
        tz = org.timezone
    dt = dt.astimezone(tz)

    if org:
        return org.format_datetime(dt, seconds=seconds)

    fmt = "%d-%m-%Y %H:%M:%S" if seconds else "%d-%m-%Y %H:%M"
    return datetime_to_str(dt, fmt, tz)


@register.simple_tag(takes_context=True)
def absolute_url(context, url_pattern):
    request = context["request"]
    return request.build_absolute_uri(reverse(url_pattern))


@register.filter
def sparkline(values) -> str:
    """
    Renders a series of numbers as a dashboard card's sparkline: a filled area, its line and a dot on the latest value.
    Its color comes from the card it's in.
    """
    values = list(values or [])
    if len(values) < 2:
        return ""

    width, height = 160, 30
    top = max(max(values), 1)
    step = width / (len(values) - 1)
    points = [(i * step, height - 3 - (v / top) * (height - 6)) for i, v in enumerate(values)]
    line = " ".join(f"{'L' if i else 'M'}{x:.1f} {y:.1f}" for i, (x, y) in enumerate(points))
    last_x, last_y = points[-1]

    return mark_safe(
        f'<svg class="dash-spark" viewBox="0 0 {width} {height}" preserveAspectRatio="none" aria-hidden="true">'
        f'<path class="area" d="{line} L{width} {height} L0 {height} Z"></path>'
        f'<path class="line" d="{line}"></path>'
        f'<circle class="end" cx="{last_x:.1f}" cy="{last_y:.1f}" r="2.4"></circle>'
        "</svg>"
    )


@register.filter
def http_method(request: str) -> str:
    """
    The method of a logged HTTP request, from its first line, e.g. "POST"
    """
    first = (request or "").split(" ", 1)[0]
    return first if first.isalpha() and first.isupper() else ""


_HTTP_JSON_TOKEN = re.compile(r'("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b')
_HTTP_FORM = re.compile(r"^[^\s=&]+=[^\s&]*(?:&[^\s=&]+=[^\s&]*)*$")


def _span(cls: str, text: str) -> str:
    return f'<span class="hl-{cls}">{escape(text)}</span>'


def _highlight_http_head(head: str) -> str:
    lines = head.split("\n")
    out = []
    for i, line in enumerate(lines):
        bare = line.rstrip("\r")
        if i == 0:
            parts = bare.split(" ", 2)
            if bare.startswith("HTTP/") and len(parts) >= 2:
                # a response's status line, e.g. HTTP/1.1 200 OK
                out.append(" ".join([_span("dim", parts[0]), _span("status", " ".join(parts[1:]))]))
                continue
            if len(parts) == 3 and parts[0].isalpha() and parts[0].isupper():
                # a request line, e.g. POST /send HTTP/1.1
                out.append(" ".join([_span("method", parts[0]), escape(parts[1]), _span("dim", parts[2])]))
                continue
        name, sep, value = bare.partition(":")
        if sep and name and " " not in name:
            out.append(f"{_span('key', name)}:{escape(value)}")
        else:
            out.append(escape(bare))
    return "\n".join(out)


def _highlight_http_body(body: str) -> str:
    stripped = body.strip()

    if stripped[:1] in ("{", "["):

        def token(m):
            string, colon, number, literal = m.groups()
            if string is not None:
                return _span("key" if colon else "str", string) + (colon or "")
            if number is not None:
                return _span("num", number)
            return _span("lit", literal)

        out, last = [], 0
        for m in _HTTP_JSON_TOKEN.finditer(body):
            out.append(escape(body[last : m.start()]))
            out.append(token(m))
            last = m.end()
        out.append(escape(body[last:]))
        return "".join(out)

    if _HTTP_FORM.match(stripped):
        pairs = []
        for pair in stripped.split("&"):
            key, _, value = pair.partition("=")
            pairs.append(f"{_span('key', key)}={_span('str', value)}")
        return body[: len(body) - len(body.lstrip())] + "&amp;".join(pairs)

    return escape(body)


@register.filter
def http_highlight(text: str) -> str:
    """
    Lightly highlights a logged HTTP request or response: its request or status line, its header names, and the keys,
    strings, numbers and literals of a JSON or form-encoded body. Everything is escaped.
    """
    text = text or ""
    match = re.search(r"\r?\n\r?\n", text)
    if not match:
        # just a head, or just a body (e.g. a request logged without its headers)
        looks_like_head = text.startswith("HTTP/") or re.match(r"^[A-Z]+ \S+ HTTP/", text)
        return mark_safe(_highlight_http_head(text) if looks_like_head else _highlight_http_body(text))

    head, sep, body = text[: match.start()], text[match.start() : match.end()], text[match.end() :]
    return mark_safe(_highlight_http_head(head) + escape(sep) + _highlight_http_body(body))
