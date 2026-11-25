from datetime import timedelta

from django.db.models import Q
from django.http import HttpResponse
from django.utils import timezone

from temba.api.internal.serializers import ModelAsJsonSerializer
from temba.api.internal.views import BaseEndpoint
from temba.api.support import CreatedOnCursorPagination, SearchCountMixin, SentOnCursorPagination
from temba.api.views import ListAPIMixin

from .models import Msg, MsgFolder


class MessagesEndpoint(ListAPIMixin, BaseEndpoint):
    """
    Messages for the current org, used by the message list components. A folder is selected with the `folder` query
    param (one of `inbox`, `handled`, `archived`, `outbox`, `sent` or `failed`, defaulting to `inbox`) — alternatively
    pass `label=<uuid>` to filter by a user-defined label. An optional `search` param filters by message text or
    contact name. Each item is serialized via Msg.as_json().
    """

    class Pagination(SearchCountMixin, CreatedOnCursorPagination):
        """
        The sent folder is ordered by sent date; all other folders by UUID, which (since msg.uuid is uuid7) is itself
        time-ordered and already uniquely indexed — so we get the same newest-first semantics as `-created_on, -id`
        without the composite sort. The response always carries a `count` so the list UI can show "N of Total": a
        search count via SearchCountMixin, otherwise the folder/label's cheap pre-calculated count (see
        `get_total_count`) — never a COUNT(*) on the messages table.
        """

        # DRF's CursorPagination ignores `?page_size=` unless the subclass opts in. The list component sends
        # `page_size` to size each request to the visible viewport, so honor it — with a default that matches the
        # component's own default and a cap that keeps a hostile/oversized client request from pulling 50k rows.
        page_size = 50
        page_size_query_param = "page_size"
        max_page_size = 500

        ordering = ("-uuid",)

        def get_ordering(self, request, queryset, view=None):
            if request.query_params.get("folder", "").lower() == "sent":
                return SentOnCursorPagination.ordering
            return self.ordering

        def paginate_queryset(self, queryset, request, view=None):
            page = super().paginate_queryset(queryset, request, view)
            # SearchCountMixin sets _search_count on a search; otherwise fall back to the folder/label's cheap
            # pre-calculated count so the list always has a total to show.
            if getattr(self, "_search_count", None) is None and view is not None:
                self._search_count = view.get_total_count()
            return page

    # Match BaseListView's caps so the legacy and new lists impose the same bounds: a search query is capped at 1000
    # chars (rejected with 413) and is restricted to messages from the last 90 days so an unbounded `text__icontains`
    # scan (compounded by the SearchCountMixin COUNT(*)) can't be triggered by a session-authenticated client.
    SEARCH_MAX_LENGTH = 1_000
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

    def get(self, request, *args, **kwargs):
        search = request.query_params.get("search") or ""
        if len(search) > self.SEARCH_MAX_LENGTH:
            return HttpResponse("Search query too long", status=413)
        return super().get(request, *args, **kwargs)

    def get_total_count(self) -> int:
        # Cheap pre-calculated total for the active folder/label (squashed count tables) — used as the list's total
        # when there's no search, avoiding a COUNT(*) on the messages table.
        org = self.request.org
        label_uuid = self.request.query_params.get("label")
        if label_uuid:
            label = org.msgs_labels.filter(uuid=label_uuid).first()
            return label.get_visible_count() if label else 0

        folder = self.FOLDERS.get(self.request.query_params.get("folder", "inbox").lower())
        if not folder:
            return 0
        return MsgFolder.get_counts(org).get(folder, 0)

    def derive_queryset(self):
        # `label` takes precedence — the filter view passes a label UUID rather than a folder name, and the visible
        # messages for that label aren't a MsgFolder slice.
        # `org` and `channel` are select_related because Msg.as_json reads self.org (for contact display) and
        # self.channel.is_active/uuid (for the channel-log link gated on the channels.channel_logs perm).
        label_uuid = self.request.query_params.get("label")
        if label_uuid:
            label = self.request.org.msgs_labels.filter(uuid=label_uuid).first()
            if not label:
                return Msg.objects.none()
            return (
                Msg.objects.filter(org=self.request.org, labels=label, visibility=Msg.VISIBILITY_VISIBLE)
                .select_related("contact", "channel", "flow", "org")
                .prefetch_related("labels")
            )

        folder = self.FOLDERS.get(self.request.query_params.get("folder", "inbox").lower())
        if not folder:
            return Msg.objects.none()

        return (
            folder.get_queryset(self.request.org)
            .select_related("contact", "channel", "flow", "org")
            .prefetch_related("labels")
        )

    def filter_queryset(self, queryset):
        search = self.request.query_params.get("search")
        if search:
            queryset = queryset.filter(
                Q(created_on__gte=timezone.now() - self.SEARCH_WINDOW)
                & (Q(text__icontains=search) | Q(contact__name__icontains=search))
            )

        return queryset
