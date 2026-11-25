import json
import traceback

from django.conf import settings
from django.contrib import messages
from django.http import HttpResponseForbidden
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


class PreviewMiddleware:
    """
    Exposes a global `preview` flag for opting into features that aren't fully rolled out yet. `?preview=1` opts in
    (sets a year-long `temba-preview` cookie); `?preview=0` opts out (clears it); anything else falls back to the
    cookie. The current state is set on `request.preview` so views and templates can gate features off `if
    request.preview`.

    The write side (cookie set/clear) is gated on `request.user.is_authenticated` so a cross-origin
    `<img src=".../?preview=1">` can't silently plant the cookie on an unauthenticated victim.
    """

    COOKIE = "temba-preview"

    def __init__(self, get_response=None):
        self.get_response = get_response

    def __call__(self, request):
        toggle = request.GET.get("preview")
        # Only evaluate request.user when the toggle is actually present — otherwise reading is_authenticated on
        # every request would force the lazy user to materialize before OrgMiddleware needs it (and break the
        # query-count baselines of every list view).
        authed = toggle in ("1", "0") and request.user.is_authenticated
        if toggle == "1" and authed:
            request.preview = True
        elif toggle == "0" and authed:
            request.preview = False
        else:
            request.preview = request.COOKIES.get(self.COOKIE) == "1"

        response = self.get_response(request)

        if authed:
            if toggle == "1":
                response.set_cookie(
                    self.COOKIE,
                    "1",
                    max_age=365 * 24 * 60 * 60,
                    secure=request.is_secure(),
                    httponly=True,
                    samesite="Lax",
                )
            else:
                response.delete_cookie(self.COOKIE)
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
