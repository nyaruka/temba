from django.db.models import Count, Q, Sum, Value
from django.db.models.functions import Coalesce, Lower

from temba.api.internal.serializers import ModelAsJsonSerializer
from temba.api.internal.views import BaseEndpoint
from temba.api.support import ListPagination, SearchLengthMixin
from temba.api.views import ListAPIMixin

from .models import Campaign


class CampaignsEndpoint(SearchLengthMixin, ListAPIMixin, BaseEndpoint):
    """
    Campaigns for the current org, used by the campaign list component. A folder is selected with the `folder` query
    param (`active` (default) or `archived`). An optional `search` param filters by campaign or group name, and
    `sort` can be `name`, `events`, `contacts` or `modified_on` (prefix with `-` to reverse). Each item is
    serialized via Campaign.as_json() (name, group, event / group-member counts).
    """

    model = Campaign
    serializer_class = ModelAsJsonSerializer
    pagination_class = ListPagination

    def derive_queryset(self):
        org = self.request.org
        qs = Campaign.objects.filter(org=org, is_active=True)

        if self.request.query_params.get("folder", "active").lower() == "archived":
            qs = qs.filter(is_archived=True)
        else:
            qs = qs.filter(is_archived=False)

        search = self.request.query_params.get("search")
        if search:
            # match the list view's search_fields (campaign name or group name)
            qs = qs.filter(Q(name__icontains=search) | Q(group__name__icontains=search))

        sort = self.request.query_params.get("sort") or ""
        desc = sort.startswith("-")
        key = sort[1:] if desc else sort

        if key == "name":
            order = Lower("name").desc() if desc else Lower("name").asc()
        elif key == "events":
            # annotate so the database can order by the count of active events
            qs = qs.annotate(sort_count=Count("events", filter=Q(events__is_active=True)))
            order = "-sort_count" if desc else "sort_count"
        elif key == "contacts":
            # the group's member count is the sum of its unsquashed count rows
            qs = qs.annotate(sort_count=Coalesce(Sum("group__counts__count"), Value(0)))
            order = "-sort_count" if desc else "sort_count"
        elif key == "modified_on":
            order = "-modified_on" if desc else "modified_on"
        else:
            order = "-modified_on"  # match BaseList.default_order

        return qs.order_by(order, "-id").select_related("group")

    def filter_queryset(self, queryset):
        # filtering (folder/search/sort) is fully resolved in derive_queryset; bypass the default backends
        return queryset

    def prepare_for_serialization(self, page, using: str):
        # bulk-load the event and group-member counts for the page so as_json doesn't N+1
        Campaign.prefetch_list_counts(page, using=using)
