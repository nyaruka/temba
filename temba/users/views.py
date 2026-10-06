import json

from allauth.account.adapter import get_adapter
from allauth.account.views import LoginView, SignupView

from django.contrib import messages
from django.contrib.auth.mixins import LoginRequiredMixin
from django.http import JsonResponse
from django.utils.functional import cached_property
from django.utils.translation import gettext_lazy as _
from django.views import View


class TembaInviteMixin:
    def get_form_kwargs(self):
        if self.request.method == "GET":
            # update our session invite on GET
            self.request.session["invite_secret"] = self.request.GET.get("invite", None)

        return {"secret": self.invite_secret, **super().get_form_kwargs()}

    @property
    def invite_secret(self):
        # read by the adapter, so we enforce the invite that opened signup, even when it's only in the query string of
        # a POST
        return get_adapter(self.request).get_invite_secret(self.request)

    @cached_property
    def invite(self):
        return get_adapter(self.request).get_invite(self.request)

    def get_initial(self):
        initial = super().get_initial()
        if self.invite_secret and not self.invite:
            messages.add_message(
                self.request,
                messages.WARNING,
                _("Sorry, your invitation is no longer valid. Please request a new invite."),
            )

        return initial

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        if self.invite:
            context["invite"] = self.invite
        return context


class UserSettingsView(LoginRequiredMixin, View):
    """
    Lets the current user update their own UI settings - posted top level keys are merged into the existing value.
    """

    # the settings keys the UI is allowed to write
    ALLOWED_KEYS = {"contact_cards", "list_columns"}
    RESIZABLE_LISTS = {"contacts", "msgs"}

    # column names aren't validated against each list's real columns (custom fields make those
    # dynamic), so instead cap how many can accumulate per list
    MAX_LIST_COLUMNS = 20

    def post(self, request, *args, **kwargs):
        if len(request.body) > 100_000:
            return JsonResponse({"error": "request body too large"}, status=400)

        try:
            posted = json.loads(request.body)
        except ValueError:
            posted = None

        if not isinstance(posted, dict):
            return JsonResponse({"error": "request body must be a JSON object"}, status=400)

        if not set(posted) <= self.ALLOWED_KEYS:
            return JsonResponse({"error": "unsupported settings keys"}, status=400)

        if "list_columns" in posted:
            list_columns = posted["list_columns"]
            if not isinstance(list_columns, dict) or any(
                not isinstance(view, str)
                or view not in self.RESIZABLE_LISTS
                or not isinstance(widths, dict)
                or len(widths) > self.MAX_LIST_COLUMNS
                or any(
                    not isinstance(column, str)
                    or not isinstance(width, int)
                    or isinstance(width, bool)
                    or not 80 <= width <= 600
                    for column, width in widths.items()
                )
                for view, widths in list_columns.items()
            ):
                return JsonResponse({"error": "invalid list column settings"}, status=400)

            # Width changes are sent by one list at a time. Merge both the
            # view and column levels so saving one page (or a stale browser
            # tab) can't discard widths saved for another.
            saved_columns = request.user.settings.get("list_columns", {})
            if not isinstance(saved_columns, dict):
                saved_columns = {}
            merged_columns = {**saved_columns}
            for view, widths in list_columns.items():
                saved_widths = saved_columns.get(view)
                merged_widths = {**(saved_widths if isinstance(saved_widths, dict) else {}), **widths}

                # keep the merged set bounded: evict columns not in this save (stale keys from
                # renamed or removed fields) before ones the user just resized
                extra = len(merged_widths) - self.MAX_LIST_COLUMNS
                if extra > 0:
                    for column in [c for c in merged_widths if c not in widths][:extra]:
                        del merged_widths[column]

                merged_columns[view] = merged_widths
            posted["list_columns"] = merged_columns

        request.user.settings = {**request.user.settings, **posted}
        request.user.save(update_fields=("settings",))

        return JsonResponse({"settings": request.user.settings})


class TembaLoginView(TembaInviteMixin, LoginView):
    def get_initial(self):
        initial = super().get_initial()

        if self.invite:
            initial["login"] = self.invite.email
        return initial


class TembaSignupView(TembaInviteMixin, SignupView):
    def get_initial(self):
        initial = super().get_initial()

        if self.invite:
            initial["email"] = self.invite.email
        return initial
