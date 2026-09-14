from datetime import timedelta
from functools import cached_property

from django.db.models import Q, TextField
from django.db.models.expressions import RawSQL
from django.db.models.functions import Cast
from django.utils import timezone

from temba.api.internal.serializers import ModelAsJsonSerializer
from temba.api.internal.views import BaseEndpoint
from temba.api.support import (
    CreatedOnCursorPagination,
    ListPagination,
    SearchCountMixin,
    SearchLengthMixin,
    UUIDCursorPagination,
)
from temba.api.views import ListAPIMixin
from temba.utils.uuid import is_uuid

from .models import Broadcast, BroadcastMsgCount, Msg, MsgFolder


class BroadcastsEndpoint(SearchLengthMixin, ListAPIMixin, BaseEndpoint):
    """
    Broadcasts for the current org, used by the broadcast list component. A folder is selected with the `folder`
    query param — `sent` (the default: broadcasts without a schedule) or `scheduled` (broadcasts waiting on one).
    An optional `search` param filters by message text, and `sort` can be `created_on` or `next_fire`
    (scheduled only), prefixed with `-` to reverse. Each item is serialized via Broadcast.as_json().
    """

    model = Broadcast
    serializer_class = ModelAsJsonSerializer
    pagination_class = ListPagination

    def derive_queryset(self):
        # Build from Broadcast.objects rather than the org.broadcasts related manager — a related manager would seed
        # each fetched row with the in-memory org instance, which Django rejects on a GET because the org was loaded
        # from the default database while this queryset reads from the readonly alias.
        qs = Broadcast.objects.filter(org=self.request.org, is_active=True)

        scheduled = self.request.query_params.get("folder", "sent").lower() == "scheduled"
        if scheduled:
            qs = qs.exclude(schedule=None)
            default_order = ("schedule__next_fire", "-created_on")
        else:
            qs = qs.filter(schedule=None)
            default_order = ("-created_on",)

        search = self.request.query_params.get("search")
        if search:
            # broadcast text lives inside the translations JSON, so search over just the per-language text values
            # (extracted with a jsonpath) rather than a raw cast of the JSON — a raw cast would also match its
            # structure (keys like "text", language codes). Broadcasts are a small per-org table, unlike messages,
            # so the scan is acceptable.
            qs = qs.annotate(
                translations_text=Cast(
                    RawSQL("jsonb_path_query_array(translations, '$.*.text')", []), output_field=TextField()
                )
            ).filter(translations_text__icontains=search)

        sort = self.request.query_params.get("sort") or ""
        desc = sort.startswith("-")
        key = sort[1:] if desc else sort

        if key == "created_on":
            order = ("-created_on" if desc else "created_on",)
        elif key == "next_fire" and scheduled:
            order = ("-schedule__next_fire" if desc else "schedule__next_fire",)
        else:
            order = default_order

        # `org` is select_related because as_json reads self.org via get_translation (org primary language)
        return (
            qs.order_by(*order, "-id")
            .select_related("org", "schedule", "template", "created_by")
            .prefetch_related("groups", "contacts")
        )

    def filter_queryset(self, queryset):
        # filtering (folder/search/sort) is fully resolved in derive_queryset; bypass the default backends
        return queryset

    def prepare_for_serialization(self, page, using: str):
        # bulk-load the created-message counts for the page so as_json doesn't N+1
        BroadcastMsgCount.bulk_annotate(page)


class MessagesEndpoint(SearchLengthMixin, ListAPIMixin, BaseEndpoint):
    """
    Messages for the current org, used by the message list components. A folder is selected with the `folder` query
    param (one of `inbox`, `handled`, `archived`, `outbox`, `sent` or `failed`, defaulting to `inbox`) — alternatively
    pass `label=<uuid>` to filter by a user-defined label. An optional `search` param filters by message text or
    contact name. Each item is serialized via Msg.as_json().
    """

    class Pagination(SearchCountMixin, CreatedOnCursorPagination):
        """
        Folders are paged by `-uuid`, which is what the folder index (`msgs_by_folder`, see Msg.Meta.indexes) is
        keyed on and time ordered as message uuids are v7, so a page is an index-ordered read rather than a sort.
        Labels are paged by `-created_on, -id`. The response always carries a `count` so the list UI can show a
        total: a search count via SearchCountMixin, otherwise the folder/label's cheap pre-calculated count (see
        `get_total_count`) — never a COUNT(*) on the messages table.
        """

        # DRF's CursorPagination ignores `?page_size=` unless the subclass opts in. The list component sends
        # `page_size` to size each request to the visible viewport, so honor it — with a default that matches the
        # component's own default and a cap that keeps a hostile/oversized client request from pulling 50k rows.
        page_size = 50
        page_size_query_param = "page_size"
        max_page_size = 500

        def get_ordering(self, request, queryset, view=None):
            return UUIDCursorPagination.ordering if view.folder else self.ordering

        def paginate_queryset(self, queryset, request, view=None):
            page = super().paginate_queryset(queryset, request, view)
            # SearchCountMixin sets _search_count on a search; otherwise fall back to the folder/label's cheap
            # pre-calculated count so the list always has a total to show.
            if getattr(self, "_search_count", None) is None and view is not None:
                self._search_count = view.get_total_count()
            return page

    # A search is restricted to messages from the last 90 days so an unbounded `text__icontains` scan (compounded by
    # the SearchCountMixin COUNT(*)) can't be triggered by a session-authenticated client.
    SEARCH_WINDOW = timedelta(days=90)

    FOLDERS = {
        "inbox": MsgFolder.INBOX,
        "handled": MsgFolder.HANDLED,
        "archived": MsgFolder.ARCHIVED,
        "outbox": MsgFolder.OUTBOX,
        "sent": MsgFolder.SENT,
        "failed": MsgFolder.FAILED,
    }

    model = Msg
    serializer_class = ModelAsJsonSerializer
    pagination_class = Pagination

    @cached_property
    def label(self):
        """
        The label referenced by the `label` query param, or None if it's malformed or not a label in the current
        org. Validated before the lookup — an unparseable value would otherwise raise in the database's UUID
        coercion (500). Mirrors FlowsEndpoint's label guard. Cached because it's read by both derive_queryset and
        get_total_count on the same request.
        """
        label_uuid = self.request.query_params.get("label")
        if not label_uuid or not is_uuid(label_uuid):
            return None
        return self.request.org.msgs_labels.filter(uuid=label_uuid).first()

    @cached_property
    def folder(self):
        """
        The folder selected by the `folder` param (defaulting to inbox), or None if a label is selected instead or
        the folder isn't valid.
        """
        if self.request.query_params.get("label"):
            return None
        return self.FOLDERS.get(self.request.query_params.get("folder", "inbox").lower())

    def get_total_count(self) -> int:
        # Cheap pre-calculated total for the active folder/label (squashed count tables) — used as the list's total
        # when there's no search, avoiding a COUNT(*) on the messages table.
        org = self.request.org
        if self.request.query_params.get("label"):
            return self.label.get_message_count() if self.label else 0

        return MsgFolder.get_counts(org).get(self.folder, 0) if self.folder else 0

    def derive_queryset(self):
        # `label` takes precedence — the filter view passes a label UUID rather than a folder name, and a label's
        # messages aren't a MsgFolder slice: they're listed whatever folder they're in (archived included), which is
        # why the filter view offers no folder-dependent bulk actions. Deleted messages lose their labellings, but
        # are excluded explicitly too.
        # `org` and `channel` are select_related because Msg.as_json reads self.org (for contact display) and
        # self.channel.is_active/uuid (for the channel-log link gated on the channels.channel_logs perm).
        if self.request.query_params.get("label"):
            label = self.label
            if not label:
                return Msg.objects.none()
            return (
                Msg.objects.filter(org=self.request.org, labels=label)
                .exclude(folder=Msg.FOLDER_DELETED)
                .select_related("contact", "channel", "flow", "org")
                .prefetch_related("labels")
            )

        if not self.folder:
            return Msg.objects.none()

        # a search's window is passed to the folder as a uuid bound so that it's a condition on the folder index
        # rather than something checked on every row the search then has to scan - filter_queryset makes it exact
        return (
            self.folder.get_queryset(self.request.org, after=self.search_since)
            .select_related("contact", "channel", "flow", "org")
            .prefetch_related("labels")
        )

    @cached_property
    def search_since(self):
        """
        The start of the search window if this request is a search, or None if it isn't
        """
        return timezone.now() - self.SEARCH_WINDOW if self.request.query_params.get("search") else None

    def filter_queryset(self, queryset):
        search = self.request.query_params.get("search")
        if search:
            queryset = queryset.filter(
                Q(created_on__gte=self.search_since) & (Q(text__icontains=search) | Q(contact__name__icontains=search))
            )

        return queryset
