from urllib.parse import urlencode
from uuid import UUID

from rest_framework.response import Response

from django.db.models import Case, IntegerField, Q, Value, When
from django.db.models.functions import Lower
from django.http import Http404
from django.urls import reverse

from temba.api.internal.serializers import ModelAsJsonSerializer
from temba.api.internal.views import BaseEndpoint
from temba.api.support import ListPagination, SearchLengthMixin
from temba.api.views import ListAPIMixin

from .models import Channel, ChannelLog


class ChannelsEndpoint(SearchLengthMixin, ListAPIMixin, BaseEndpoint):
    """
    Channels for the current org, used by the channel list component. Enabled channels come first, then by name. An
    optional `search` param filters by name or address. Each item is serialized via Channel.as_json() (name, type,
    address, slowness, message counts and activity sparkline).
    """

    model = Channel
    serializer_class = ModelAsJsonSerializer
    pagination_class = ListPagination

    def derive_queryset(self):
        # Build from Channel.objects rather than the org.channels related manager - see FlowsEndpoint.derive_queryset
        qs = Channel.objects.filter(org=self.request.org, is_active=True)

        search = self.request.query_params.get("search")
        if search:
            qs = qs.filter(Q(name__icontains=search) | Q(address__icontains=search))

        disabled_last = Case(When(is_enabled=True, then=Value(0)), default=Value(1), output_field=IntegerField())
        return qs.order_by(disabled_last, Lower("name"), "id")

    def filter_queryset(self, queryset):
        # filtering is fully resolved in derive_queryset; bypass the default backends
        return queryset

    def get_serializer_context(self):
        context = super().get_serializer_context()

        # slow channels only hold up workspaces big enough to notice, so smaller ones aren't told about them
        context["show_speed"] = self.request.org.get_contact_count() > Channel.SPEED_MIN_CONTACTS
        return context

    def prepare_for_serialization(self, page, using: str):
        # bulk-load the daily counts for the page so as_json doesn't N+1
        Channel.prefetch_activity_series(page)


class ChannelLogsEndpoint(BaseEndpoint):
    """
    A channel's logs, newest first, used by the channel log list component. The `channel` param is the channel's UUID.
    Logs live in DynamoDB rather than the database, so this pages them itself by the UUID of the last log on a page,
    returning a cursor shaped response with `next` and `previous` URLs to follow.
    """

    model = Channel  # only for the org scoping - the logs themselves aren't models
    permission = "channels.channel_logs"
    page_size = 50

    def get(self, request, *args, **kwargs):
        channel = self.get_channel()
        after = self.get_after()

        logs, prev_after, next_after = ChannelLog.get_by_channel(channel, limit=self.page_size, after_uuid=after)

        return Response(
            {
                "results": [self.serialize(channel, log) for log in logs],
                "next": self.page_url(channel, next_after) if next_after else None,
                # the first page has no `after`, so a previous page without one is still a page to go back to
                "previous": self.page_url(channel, prev_after) if after else None,
                "paged_by": "cursor",
            }
        )

    def get_channel(self) -> Channel:
        try:
            uuid = UUID(self.request.query_params.get("channel", ""))
        except ValueError:
            raise Http404()

        channel = Channel.objects.filter(org=self.request.org, uuid=uuid, is_active=True).first()
        if not channel or not channel.type.has_logs:
            raise Http404()
        return channel

    def get_after(self) -> UUID | None:
        after = self.request.query_params.get("after")
        if not after:
            return None
        try:
            return UUID(after)
        except ValueError:
            raise Http404()

    def page_url(self, channel, after) -> str:
        params = {"channel": str(channel.uuid)}
        if after:
            params["after"] = str(after)
        return f"{reverse('api.internal.channel_logs')}.json?{urlencode(params)}"

    @staticmethod
    def serialize(channel, log) -> dict:
        return {
            "uuid": str(log.uuid),
            "type": log.log_type,
            "type_display": str(log.get_log_type_display()),
            "is_error": log.is_error,
            "elapsed_ms": log.elapsed_ms,
            "created_on": log.created_on.isoformat(),
            "url": reverse("channels.channel_logs_read", args=[channel.uuid, "log", log.uuid]),
        }


class ChannelHTTPLogsEndpoint(BaseEndpoint):
    """
    The HTTP logs of a channel's syncs with its provider, e.g. of its templates, newest first, used by the log list
    component. The `channel` param is the channel's UUID. Paged by the id of the last log on a page, returning a cursor
    shaped response like the channel logs endpoint, so the same component lists both.
    """

    model = Channel  # only for the org scoping
    permission = "request_logs.httplog_list"
    page_size = 50

    def get(self, request, *args, **kwargs):
        from temba.request_logs.models import HTTPLog

        channel = self.get_channel()
        before = self.get_before()

        logs = HTTPLog.objects.filter(channel=channel).order_by("-id")
        if before:
            logs = logs.filter(id__lt=before)
        page = list(logs.only("id", "log_type", "is_error", "request_time", "created_on")[: self.page_size + 1])
        more = len(page) > self.page_size
        page = page[: self.page_size]

        return Response(
            {
                "results": [self.serialize(log) for log in page],
                "next": self.page_url(channel, page[-1].id) if more else None,
                "previous": None,
                "paged_by": "cursor",
            }
        )

    def get_channel(self) -> Channel:
        try:
            uuid = UUID(self.request.query_params.get("channel", ""))
        except ValueError:
            raise Http404()

        channel = Channel.objects.filter(org=self.request.org, uuid=uuid, is_active=True).first()
        if not channel or not channel.type.template_type:
            raise Http404()
        return channel

    def get_before(self) -> int | None:
        before = self.request.query_params.get("before")
        if not before:
            return None
        try:
            return int(before)
        except ValueError:
            raise Http404()

    def page_url(self, channel, before: int) -> str:
        params = {"channel": str(channel.uuid), "before": str(before)}
        return f"{reverse('api.internal.channel_http_logs')}.json?{urlencode(params)}"

    @staticmethod
    def serialize(log) -> dict:
        return {
            "uuid": str(log.id),
            "type_display": str(log.get_log_type_display()),
            "is_error": log.is_error,
            "elapsed_ms": log.request_time,
            "created_on": log.created_on.isoformat(),
            "url": reverse("request_logs.httplog_read", args=[log.id]),
        }
