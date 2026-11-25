from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response

from django.db.models import Prefetch, prefetch_related_objects
from django.http import HttpResponse

from temba import mailroom
from temba.api.internal.serializers import ModelAsJsonSerializer
from temba.api.internal.views import BaseEndpoint
from temba.api.views import ListAPIMixin
from temba.utils.models.es import SearchSliceQuerySet

from .models import Contact, ContactField, ContactGroup

# Match BaseListView/ContactListView: 50 rows per page, and never let a client page past the 200th page (ES deep
# pagination guard, mirroring ContactListView.pre_process).
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 500
MAX_PAGE = 200

# Cap the search query length the same way the legacy list view does so an oversized query can't be used to drive an
# expensive mailroom/ES request.
SEARCH_MAX_LENGTH = ContactGroup.MAX_QUERY_LEN

# The contact list component prefixes its custom-field column keys with `field:` (e.g. `field:age`); mailroom's sort
# wants the bare field key. System columns (last_seen_on, created_on) are sent unprefixed and pass through untouched.
FIELD_SORT_PREFIX = "field:"


class ContactsEndpoint(ListAPIMixin, BaseEndpoint):
    """
    Contacts for the current org, used by the contact list component. A status folder is selected with the `folder`
    query param (one of `active`, `blocked`, `stopped` or `archived`, defaulting to `active`) — alternatively pass
    `group=<uuid>` to filter by a specific (manual or smart) group. Optional `search` (a mailroom contact query) and
    `sort` params drive ES-backed search/sorting, exactly like the legacy contact list views. Each item is serialized
    via Contact.as_json() (the lightweight list shape — name, primary URN, featured field values, last/created on).
    """

    class Pagination(PageNumberPagination):
        page_size = DEFAULT_PAGE_SIZE
        page_size_query_param = "page_size"
        max_page_size = MAX_PAGE_SIZE

    model = Contact
    serializer_class = ModelAsJsonSerializer
    pagination_class = Pagination

    FOLDERS = {
        "active": ContactGroup.TYPE_DB_ACTIVE,
        "blocked": ContactGroup.TYPE_DB_BLOCKED,
        "stopped": ContactGroup.TYPE_DB_STOPPED,
        "archived": ContactGroup.TYPE_DB_ARCHIVED,
    }

    def get(self, request, *args, **kwargs):
        search = request.query_params.get("search") or ""
        if len(search) > SEARCH_MAX_LENGTH:
            return HttpResponse("Search query too long", status=413)
        # Don't allow pagination past the 200th page (mirrors ContactListView.pre_process / the ES offset guard).
        if self._page() > MAX_PAGE:
            return Response({"results": [], "count": 0, "next": None, "previous": None})
        return super().get(request, *args, **kwargs)

    def _page(self) -> int:
        try:
            return max(1, int(self.request.query_params.get("page", 1)))
        except TypeError, ValueError:
            return 1

    def _page_size(self) -> int:
        # Mirror DRF PageNumberPagination.get_page_size (which uses _positive_int(strict=True)): non-positive or
        # non-integer values fall back to the default rather than being clamped, and the value is capped at the max.
        # The search/sort path derives the mailroom offset from this, so it must match the page size DRF slices with
        # or SearchSliceQuerySet's offset guard trips with an IndexError (HTTP 500).
        try:
            size = int(self.request.query_params.get("page_size", DEFAULT_PAGE_SIZE))
        except TypeError, ValueError:
            return DEFAULT_PAGE_SIZE
        if size <= 0:
            return DEFAULT_PAGE_SIZE
        return min(size, MAX_PAGE_SIZE)

    def derive_group(self):
        org = self.request.org
        group_uuid = self.request.query_params.get("group")
        if group_uuid:
            # Mirror GroupsEndpoint.filter_queryset: skip still-evaluating smart groups so we never page over a group
            # whose membership isn't yet populated.
            return (
                org.groups.filter(uuid=group_uuid, is_active=True)
                .exclude(status=ContactGroup.STATUS_INITIALIZING)
                .first()
            )

        group_type = self.FOLDERS.get(self.request.query_params.get("folder", "active").lower())
        if not group_type:
            return None
        return org.groups.filter(group_type=group_type).first()

    def derive_sort(self) -> str:
        sort = self.request.query_params.get("sort") or ""
        if not sort:
            return ""
        desc = sort.startswith("-")
        key = sort[1:] if desc else sort
        if key.startswith(FIELD_SORT_PREFIX):
            key = key[len(FIELD_SORT_PREFIX) :]
        return ("-" if desc else "") + key

    def get_queryset(self):
        org = self.request.org
        group = self.derive_group()
        if group is None:
            return Contact.objects.none()

        search = self.request.query_params.get("search") or ""
        sort = self.derive_sort()

        # Searching/sorting goes through mailroom (ES) which returns a pre-ordered window plus a total; without either
        # we can read the group membership straight from the database (newest first), matching ContactListView.
        if search or sort:
            page_size = self._page_size()
            offset = (self._page() - 1) * page_size
            try:
                results = mailroom.get_client().contact_search(
                    org, group, search, sort=sort, offset=offset, limit=page_size
                )
            except mailroom.QueryValidationException as e:
                # Surface the validation error but keep a list-shaped response so the component just renders empty.
                self._query_error = str(e)
                return SearchSliceQuerySet(Contact, [], offset=0, total=0)

            # Echo mailroom's parsed/normalized query (e.g. "age > 50" → "fields.age > 50") so the component can
            # rewrite its search box to match what the results actually reflect. Only meaningful when searching.
            self._parsed_query = results.query if search and results.query else None

            return SearchSliceQuerySet(Contact, results.contact_uuids, offset=offset, total=results.total)

        return group.contacts.filter(org=org).order_by("-id")

    def filter_queryset(self, queryset):
        # Filtering (group/search/sort) is fully resolved in get_queryset; bypass the default filter backends.
        return queryset

    def prepare_for_serialization(self, page, using: str):
        Contact.bulk_urn_cache_initialize(page, using=using)
        # Bulk-load each contact's group memberships (one query for the page) so as_json can report current
        # membership — used by the component to pre-check the group dropdown — without an N+1.
        prefetch_related_objects(
            page,
            Prefetch(
                "groups",
                queryset=ContactGroup.get_groups(self.request.org).only("uuid", "name", "org"),
                to_attr="prefetched_groups",
            ),
        )

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["contact_fields"] = ContactField.get_fields(org=self.request.org, viewable_by=self.request.user)
        return context

    def get_paginated_response(self, data):
        response = super().get_paginated_response(data)
        if getattr(self, "_query_error", None):
            response.data["error"] = self._query_error
        parsed_query = getattr(self, "_parsed_query", None)
        if parsed_query:
            response.data["query"] = parsed_query
        return response
