from rest_framework import generics, serializers, status
from rest_framework.response import Response

from django.db.models import Prefetch, prefetch_related_objects

from temba import mailroom
from temba.api.internal.serializers import ModelAsJsonSerializer
from temba.api.internal.views import BaseEndpoint
from temba.api.support import ListPagination, SearchLengthMixin
from temba.api.v2 import serializers as v2
from temba.api.views import ListAPIMixin, WriteAPIMixin
from temba.mailroom import modifiers
from temba.utils.models.base import patch_queryset_count
from temba.utils.models.es import SearchSliceQuerySet
from temba.utils.uuid import is_uuid

from .models import Contact, ContactField, ContactGroup

# Never let a client page past the 200th page (ES deep pagination guard, mirroring ContactListView.pre_process).
MAX_PAGE = 200

# The contact list component prefixes its custom-field column keys with `field:` (e.g. `field:age`); mailroom's sort
# wants the bare field key. System columns (last_seen_on, created_on) are sent unprefixed and pass through untouched.
FIELD_SORT_PREFIX = "field:"


class ContactWriteSerializer(v2.ContactWriteSerializer):
    """
    The public API contact write serializer extended with status changes, for the contact editor component.
    """

    STATUSES = {
        "active": Contact.STATUS_ACTIVE,
        "blocked": Contact.STATUS_BLOCKED,
        "stopped": Contact.STATUS_STOPPED,
        "archived": Contact.STATUS_ARCHIVED,
    }

    status = serializers.ChoiceField(required=False, choices=tuple(STATUSES))
    email = serializers.EmailField(required=False, allow_blank=True, allow_null=True)

    def validate_email(self, value):
        # normalized as mailroom will store it, so that we can tell when it's unchanged
        return value.strip().lower() if value else None

    def validate_groups(self, value):
        # the public API rejects groups on any non-active contact - here that check needs to consider a status
        # submitted in the same update, so it lives in validate() below
        return value

    def validate(self, data):
        data = super().validate(data)

        # only active contacts can be added to groups, tho we allow groups on an update that restores the contact
        # since the restore is applied first
        if self.instance and data.get("groups"):
            new_status = self.STATUSES[data["status"]] if "status" in data else self.instance.status
            if self.instance.status != Contact.STATUS_ACTIVE and new_status != Contact.STATUS_ACTIVE:
                raise serializers.ValidationError({"groups": "Non-active contacts can't be added to groups"})

        if self.instance and "email" in data and self.context["org"].is_anon:
            raise serializers.ValidationError({"email": "Updating email not allowed for anonymous workspaces"})

        return data

    def get_modifiers(self) -> list:
        mods = super().get_modifiers()

        if "email" in self.validated_data and self.validated_data["email"] != self.instance.email:
            mods.append(modifiers.Email(email=self.validated_data["email"] or ""))

        return mods

    def save(self):
        # apply any status change first so that a restore to active happens before any group mods
        contact_status = self.validated_data.get("status")
        if self.instance and "status" in self.validated_data and self.STATUSES[contact_status] != self.instance.status:
            user = self.context["user"]
            if contact_status == "active":
                self.instance.restore(user)
            elif contact_status == "blocked":
                self.instance.block(user)
            elif contact_status == "stopped":
                self.instance.stop(user)
            elif contact_status == "archived":
                self.instance.archive(user)

        return super().save()


class ContactsEndpoint(SearchLengthMixin, ListAPIMixin, WriteAPIMixin, BaseEndpoint):
    """
    Contacts for the current org, used by the contact list component. A status folder is selected with the `folder`
    query param (one of `active`, `blocked`, `stopped` or `archived`, defaulting to `active`) — alternatively pass
    `group=<uuid>` to filter by a specific (manual or smart) group. Optional `search` (a mailroom contact query) and
    `sort` params drive ES-backed search/sorting, exactly like the legacy contact list views. Each item is serialized
    via Contact.as_json() (the lightweight list shape — name, primary URN, featured field values, last/created on).

    POST with a `uuid` param updates a contact (used by the contact editor component), accepting the same fields as
    the public API endpoint plus `status`, and returns the contact in the editor's read shape (the public API read
    serialization with URNs expanded and in priority order). Unlike the public API endpoint, contacts can't be
    created here.
    """

    model = Contact
    serializer_class = ModelAsJsonSerializer
    write_serializer_class = ContactWriteSerializer
    write_with_transaction = False
    pagination_class = ListPagination

    # a mailroom contact query rather than a plain text search, so cap it at the query length limit
    search_max_length = ContactGroup.MAX_QUERY_LEN

    FOLDERS = {
        "active": ContactGroup.TYPE_DB_ACTIVE,
        "blocked": ContactGroup.TYPE_DB_BLOCKED,
        "stopped": ContactGroup.TYPE_DB_STOPPED,
        "archived": ContactGroup.TYPE_DB_ARCHIVED,
    }

    def get(self, request, *args, **kwargs):
        # Don't allow pagination past the 200th page (mirrors ContactListView.pre_process / the ES offset guard).
        if self._page() > MAX_PAGE:
            return Response({"results": [], "count": 0, "next": None, "previous": None})
        return super().get(request, *args, **kwargs)

    def post(self, request, *args, **kwargs):
        # unlike the public API endpoint, contacts can only be updated here, never created
        if "uuid" not in request.query_params:
            return Response({"detail": "URL must contain uuid parameter."}, status=status.HTTP_400_BAD_REQUEST)

        return super().post(request, *args, **kwargs)

    def get_object(self):
        # lookups are always by UUID and shouldn't be constrained by the folder/group params used for listing
        return generics.get_object_or_404(Contact.objects.filter(org=self.request.org, **self.lookup_values))

    def render_write_response(self, write_output, context):
        # the editor component expects the same shape it reads: the public API read serialization with URNs
        # expanded and in priority order
        Contact.bulk_urn_cache_initialize([write_output], using="default")
        expanded_urns = Contact.bulk_inspect([write_output])[write_output]["urns"]
        priority = {(urn.scheme, urn.path): index for index, urn in enumerate(write_output.get_urns())}
        write_output.expanded_urns = sorted(
            expanded_urns, key=lambda urn: priority.get((urn["scheme"], urn["path"]), len(priority))
        )

        return Response(
            v2.ContactReadSerializer(instance=write_output, context=context).data, status=status.HTTP_200_OK
        )

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
            size = int(self.request.query_params.get("page_size", ListPagination.page_size))
        except TypeError, ValueError:
            return ListPagination.page_size
        if size <= 0:
            return ListPagination.page_size
        return min(size, ListPagination.max_page_size)

    def derive_group(self):
        org = self.request.org
        group_uuid = self.request.query_params.get("group")
        if group_uuid:
            # Validate before the lookup — an unparseable value would otherwise raise in the database's UUID
            # coercion (500). Mirrors FlowsEndpoint's label guard.
            if not is_uuid(group_uuid):
                return None
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

        # Patch .count() to read the precomputed ContactGroupCount squash (via get_member_count) instead of letting
        # DRF's paginator run a full SELECT COUNT(*) over the group membership — that COUNT is what makes the new list
        # far slower than the legacy view on large groups. Mirrors ContactListView.get_queryset.
        qs = group.contacts.filter(org=org).order_by("-id")
        patch_queryset_count(qs, group.get_member_count)
        return qs

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
