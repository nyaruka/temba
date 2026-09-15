from django.conf.urls import include
from django.urls import re_path

from .site import site_urlpatterns
from .views import ArticleCRUDL, HelpdeskImportCRUDL, HelpSiteCRUDL, KnowledgeItemCRUDL, KnowledgeSourceCRUDL

urlpatterns = [
    re_path(r"^", include(ArticleCRUDL().as_urlpatterns())),
    re_path(r"^", include(HelpdeskImportCRUDL().as_urlpatterns())),
    re_path(r"^", include(HelpSiteCRUDL().as_urlpatterns())),
    re_path(r"^", include(KnowledgeSourceCRUDL().as_urlpatterns())),
    re_path(r"^", include(KnowledgeItemCRUDL().as_urlpatterns())),
    # the org's own help site as its readers will see it, for looking over before a domain is pointed at it
    re_path(r"^helpsite/preview/", include(site_urlpatterns(preview=True))),
]
