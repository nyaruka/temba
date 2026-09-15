from rest_framework.urlpatterns import format_suffix_patterns

from django.urls import re_path

from temba.campaigns.api import CampaignsEndpoint
from temba.contacts.api import ContactsEndpoint
from temba.flows.api import FlowLabelsEndpoint, FlowsEndpoint
from temba.ivr.api import CallsEndpoint
from temba.msgs.api import BroadcastsEndpoint, MessagesEndpoint
from temba.triggers.api import TriggersEndpoint

from .views import (
    ArticlesEndpoint,
    AssetsEndpoint,
    LLMsEndpoint,
    LocationsEndpoint,
    NotificationsEndpoint,
    OrgsEndpoint,
    ShortcutsEndpoint,
    TemplatesEndpoint,
)

urlpatterns = [
    # ========== endpoints A-Z ===========
    re_path(r"^articles$", ArticlesEndpoint.as_view(), name="api.internal.articles"),
    re_path(r"^assets$", AssetsEndpoint.as_view(), name="api.internal.assets"),
    re_path(r"^broadcasts$", BroadcastsEndpoint.as_view(), name="api.internal.broadcasts"),
    re_path(r"^calls$", CallsEndpoint.as_view(), name="api.internal.calls"),
    re_path(r"^campaigns$", CampaignsEndpoint.as_view(), name="api.internal.campaigns"),
    re_path(r"^contacts$", ContactsEndpoint.as_view(), name="api.internal.contacts"),
    re_path(r"^flow_labels$", FlowLabelsEndpoint.as_view(), name="api.internal.flow_labels"),
    re_path(r"^flows$", FlowsEndpoint.as_view(), name="api.internal.flows"),
    re_path(r"^llms$", LLMsEndpoint.as_view(), name="api.internal.llms"),
    re_path(r"^locations$", LocationsEndpoint.as_view(), name="api.internal.locations"),
    re_path(r"^messages$", MessagesEndpoint.as_view(), name="api.internal.messages"),
    re_path(r"^notifications$", NotificationsEndpoint.as_view(), name="api.internal.notifications"),
    re_path(r"^orgs$", OrgsEndpoint.as_view(), name="api.internal.orgs"),
    re_path(r"^shortcuts$", ShortcutsEndpoint.as_view(), name="api.internal.shortcuts"),
    re_path(r"^templates$", TemplatesEndpoint.as_view(), name="api.internal.templates"),
    re_path(r"^triggers$", TriggersEndpoint.as_view(), name="api.internal.triggers"),
]

urlpatterns = format_suffix_patterns(urlpatterns, allowed=["json"])
