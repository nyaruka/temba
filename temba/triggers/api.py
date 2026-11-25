from django.db.models import Q

from temba.api.internal.serializers import ModelAsJsonSerializer
from temba.api.internal.views import BaseEndpoint
from temba.api.support import ListPagination, SearchLengthMixin
from temba.api.views import ListAPIMixin

from .models import Trigger
from .views import Folder


class TriggersEndpoint(SearchLengthMixin, ListAPIMixin, BaseEndpoint):
    """
    Triggers for the current org, used by the trigger list component. A folder is selected with the `folder` query
    param — `active` (default), `archived`, or one of the type folder slugs (`messages`, `schedule`, `calls`, etc.).
    An optional `search` param filters by keyword, flow name or channel name, and `sort` can be `created_on` (prefix
    with `-` to reverse). Each item is serialized via Trigger.as_json().
    """

    model = Trigger
    serializer_class = ModelAsJsonSerializer
    pagination_class = ListPagination

    def derive_queryset(self):
        org = self.request.org
        base = Trigger.objects.filter(org=org, is_active=True)

        # `archived` is resolved before the type folders so a future Folder member with a colliding name can't
        # silently change this query's shape
        folder_slug = (self.request.query_params.get("folder") or "active").lower()
        folder = Folder.from_slug(folder_slug) if folder_slug != "archived" else None
        if folder:
            # a type folder — non-archived triggers of those types, in the folder view's ordering
            qs = base.filter(is_archived=False, trigger_type__in=folder.types)
            default_order = (Trigger.type_order(), *folder.ordering, "-created_on")
        elif folder_slug == "archived":
            qs = base.filter(is_archived=True)
            default_order = ("-created_on",)
        else:
            qs = base.filter(is_archived=False)
            default_order = ("-created_on",)

        search = self.request.query_params.get("search")
        if search:
            # match the list view's search fields
            qs = qs.filter(
                Q(keywords__icontains=search) | Q(flow__name__icontains=search) | Q(channel__name__icontains=search)
            )

        sort = self.request.query_params.get("sort") or ""
        desc = sort.startswith("-")
        key = sort[1:] if desc else sort

        if key == "created_on":
            order = ("-created_on" if desc else "created_on",)
        else:
            order = default_order

        return (
            qs.order_by(*order, "-id")
            .select_related("flow", "channel", "schedule")
            .prefetch_related("contacts", "groups", "exclude_groups")
        )

    def filter_queryset(self, queryset):
        # filtering (folder/search/sort) is fully resolved in derive_queryset; bypass the default backends
        return queryset
