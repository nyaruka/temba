from django.db.models import Q, Sum, Value
from django.db.models.functions import Coalesce, Lower

from temba.api.internal.serializers import ModelAsJsonSerializer
from temba.api.internal.views import BaseEndpoint
from temba.api.support import ListPagination, NameCursorPagination, SearchLengthMixin
from temba.api.views import ListAPIMixin
from temba.utils.uuid import is_uuid

from .models import Flow, FlowLabel, FlowRun


class FlowsEndpoint(SearchLengthMixin, ListAPIMixin, BaseEndpoint):
    """
    Flows for the current org, used by the flow list component. A folder is selected with the `folder` query param
    (`active` (default) or `archived`) — alternatively pass `label=<uuid>` to filter by a flow label. An optional
    `search` param filters by name, and `sort` can be `name`, `runs` or `ongoing` (prefix with `-` to reverse). Each
    item is serialized via Flow.as_json() (name, type, labels, run counts, completion, activity sparkline).
    """

    model = Flow
    serializer_class = ModelAsJsonSerializer
    pagination_class = ListPagination

    # the run statuses summed for each sortable count column ("status:" scopes on FlowActivityCount)
    SORT_STATUSES = {
        "runs": None,  # all statuses
        "ongoing": (FlowRun.STATUS_ACTIVE, FlowRun.STATUS_WAITING),
    }

    def derive_queryset(self):
        # Build from Flow.objects rather than the org.flows related manager — a related manager would seed each
        # fetched row with the in-memory org instance, which Django rejects on a GET because the org was loaded from
        # the default database while this queryset reads from the readonly alias.
        org = self.request.org
        base = Flow.objects.filter(org=org, is_active=True)

        label_uuid = self.request.query_params.get("label")
        if label_uuid:
            # Validate before the lookup — an unparseable value would otherwise raise in the database's UUID
            # coercion (500). FlowLabel.objects rather than org.flow_labels for the same readonly-alias reason as
            # the flows queryset above.
            if not is_uuid(label_uuid):
                return Flow.objects.none()
            label = FlowLabel.objects.filter(org=org, uuid=label_uuid, is_active=True).first()
            if not label:
                return Flow.objects.none()
            qs = base.filter(labels=label, is_archived=False)
            default_order = "-created_on"
        elif self.request.query_params.get("folder", "active").lower() == "archived":
            qs = base.filter(is_archived=True)
            default_order = "-created_on"
        else:
            qs = base.filter(is_archived=False)
            default_order = "-saved_on"

        search = self.request.query_params.get("search")
        if search:
            qs = qs.filter(name__icontains=search)

        sort = self.request.query_params.get("sort") or ""
        desc = sort.startswith("-")
        key = sort[1:] if desc else sort

        if key == "name":
            order = Lower("name").desc() if desc else Lower("name").asc()
        elif key in self.SORT_STATUSES:
            # runs/ongoing are sums of the per-status run counts — annotate so the database can order by them
            statuses = self.SORT_STATUSES[key]
            scopes = (
                Q(counts__scope__in=[f"status:{s}" for s in statuses])
                if statuses
                else Q(counts__scope__startswith="status:")
            )
            qs = qs.annotate(sort_count=Coalesce(Sum("counts__count", filter=scopes), Value(0)))
            order = "-sort_count" if desc else "sort_count"
        else:
            order = default_order

        return qs.order_by(order, "-id").prefetch_related("labels")

    def filter_queryset(self, queryset):
        # filtering (folder/label/search/sort) is fully resolved in derive_queryset; bypass the default backends
        return queryset

    def prepare_for_serialization(self, page, using: str):
        # bulk-load the per-status run counts and sparkline counts for the page so as_json doesn't N+1
        Flow.prefetch_run_counts(page, using=using)
        Flow.prefetch_activity_series(page)


class FlowLabelsEndpoint(ListAPIMixin, BaseEndpoint):
    """
    Flow labels for the current org, used by the flow list component's label dropdown. Each item is serialized via
    FlowLabel.as_json().
    """

    model = FlowLabel
    serializer_class = ModelAsJsonSerializer
    pagination_class = NameCursorPagination

    def derive_queryset(self):
        # FlowLabel.objects rather than org.flow_labels — see FlowsEndpoint.derive_queryset.
        return FlowLabel.objects.filter(org=self.request.org, is_active=True)
