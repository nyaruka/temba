"""
The URL configuration a help site's own domain is served with, in place of the app's - see HelpSiteMiddleware. The
same pages are mounted in the app under the preview prefix for the org to look at its site before pointing a domain
at it.
"""

from .site import page_not_found, site_urlpatterns

handler404 = page_not_found

urlpatterns = site_urlpatterns(preview=False)
