import contextlib
from uuid import UUID

import iso8601
from rest_framework import generics, mixins, status
from rest_framework.response import Response
from smartmin.views import SmartCRUDL, SmartTemplateView

from django.db import transaction
from django.http import Http404, HttpResponseRedirect
from django.urls import reverse
from django.utils.translation import gettext_lazy as _

from temba import mailroom
from temba.api.support import InvalidQueryError
from temba.contacts.models import URN
from temba.orgs.views.base import BaseDeleteModal, BaseListComponentView
from temba.utils.models import OrgAsset, OrgLimitMixin
from temba.utils.views.mixins import NonAtomicMixin

from .models import APIToken, BulkActionFailure


class BaseAPIView(NonAtomicMixin, generics.GenericAPIView):
    """
    Base class of all our API endpoints
    """

    model = None
    model_manager = "objects"
    lookup_params = {"uuid": "uuid"}

    # whether servicing staff are limited to GET requests - endpoints whose POSTs are actually
    # reads (e.g. resolving references) can set this to False
    readonly_servicing = True

    def derive_queryset(self):
        return getattr(self.model, self.model_manager).filter(org=self.request.org)

    def get_queryset(self):
        qs = self.derive_queryset()

        # if this is a get request, fetch from readonly database
        if self.request.method == "GET":
            qs = qs.using("readonly")

        return qs

    def get_lookup_values(self):
        """
        Extracts lookup_params from the request URL, e.g. {"uuid": "123..."}
        """
        lookup_values = {}
        for param, field in self.lookup_params.items():
            if param in self.request.query_params:
                param_value = self.request.query_params[param]

                # try to normalize URN lookup values
                if param == "urn":
                    param_value = self.normalize_urn(param_value)

                if param == "uuid":
                    try:
                        UUID(param_value)
                    except ValueError:
                        raise InvalidQueryError(f"Param '{param}': {param_value} is not a valid UUID.")

                lookup_values[field] = param_value

        if len(lookup_values) > 1:
            raise InvalidQueryError(
                "URL can only contain one of the following parameters: " + ", ".join(sorted(self.lookup_params.keys()))
            )

        return lookup_values

    def get_object(self):
        queryset = self.get_queryset().filter(**self.lookup_values)

        return generics.get_object_or_404(queryset)

    def get_int_param(self, name):
        param = self.request.query_params.get(name)
        try:
            return int(param) if param is not None else None
        except ValueError:
            raise InvalidQueryError("Value for %s must be an integer" % name)

    def get_uuid_param(self, name, *, list: bool = False):
        vals = self.request.query_params.getlist(name)
        if len(vals) > 100:
            raise InvalidQueryError(f"Param '{name}' can have a maximum of 100 values.")

        for i, val in enumerate(vals):
            try:
                vals[i] = UUID(val)
            except ValueError:
                raise InvalidQueryError(f"Param '{name}': {val} is not a valid UUID.")

        return vals if list else vals[0] if len(vals) >= 1 else None

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["org"] = self.request.org
        context["user"] = self.request.user
        context["by_token"] = isinstance(self.request.auth, APIToken)
        return context

    def normalize_urn(self, value):
        org = self.request.org

        if org.is_anon:
            raise InvalidQueryError("URN lookups not allowed for anonymous organizations")

        try:
            return URN.identity(URN.normalize(value, country_code=org.default_country_code))
        except ValueError:
            raise InvalidQueryError("Invalid URN: %s" % value)

    def is_docs(self):
        return "format" not in self.kwargs


class ListAPIMixin(mixins.ListModelMixin):
    """
    Mixin for any endpoint which returns a list of objects from a GET request
    """

    exclusive_params = ()

    def get(self, request, *args, **kwargs):
        return self.list(request, *args, **kwargs)

    def list(self, request, *args, **kwargs):
        self.check_query(self.request.query_params)

        if self.is_docs():
            # if this is just a request to browse the endpoint docs, don't make a query
            return Response([])
        else:
            return super().list(request, *args, **kwargs)

    def check_query(self, params):
        # check user hasn't provided values for more than one of any exclusive params
        if sum([(1 if params.get(p) else 0) for p in self.exclusive_params]) > 1:
            raise InvalidQueryError("You may only specify one of the %s parameters" % ", ".join(self.exclusive_params))

    def get_before_after(self) -> tuple:
        """
        Returns the parsed before/after params, raising ValueError if either is malformed
        """
        before = self.request.query_params.get("before")
        after = self.request.query_params.get("after")

        return iso8601.parse_date(before) if before else None, iso8601.parse_date(after) if after else None

    def filter_before_after(self, queryset, field):
        """
        Filters the queryset by the before/after params if are provided
        """
        try:
            before, after = self.get_before_after()
        except ValueError:
            return queryset.filter(pk=-1)

        if before:
            queryset = queryset.filter(**{field + "__lte": before})
        if after:
            queryset = queryset.filter(**{field + "__gte": after})

        return queryset

    def paginate_queryset(self, queryset):
        page = super().paginate_queryset(queryset)

        # give views a chance to prepare objects for serialization
        self.prepare_for_serialization(page, using=queryset.db)

        return page

    def prepare_for_serialization(self, page, using: str):
        """
        Views can override this to do things like bulk cache initialization of result objects
        """
        pass


class WriteAPIMixin:
    """
    Mixin for any endpoint which can create or update objects with a write serializer. Our approach differs a bit from
    the REST framework default way as we use POST requests for both create and update operations, and use separate
    serializers for reading and writing.
    """

    write_serializer_class = None
    write_with_transaction = True

    def post_save(self, instance):
        """
        Can be overridden to add custom handling after object creation
        """
        pass

    def post(self, request, *args, **kwargs):
        self.lookup_values = self.get_lookup_values()

        # determine if this is an update of an existing object or a create of a new object
        if self.lookup_values:
            instance = self.get_object()
            if self.is_system_instance(instance):
                return Response({"detail": "Cannot modify system object."}, status=status.HTTP_403_FORBIDDEN)
        else:
            instance = None

            if issubclass(self.model, OrgLimitMixin):
                if self.model.is_limit_reached(request.org):
                    return Response(
                        {"detail": "Cannot create object because workspace has reached limit."},
                        status=status.HTTP_409_CONFLICT,
                    )

        context = self.get_serializer_context()
        context["lookup_values"] = self.lookup_values
        context["instance"] = instance

        serializer = self.write_serializer_class(instance=instance, data=request.data, context=context)

        if serializer.is_valid():
            mgr = transaction.atomic() if self.write_with_transaction else contextlib.suppress()
            with mgr:
                try:
                    output = serializer.save()
                except mailroom.URNValidationException as e:
                    return Response(serializer.urn_exception(e), status=status.HTTP_400_BAD_REQUEST)
                except mailroom.ContactLimitReachedException as e:
                    return Response({"detail": str(e)}, status=status.HTTP_409_CONFLICT)

                self.post_save(output)
                return self.render_write_response(output, context)
        else:
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def is_system_instance(self, obj):
        return obj.is_system if isinstance(obj, OrgAsset) else False

    def render_write_response(self, write_output, context):
        response_serializer = self.serializer_class(instance=write_output, context=context)

        # if we're also a list view, we can re-use any serialization preparation it uses
        if hasattr(self, "prepare_for_serialization"):
            self.prepare_for_serialization([write_output], using="default")

        # if we created a new object, notify caller by returning 201
        status_code = status.HTTP_200_OK if context["instance"] else status.HTTP_201_CREATED

        return Response(response_serializer.data, status=status_code)


class BulkWriteAPIMixin:
    """
    Mixin for a bulk action endpoint which writes multiple objects in response to a POST but returns nothing.
    """

    def post(self, request, *args, **kwargs):
        serializer = self.serializer_class(data=request.data, context=self.get_serializer_context())

        if serializer.is_valid():
            result = serializer.save()
            if isinstance(result, BulkActionFailure):
                return Response(result.as_json(), status.HTTP_200_OK)
            else:
                return Response("", status=status.HTTP_204_NO_CONTENT)

        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class DeleteAPIMixin(mixins.DestroyModelMixin):
    """
    Mixin for any endpoint that can delete objects with a DELETE request
    """

    def delete(self, request, *args, **kwargs):
        self.lookup_values = self.get_lookup_values()

        if not self.lookup_values:
            raise InvalidQueryError(
                "URL must contain one of the following parameters: " + ", ".join(sorted(self.lookup_params.keys()))
            )

        instance = self.get_object()
        if self.is_system_instance(instance):
            return Response({"detail": "Cannot delete system object."}, status=status.HTTP_403_FORBIDDEN)

        self.perform_destroy(instance)
        return Response(status=status.HTTP_204_NO_CONTENT)

    def perform_destroy(self, instance):
        instance.release(self.request.user)


class APITokenCRUDL(SmartCRUDL):
    model = APIToken
    actions = ("list", "create", "delete")

    class List(BaseListComponentView):
        title = _("API Tokens")
        menu_path = "/settings/api-tokens"
        list_endpoint = "api.internal.api_tokens"
        allow_search = False
        token_limit = 3

        def derive_list_query(self) -> str:
            return ""  # the endpoint has no folders

        def build_context_menu(self, menu):
            if self.request.user.get_api_tokens(self.request.org).count() < self.token_limit:
                menu.add_modax(_("New"), "new-token", reverse("api.apitoken_create"), as_button=True)

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["token_limit"] = self.token_limit
            return context

    class Create(SmartTemplateView):
        """
        Modal which creates a new token and shows its key - the only time the full key is ever shown to the user
        """

        submit_button_name = _("Create")

        def has_permission(self, request, *args, **kwargs):
            return (
                request.user.is_authenticated
                and request.org is not None
                and request.org.get_user_role(request.user) in APIToken.ALLOWED_ROLES
            )

        def is_limit_reached(self) -> bool:
            return self.request.user.get_api_tokens(self.request.org).count() >= APITokenCRUDL.List.token_limit

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["submit_button_name"] = self.submit_button_name
            context["token_limit"] = APITokenCRUDL.List.token_limit
            context["limit_reached"] = self.is_limit_reached()
            return context

        def post(self, request, *args, **kwargs):
            # rather than redirecting, respond with the key so it's only ever sent to the user in this one response
            new_key = None
            if not self.is_limit_reached():
                new_key = APIToken.create(request.org, request.user).key

            return self.render_to_response(self.get_context_data(new_key=new_key))

    class Delete(BaseDeleteModal):
        slug_url_kwarg = "id"
        fields = ("id",)
        cancel_url = "@api.apitoken_list"
        redirect_url = "@api.apitoken_list"

        def has_permission(self, request, *args, **kwargs):
            return request.user.is_authenticated and self.get_object() is not None

        def get_object(self, queryset=None):
            # tokens are referenced by their digest so their keys never appear in URLs - a user only has a few, so
            # we can find the one being deleted by checking each of theirs
            for token in self.request.user.get_api_tokens(self.request.org):
                if token.digest == self.kwargs["id"]:
                    return token

            raise Http404()

        def post(self, request, *args, **kwargs):
            self.get_object().release()

            return HttpResponseRedirect(self.get_redirect_url())
