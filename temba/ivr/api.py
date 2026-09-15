from temba.api.internal.serializers import ModelAsJsonSerializer
from temba.api.internal.views import BaseEndpoint
from temba.api.support import CreatedOnCursorPagination
from temba.api.views import ListAPIMixin
from temba.msgs.models import MsgFolder

from .models import Call


class CallsEndpoint(ListAPIMixin, BaseEndpoint):
    """
    Calls for the current org, newest first, used by the call list component. Each item is serialized via
    Call.as_json().
    """

    class Pagination(CreatedOnCursorPagination):
        """
        Pages by `-created_on, -id` which is what the `calls_org_created_on` index is ordered by. The response always
        carries a `count` so the list UI can show a total - the pre-calculated count also shown in the menu rather
        than a COUNT(*) on the calls table.
        """

        # DRF's CursorPagination ignores `?page_size=` unless the subclass opts in. The list component sends
        # `page_size` to size each request to the visible viewport, so honor it with a cap.
        page_size = 50
        page_size_query_param = "page_size"
        max_page_size = 500

        def paginate_queryset(self, queryset, request, view=None):
            self._count = MsgFolder.get_counts(request.org)["calls"]
            return super().paginate_queryset(queryset, request, view)

        def get_paginated_response(self, data):
            response = super().get_paginated_response(data)
            response.data["count"] = self._count
            return response

    model = Call
    serializer_class = ModelAsJsonSerializer
    pagination_class = Pagination

    def derive_queryset(self):
        # `org` is select_related because as_json reads self.org for anonymized contact display
        return Call.objects.filter(org=self.request.org).select_related("org", "contact", "contact_urn", "channel")

    def filter_queryset(self, queryset):
        return queryset
