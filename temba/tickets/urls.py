from django.conf.urls import include
from django.http import HttpResponsePermanentRedirect
from django.urls import re_path

from .views import ShortcutCRUDL, TeamCRUDL, TicketCRUDL, TopicCRUDL


def legacy_status_redirect(request, folder, uuid=None):
    """
    Redirects ticket URLs from before the status segment was dropped, e.g. /ticket/mine/open/<uuid>/
    """
    url = f"/ticket/{folder}/{uuid}/" if uuid else f"/ticket/{folder}/"
    if request.META.get("QUERY_STRING"):
        url += f"?{request.META['QUERY_STRING']}"
    return HttpResponsePermanentRedirect(url)


urlpatterns = [
    re_path(r"^ticket/(?P<folder>[a-z0-9\-]+)/(?:open|closed)/((?P<uuid>[a-z0-9\-]+)/)?$", legacy_status_redirect),
    re_path(r"^", include(ShortcutCRUDL().as_urlpatterns())),
    re_path(r"^", include(TeamCRUDL().as_urlpatterns())),
    re_path(r"^", include(TicketCRUDL().as_urlpatterns())),
    re_path(r"^", include(TopicCRUDL().as_urlpatterns())),
]
