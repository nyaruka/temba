import logging
from datetime import date, datetime, timedelta
from urllib.parse import quote, urlencode

from smartmin.views import SmartFormView, SmartModelActionView, SmartModelFormView

from django import forms
from django.contrib import messages
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.http import HttpResponse, HttpResponseRedirect, JsonResponse
from django.utils import timezone
from django.utils.functional import cached_property

from temba import __version__ as temba_version
from temba.utils.fields import CheckboxWidget, DateWidget, InputWidget, SelectMultipleWidget, SelectWidget

logger = logging.getLogger(__name__)

TEMBA_MENU_SELECTION = "temba_menu_selection"
TEMBA_CONTENT_ONLY = "X-Temba-Content-Only"
TEMBA_VERSION = "X-Temba-Version"


class NoNavMixin:
    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["base_template"] = "no_nav.html"
        return context


class NonAtomicMixin:
    """
    Utility mixin to disable automatic transaction wrapping of a class based view
    """

    @transaction.non_atomic_requests
    def dispatch(self, request, *args, **kwargs):
        return super().dispatch(request, *args, **kwargs)


class PostOnlyMixin:
    """
    Utility mixin to make a class based view be POST only
    """

    def get(self, *args, **kwargs):
        return HttpResponse("Method Not Allowed", status=405)


class StaffOnlyMixin:
    """
    Views that only staff should be able to access
    """

    def has_permission(self, request, *args, **kwargs):
        return self.request.user.is_staff


class ComponentFormMixin:
    """
    Mixin to replace form field controls with component based widgets
    """

    def customize_form_field(self, name, field):
        attrs = field.widget.attrs if field.widget.attrs else {}

        # don't replace the widget if it is already one of us
        if isinstance(
            field.widget,
            (forms.widgets.HiddenInput, CheckboxWidget, InputWidget, SelectWidget, SelectMultipleWidget, DateWidget),
        ):
            return field

        if isinstance(field.widget, (forms.widgets.Textarea,)):
            attrs["textarea"] = True
            field.widget = InputWidget(attrs=attrs)
        elif isinstance(field.widget, (forms.widgets.PasswordInput,)):  # pragma: needs cover
            attrs["password"] = True
            field.widget = InputWidget(attrs=attrs)
        elif isinstance(
            field.widget,
            (forms.widgets.TextInput, forms.widgets.EmailInput, forms.widgets.URLInput, forms.widgets.NumberInput),
        ):
            field.widget = InputWidget(attrs=attrs)
        elif isinstance(field.widget, (forms.widgets.Select,)):
            if isinstance(field, (forms.models.ModelMultipleChoiceField,)):
                field.widget = SelectMultipleWidget(attrs)  # pragma: needs cover
            else:
                field.widget = SelectWidget(attrs)

            field.widget.choices = field.choices
        elif isinstance(field.widget, (forms.widgets.CheckboxInput,)):
            field.widget = CheckboxWidget(attrs)

        return field


class ContextMenuMixin:
    """
    Mixin for views that have a context menu (hamburger icon with dropdown items)
    """

    class Menu:
        """
        Utility for building the menus
        """

        def __init__(self):
            self.groups = [[]]

        def new_group(self):
            self.groups.append([])

        def add_link(self, label: str, url: str, as_button: bool = False):
            self.groups[-1].append({"type": "link", "label": label, "url": url, "as_button": as_button})

        def add_js(self, id: str, label: str, as_button: bool = False):
            self.groups[-1].append(
                {
                    "id": id,
                    "type": "js",
                    "label": label,
                    "as_button": as_button,
                }
            )

        def add_url_post(self, label: str, url: str, as_button: bool = False):
            self.groups[-1].append({"type": "url_post", "label": label, "url": url, "as_button": as_button})

        def add_modax(
            self,
            label: str,
            modal_id: str,
            url: str,
            *,
            title: str = None,
            on_submit: str = None,
            on_redirect: str = None,
            primary: bool = False,
            as_button: bool = False,
            disabled: bool = False,
        ):
            self.groups[-1].append(
                {
                    "type": "modax",
                    "label": label,
                    "url": url,
                    "modal_id": modal_id,
                    "title": title or label,
                    "on_submit": on_submit,
                    "on_redirect": on_redirect,
                    "primary": primary,
                    "as_button": as_button,
                    "disabled": disabled,
                }
            )

        def as_items(self):
            """
            Reduce groups to a flat list of items separated by dividers.
            """
            items = []
            for group in self.groups:
                if not group:
                    continue
                if items:
                    items.append({"type": "divider"})
                items.extend(group)
            return items

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)

        # does the page have a content menu?
        context["has_context_menu"] = self.has_context_menu()

        # does the page have a search query?
        if "search" in self.request.GET:
            context["has_search_query"] = urlencode({"search": self.request.GET["search"]})

        return context

    def has_context_menu(self):
        """
        If creating the context menu is non-trivial, views can override this
        """
        return len(self._get_context_menu()) > 0

    def _get_context_menu(self):
        menu = self.Menu()
        self.build_context_menu(menu)
        return menu.as_items()

    def build_context_menu(self, menu: Menu):  # pragma: no cover
        pass

    def get(self, request, *args, **kwargs):
        if "HTTP_X_TEMBA_CONTENT_MENU" in self.request.META:
            return JsonResponse({"items": self._get_context_menu()})

        return super().get(request, *args, **kwargs)


class ModalHeaderMixin:
    """
    Mixin for views rendered in a modax that want to customize the modal header colors.
    """

    modal_header_bg = None
    modal_header_text = None

    def render_to_response(self, context, **response_kwargs):
        response = super().render_to_response(context, **response_kwargs)
        if self.modal_header_bg:
            response["X-Temba-Header-Bg"] = self.modal_header_bg
        if self.modal_header_text:
            response["X-Temba-Header-Text"] = self.modal_header_text
        return response


class ModalFormMixin(SmartFormView):
    """
    TODO rework this to be an actual mixin
    """

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)

        if "HTTP_X_PJAX" in self.request.META and "HTTP_X_FORMAX" not in self.request.META:  # pragma: no cover
            context["base_template"] = "smartmin/modal.html"
            context["is_modal"] = True
        if "success_url" in kwargs:  # pragma: no cover
            context["success_url"] = kwargs["success_url"]

        pairs = [quote(k) + "=" + quote(v) for k, v in self.request.GET.items() if k != "_"]
        context["action_url"] = self.request.path + "?" + ("&".join(pairs))

        return context

    def render_modal_response(self, form=None):
        success_url = self.get_success_url()
        response = self.render_to_response(
            self.get_context_data(
                form=form,
                success_url=self.get_success_url(),
                success_script=getattr(self, "success_script", None),
            )
        )

        response["X-Temba-Success"] = success_url
        return response

    def form_valid(self, form):
        if isinstance(form, forms.ModelForm):
            self.object = form.save(commit=False)

        try:
            if isinstance(self, SmartModelFormView):
                self.object = self.pre_save(self.object)
                self.save(self.object)
                self.object = self.post_save(self.object)

            elif isinstance(self, SmartModelActionView):
                self.execute_action()

            messages.success(self.request, self.derive_success_message())

            if "HTTP_X_PJAX" not in self.request.META:
                return HttpResponseRedirect(self.get_success_url())
            else:  # pragma: no cover
                return self.render_modal_response(form)

        except (IntegrityError, ValueError, ValidationError) as e:
            message = getattr(e, "message", str(e).capitalize())
            self.form.add_error(None, message)
            return self.render_to_response(self.get_context_data(form=form))


class SpaMixin:
    """
    Uses SPA base template if the header is set appropriately
    """

    @cached_property
    def spa_path(self) -> tuple:
        return tuple(s for s in self.request.META.get("HTTP_X_TEMBA_PATH", "").split("/") if s)

    @cached_property
    def spa_referrer_path(self) -> tuple:
        return tuple(s for s in self.request.META.get("HTTP_X_TEMBA_REFERER_PATH", "").split("/") if s)

    def is_content_only(self):
        return "HTTP_X_TEMBA_SPA" in self.request.META

    def get_template_names(self):
        templates = super().get_template_names()
        spa_templates = []

        for template in templates:
            original = template.split(".")
            if len(original) == 2:
                spa_template = original[0] + "_spa." + original[1]
            if spa_template:
                spa_templates.append(spa_template)

        return spa_templates + templates

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["temba_version"] = temba_version

        if self.request.org:
            context["active_org"] = self.request.org

        if self.is_content_only():
            context["base_template"] = "spa.html"
        else:
            context["base_template"] = "frame.html"

        context["is_spa"] = True
        context["is_content_only"] = self.is_content_only()
        context["temba_path"] = self.spa_path
        context["temba_referer"] = self.spa_referrer_path
        context[TEMBA_MENU_SELECTION] = self.derive_menu_path()

        return context

    def derive_menu_path(self):
        if hasattr(self, "menu_path"):
            return self.menu_path
        return self.request.path

    def render_to_response(self, context, **response_kwargs):
        response = super().render_to_response(context, **response_kwargs)
        response.headers[TEMBA_VERSION] = temba_version
        response.headers[TEMBA_MENU_SELECTION] = context[TEMBA_MENU_SELECTION]
        response.headers[TEMBA_CONTENT_ONLY] = 1 if self.is_content_only() else 0
        return response


class ChartViewMixin:
    """
    Mixin for views that return chart data.
    """

    default_chart_period = (-timedelta(days=90), timedelta(days=1))

    def get_chart_period(self) -> tuple[date, date]:
        def param(name: str, default: date):
            if name in self.request.GET:
                try:
                    return datetime.strptime(self.request.GET[name], r"%Y-%m-%d").date()
                except ValueError:
                    pass
            return default

        since = param("since", timezone.now().date() + self.default_chart_period[0])
        until = param("until", timezone.now().date() + self.default_chart_period[1])
        return since, until

    def get_chart_data(self, since: date, until: date) -> tuple[list, list]:  # pragma: no cover
        pass

    def render_to_response(self, context, **response_kwargs):
        since, until = self.get_chart_period()
        labels, datasets = self.get_chart_data(since, until)

        return JsonResponse(
            {
                "period": [since, until],
                "data": {"labels": labels, "datasets": datasets},
            }
        )
