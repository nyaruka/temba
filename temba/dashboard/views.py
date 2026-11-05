from collections import defaultdict
from datetime import datetime, timedelta

from smartmin.views import SmartTemplateView

from django.db.models import Q
from django.http import JsonResponse
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from temba.orgs.models import Org, OrgTally
from temba.orgs.views.mixins import OrgPermsMixin
from temba.utils.views.mixins import ChartViewMixin, SpaMixin

SCOPE_TEXT_IN = "msgs/text:in"
SCOPE_TEXT_OUT = "msgs/text:out"


class Home(SpaMixin, OrgPermsMixin, SmartTemplateView):
    """
    The main dashboard view
    """

    title = _("Dashboard")
    permission = "orgs.org_dashboard"
    template_name = "dashboard/home.html"
    menu_path = "/settings/dashboard"


class MessageHistory(OrgPermsMixin, ChartViewMixin, SmartTemplateView):
    """
    Endpoint to expose message history by day as JSON for temba-chart
    """

    permission = "orgs.org_dashboard"
    default_chart_period = (-timedelta(days=30), timedelta(days=1))

    def get_chart_data(self, since, until) -> tuple[list, list]:
        org = self.request.org
        orgs = list(Org.objects.filter(Q(id=org.id) | Q(parent=org)))

        # collect all dates and values by scope across our workspaces, including the until day
        dates_set = set()
        values_by_scope = {SCOPE_TEXT_IN: defaultdict(int), SCOPE_TEXT_OUT: defaultdict(int)}

        daily_totals = OrgTally.get_daily_totals_by_org(orgs, list(values_by_scope), since, until + timedelta(days=1))
        for (_org_id, day, scope), count in daily_totals.items():
            dates_set.add(day)
            values_by_scope[scope][day] += count

        labels = sorted(list(dates_set))

        return [d.strftime("%Y-%m-%d") for d in labels], [
            {
                "label": _("Incoming"),
                "data": [values_by_scope[SCOPE_TEXT_IN].get(d, 0) for d in labels],
            },
            {
                "label": _("Outgoing"),
                "data": [values_by_scope[SCOPE_TEXT_OUT].get(d, 0) for d in labels],
            },
        ]


class WorkspaceStats(OrgPermsMixin, SmartTemplateView):
    permission = "orgs.org_dashboard"

    def get_period(self):
        """Get the date range from request parameters or use defaults"""
        since = self.request.GET.get("since")
        until = self.request.GET.get("until")

        if since:
            since = datetime.fromisoformat(since.replace("Z", "+00:00")).date()
        else:
            since = timezone.now().date() - timedelta(days=30)

        if until:
            until = datetime.fromisoformat(until.replace("Z", "+00:00")).date()
        else:
            until = timezone.now().date()

        return since, until

    def render_to_response(self, context, **response_kwargs):
        org = self.request.org
        orgs = list(Org.objects.filter(Q(id=org.id) | Q(parent=org)))

        since, until = self.get_period()

        categories = []
        inbound = []
        outbound = []

        totals = defaultdict(int)
        daily_totals = OrgTally.get_daily_totals_by_org(
            orgs, [SCOPE_TEXT_IN, SCOPE_TEXT_OUT], since, until + timedelta(days=1)
        )
        for (org_id, _day, scope), count in daily_totals.items():
            totals[(org_id, scope)] += count

        for org in orgs:
            inbound_count, outbound_count = totals[(org.id, SCOPE_TEXT_IN)], totals[(org.id, SCOPE_TEXT_OUT)]

            # ignore orgs with no activity in this period
            if not inbound_count and not outbound_count:
                continue

            categories.append(org.name)
            inbound.append(inbound_count)
            outbound.append(outbound_count)

        return JsonResponse(
            {
                "period": [since, until],
                "data": {
                    "labels": categories,
                    "datasets": [{"label": _("Incoming"), "data": inbound}, {"label": _("Outgoing"), "data": outbound}],
                },
            }
        )
