from django.db.models.functions import Lower

from temba.api.internal.serializers import ModelAsJsonSerializer
from temba.api.internal.views import BaseEndpoint
from temba.api.support import ListPagination
from temba.api.views import ListAPIMixin

from .models import LLM


class AIModelsEndpoint(ListAPIMixin, BaseEndpoint):
    """
    The org's AI models, used by the AI model list component. System models aren't included as they can't be changed.
    `sort` can be `name` or `usages` (prefix with `-` to reverse), and defaults to name. Each item is serialized via
    LLM.as_json().
    """

    model = LLM
    serializer_class = ModelAsJsonSerializer
    pagination_class = ListPagination

    def derive_queryset(self):
        qs = LLM.annotate_usage(LLM.objects.filter(org=self.request.org, is_active=True, is_system=False))

        sort = self.request.query_params.get("sort") or ""
        desc = sort.startswith("-")
        key = sort[1:] if desc else sort

        if key == "usages":
            order = "-usage_count" if desc else "usage_count"
        else:
            order = Lower("name").desc() if desc and key == "name" else Lower("name").asc()

        return qs.order_by(order, "id")

    def filter_queryset(self, queryset):
        # sorting is resolved in derive_queryset, so bypass the default backends
        return queryset
