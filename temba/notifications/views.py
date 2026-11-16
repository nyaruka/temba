from smartmin.views import SmartCRUDL, SmartListView

from django.http import HttpResponseRedirect
from django.utils.decorators import method_decorator
from django.utils.translation import gettext_lazy as _
from django.views.decorators.csrf import csrf_exempt
from django.views.generic import TemplateView

from temba.orgs.views.base import BaseReadView
from temba.orgs.views.mixins import OrgPermsMixin
from temba.utils.views.mixins import SpaMixin

from .models import Incident, Notification


class NotificationCRUDL(SmartCRUDL):
    model = Notification
    actions = ("read",)

    class Read(BaseReadView):
        slug_url_kwarg = None  # these don't have UUIDs currently

        def has_permission(self, request, *args, **kwargs):
            return self.request.user.is_authenticated

        def derive_queryset(self, **kwargs):
            return self.request.user.notifications.filter(org=self.request.org)

        def render_to_response(self, context, **response_kwargs):
            obj = self.get_object()
            obj.clear()

            return HttpResponseRedirect(obj.get_target_url())


class IncidentCRUDL(SmartCRUDL):
    model = Incident
    actions = ("list",)

    class List(OrgPermsMixin, SpaMixin, SmartListView):
        default_order = "-started_on"
        title = _("Incidents")
        menu_path = "/settings/incidents"

        def get_queryset(self, **kwargs):
            return super().get_queryset(**kwargs).filter(org=self.request.org).exclude(ended_on=None)

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["ongoing"] = (
                Incident.objects.filter(org=self.request.org, ended_on=None)
                .select_related("org", "channel")
                .order_by("-started_on")
            )
            return context


@method_decorator(csrf_exempt, name="dispatch")
class UnsubscribeView(TemplateView):
    """
    Lets the recipient of a notification email turn off notification emails for that workspace without logging in.
    GET only asks for confirmation since link scanners follow every link in an email. POST is CSRF exempt because
    the signed token is what authorizes it, and because mail clients POST here for one-click unsubscribe.
    """

    template_name = "notifications/notification_unsubscribe.html"

    def dispatch(self, request, *args, **kwargs):
        self.membership = Notification.from_unsubscribe_token(kwargs["token"])
        return super().dispatch(request, *args, **kwargs)

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["membership"] = self.membership
        return context

    def post(self, request, *args, **kwargs):
        if self.membership and self.membership.email_notifications:
            self.membership.email_notifications = False
            self.membership.save(update_fields=("email_notifications",))

        return self.render_to_response(self.get_context_data(unsubscribed=bool(self.membership)))
