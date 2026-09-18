import json
import traceback

from django.conf import settings
from django.contrib import messages
from django.core.exceptions import MiddlewareNotUsed
from django.http import HttpResponseForbidden, HttpResponseNotFound
from django.utils import timezone, translation

from temba.orgs.models import Org


class ExceptionMiddleware:
    def __init__(self, get_response=None):
        self.get_response = get_response

    def __call__(self, request):
        return self.get_response(request)

    def process_exception(self, request, exception):
        if settings.DEBUG:
            traceback.print_exc()

        return None


class ProxiedRequestMiddleware:
    """
    Adjusts requests for the load balancing in front of the app. Everything here is settings-gated, so a deployment
    with nothing in front of it is left alone, and it all has to happen before anything reads the scheme or the host
    or answers a request - static files included - which is why this is first.

    Two things a request says about itself are otherwise wrong behind a load balancer. The connection reaching the
    app is plain http even though the client's was https, and everything that keys off the scheme gets that wrong -
    CSRF origin checks, HSTS, absolute URLs, the API's SSL requirement. And some requests reach the app by its network
    address rather than by one of its domains, so the allowed hosts check rejects them - health checks being the case
    that matters, since a load balancer can't be told to address an instance any other way and failing them takes the
    deployment out of service.

    And the app listens on two ports: one for the internet and one that only its own network can reach, for the
    internal load balancer where the deployment has one. The internal-only API - everything under /ti/ - is served on
    the internal port and nowhere else, and that port serves nothing else, bar the health-check paths above, since the
    internal load balancer checks the same way as the public one. Nothing at all is served on any other port. A request
    in the wrong place gets a 404, the same as if the URL didn't exist. The port is the one the app's own socket
    accepted the connection on, never one a header claims, since a client can put what it likes in a header - which
    means TCP ports: bound to a unix socket, the WSGI server has no port of its own and fills in what the Host header
    says, which is the client's to choose.

    The test client doesn't listen anywhere and says its requests arrived on port 80, so under test any port that
    isn't the internal one is taken to be the internet one.
    """

    def __init__(self, get_response=None):
        if not (settings.SECURE_ASSUME_HTTPS or settings.ALLOWED_HOSTS_EXEMPT_PATHS or settings.INTERNAL_PORT):
            raise MiddlewareNotUsed()

        self.get_response = get_response

    def __call__(self, request):
        # a bare 404 rather than the 404 page: nothing later in the chain has run yet, so the page's context isn't there
        if settings.INTERNAL_PORT and not self._is_correct_port(request):
            return HttpResponseNotFound()

        if settings.SECURE_ASSUME_HTTPS:
            request.META["wsgi.url_scheme"] = "https"

        # only the host these are addressed by is corrected - whatever is served at them still runs as normal
        if request.path in settings.ALLOWED_HOSTS_EXEMPT_PATHS:
            request.META["HTTP_HOST"] = settings.BRAND["domain"]
            if settings.USE_X_FORWARDED_HOST:
                request.META["HTTP_X_FORWARDED_HOST"] = settings.BRAND["domain"]

        return self.get_response(request)

    @staticmethod
    def _is_correct_port(request) -> bool:
        port = int(request.META["SERVER_PORT"])

        if request.path.startswith("/ti/"):
            return port == settings.INTERNAL_PORT
        if port == settings.INTERNAL_PORT:
            return request.path in settings.ALLOWED_HOSTS_EXEMPT_PATHS

        return port == settings.INTERNET_PORT or settings.TESTING


class NoStoreMiddleware:
    """
    Marks responses as not to be cached unless the view has said otherwise. Almost everything served is specific to
    the user and workspace it was requested for, so nothing - not a shared cache, not the browser's back-forward cache -
    should keep a copy. Static files are exempt since WhiteNoise sits above this and answers those itself.
    """

    def __init__(self, get_response=None):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if not response.has_header("Cache-Control"):
            response.headers["Cache-Control"] = "no-store"
        return response


class OrgMiddleware:
    """
    Determines the org for this request and sets it on the request. Also sets request.branding for convenience.
    """

    session_key = "org_id"
    header_name = "X-Temba-Workspace"
    service_header_name = "X-Temba-Service-Org"
    select_related = ("parent",)

    def __init__(self, get_response=None):
        self.get_response = get_response

    def __call__(self, request):
        assert hasattr(request, "user"), "must be called after django.contrib.auth.middleware.AuthenticationMiddleware"

        request.org, request.is_servicing = self.determine_org(request)

        # if request was sent with a workspace identifier, ensure it matches the current org
        if posted_uuid := request.headers.get(self.header_name):
            if request.org and str(request.org.uuid) != posted_uuid:
                return HttpResponseForbidden()

        request.branding = settings.BRAND

        # continue the chain, which in the case of the API will set request.org
        response = self.get_response(request)

        if request.org:
            # set a response header to let UI check it's getting content from the workspace it expects
            response[self.header_name] = str(request.org.uuid)

        return response

    def determine_org(self, request) -> tuple[Org, bool]:
        """
        Determines the org for this request and whether it's being accessed by staff servicing.
        """

        user = request.user

        if user.is_authenticated:
            # check for value in session
            org_id = request.session.get(self.session_key, None)

            # staff users alternatively can pass a service header
            if user.is_staff:
                org_id = request.headers.get(self.service_header_name, org_id)

            if org_id:
                org = Org.objects.filter(is_active=True, id=org_id).select_related(*self.select_related).first()

                if org:
                    membership = org.get_membership(user)
                    if membership:
                        membership.record_seen()
                        return org, False

                    # members of the org's admin groups can access it as a regular user
                    elif org.has_group_admin(user):
                        return org, False

                    # staff users can access any org from servicing
                    elif user.is_staff:
                        return org, True

        return None, False


class TimezoneMiddleware:
    """
    Activates the timezone for the current org
    """

    def __init__(self, get_response=None):
        self.get_response = get_response

    def __call__(self, request):
        assert hasattr(request, "org"), "must be called after temba.middleware.OrgMiddleware"

        if request.org:
            timezone.activate(request.org.timezone)
        else:
            timezone.activate(settings.USER_TIME_ZONE)

        return self.get_response(request)


class LanguageMiddleware:
    """
    Activates the translation language for the current user
    """

    def __init__(self, get_response=None):
        self.get_response = get_response

    def __call__(self, request):
        assert hasattr(request, "user"), "must be called after django.contrib.auth.middleware.AuthenticationMiddleware"

        user = request.user

        if not user.is_authenticated:
            language = request.branding.get("language", settings.DEFAULT_LANGUAGE)
            translation.activate(language)
        else:
            translation.activate(user.language)

        response = self.get_response(request)
        response.headers.setdefault("Content-Language", translation.get_language())
        return response


class ToastMiddleware:
    """
    Converts django messages into a response header for toasts
    """

    def __init__(self, get_response=None):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)

        # only work on spa requests and exclude redirects
        if response.status_code == 200:
            storage = messages.get_messages(request)
            toasts = []
            for message in storage:
                toasts.append(
                    {"level": "error" if message.level == messages.ERROR else "info", "text": str(message.message)}
                )
                message.used = False

            if toasts:
                response["X-Temba-Toasts"] = json.dumps(toasts)
        return response
