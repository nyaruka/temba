from smartmin.views import SmartCRUDL

from django.utils.translation import gettext_lazy as _

from temba.airtime.models import AirtimeTransfer
from temba.contacts.models import URN, ContactURN
from temba.orgs.views.base import BaseListView, BaseReadView
from temba.utils.views.mixins import SpaMixin


class AirtimeCRUDL(SmartCRUDL):
    model = AirtimeTransfer
    actions = ("list", "read")

    class List(SpaMixin, BaseListView):
        menu_path = "/settings/workspace"
        title = _("Recent Airtime Transfers")
        default_order = ("-created_on",)
        select_related = ("contact",)

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            org = self.derive_org()

            for obj in context["object_list"]:
                obj.recipient_display = (
                    ContactURN.ANON_MASK_HTML if org.is_anon else URN.format(obj.recipient, international=True)
                )

            return context

    class Read(SpaMixin, BaseReadView):
        menu_path = "/settings/workspace"
        title = _("Airtime Transfer Details")
        fields = (
            "status",
            "sender",
            "contact",
            "recipient",
            "currency",
            "desired_amount",
            "actual_amount",
            "created_on",
        )
        field_config = {"created_on": {"label": "Time"}}

        def get_status(self, obj):
            return obj.get_status_display()

        def get_sender(self, obj):
            return URN.format(obj.sender, international=True) if obj.sender else "--"

        def get_recipient(self, obj):
            org = self.derive_org()
            return ContactURN.ANON_MASK_HTML if org.is_anon else URN.format(obj.recipient, international=True)

        def get_context_data(self, **kwargs):
            org = self.derive_org()
            user = self.request.user

            context = super().get_context_data(**kwargs)

            context["show_logs"] = not org.is_anon or user.is_staff
            context["http_logs"] = self.get_object().http_logs.order_by("created_on", "id")

            return context
