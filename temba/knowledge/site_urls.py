"""
The URL configuration a help site's own domain is served with, in place of the app's - see HelpSiteMiddleware.
"""

from .site import page_not_found, site_urlpatterns

handler404 = page_not_found

urlpatterns = site_urlpatterns()
