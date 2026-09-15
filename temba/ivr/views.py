from smartmin.views import SmartCRUDL

from django.utils.translation import gettext_lazy as _

from temba.orgs.views.base import BaseListComponentView

from .models import Call


class CallCRUDL(SmartCRUDL):
    model = Call
    actions = ("list",)

    class List(BaseListComponentView):
        title = _("Calls")
        menu_path = "/msg/calls"
        list_endpoint = "api.internal.calls"

        def derive_list_query(self) -> str:
            return ""  # the endpoint has no folders
