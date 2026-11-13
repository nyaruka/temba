import logging
from collections import defaultdict
from datetime import timedelta
from typing import Any
from urllib.parse import quote
from uuid import UUID

import phonenumbers
import requests
import twilio.base.exceptions
from smartmin.views import SmartCRUDL, SmartFormView, SmartModelActionView, SmartTemplateView, SmartUpdateView
from twilio.base.exceptions import TwilioRestException
from vonage_http_client.errors import HttpRequestError

from django import forms
from django.conf import settings
from django.contrib import messages
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db.models import Count
from django.http import Http404, HttpResponse, HttpResponseRedirect, JsonResponse
from django.http.response import HttpResponseRedirectBase
from django.shortcuts import get_object_or_404
from django.template import Engine, RequestContext, TemplateDoesNotExist
from django.urls import reverse
from django.utils import timezone
from django.utils.functional import cached_property
from django.utils.translation import gettext, gettext_lazy as _, ngettext

from temba.contacts.models import URN
from temba.ivr.models import Call
from temba.msgs.models import Msg
from temba.orgs.models import Org
from temba.orgs.views.base import BaseDependencyDeleteModal, BaseListComponentView, BaseReadView
from temba.orgs.views.mixins import OrgObjPermsMixin, OrgPermsMixin
from temba.utils import audit, countries
from temba.utils.fields import SelectWidget
from temba.utils.views.mixins import ComponentFormMixin, ContextMenuMixin, ModalFormMixin, SpaMixin

from .models import Channel, ChannelLog

logger = logging.getLogger(__name__)

# the cache of how many channels of each type there are, which orders the new channel picker
CHANNEL_TYPE_POPULARITY_CACHE_KEY = "channel_type_popularity"
CHANNEL_TYPE_POPULARITY_CACHE_TTL = 60 * 60 * 24

ALL_COUNTRIES = countries.choices()


class ChannelTypeMixin(SpaMixin):
    """
    Mixin for views owned by a specific channel type
    """

    channel_type = None

    def __init__(self, channel_type):
        self.channel_type = channel_type

        super().__init__()

    def dispatch(self, request, *args, **kwargs):
        response = super().dispatch(request, *args, **kwargs)

        # a sheet can't follow a redirect without rendering where it goes, so hand it the destination instead
        if self.is_sheet() and isinstance(response, HttpResponseRedirectBase):
            success = HttpResponse()
            success["X-Temba-Success"] = response.url
            return success

        return response


def get_claimable_types(org, user) -> list[dict]:
    """
    Gets the channel types offered by the new channel picker, most used first (see the ordering below). Each says whether it's in the
    workspace's region (types that aren't are only shown when the picker is asked for all regions) and whether it's
    recommended for the workspace.
    """
    types = []
    for ch_type in Channel.get_types():
        if ch_type.claim_view is None or not ch_type.category:
            continue

        in_region, available = ch_type.is_available_to(org, user)
        if not available:
            continue

        types.append(
            {
                "code": ch_type.code,
                "slug": ch_type.slug,
                "name": str(ch_type.name),
                "category": ch_type.picker_category,
                "claim_url": reverse(f"channels.types.{ch_type.slug}.claim"),
                "in_region": bool(in_region),
                "recommended": bool(ch_type.is_recommended_to(org, user)),
            }
        )

    popularity = get_channel_type_popularity()

    # the most used types come first, except that the WhatsApp ones come last (WhatsApp itself first, then its
    # providers) so that they stay together, and Android comes last of its group
    whatsapp = {t.code for t in Channel.get_types() if t.schemes and URN.WHATSAPP_SCHEME in t.schemes}

    def order(t):
        is_whatsapp = t["code"] in whatsapp
        return (
            is_whatsapp,
            is_whatsapp and t["slug"] != "whatsapp",
            t["slug"] == "android",
            -popularity.get(t["code"], 0),
            t["name"].lower(),
        )

    return sorted(types, key=order)


def get_channel_type_popularity() -> dict[str, int]:
    """
    Gets the number of active channels of each type across all workspaces, which orders the new channel picker. It
    changes slowly and counting means scanning every channel, so it's cached for a day.
    """

    def count():
        counts = Channel.objects.filter(is_active=True).values_list("channel_type").annotate(count=Count("id"))
        return {code: num for code, num in counts}

    return cache.get_or_set(CHANNEL_TYPE_POPULARITY_CACHE_KEY, count, timeout=CHANNEL_TYPE_POPULARITY_CACHE_TTL)


def get_channel_help_links(branding: dict) -> dict:
    """
    Gets the help center articles the channel pages link to, keyed by topic (see HELP_LINKS) - none at all for a brand
    without the "support" feature, as its users aren't supported by that help center
    """
    if "support" not in branding.get("features", []):
        return {}

    return {k: v for k, v in settings.HELP_LINKS.items() if k == "channels" or k.startswith("channels.")}


class ChannelMenuMixin:
    """
    For the pages of a single channel, e.g. its read page, logs and configuration, which show under Channels in the menu
    """

    menu_path = "/settings/channels"


class ClaimModalMixin:
    """
    Mixin for the views of a channel type's claim flow - its claim view and any steps before it, like connecting an
    account - which the new channel picker can load into its modal. There only the form and its scripts are rendered,
    and a redirect becomes a response telling the picker where to go next.
    """

    # the header the new channel picker sets when it loads a view into its modal
    MODAL_HEADER = "HTTP_X_TEMBA_CLAIM_MODAL"

    menu_path = "/settings/channels"

    def is_claim_modal(self) -> bool:
        return self.MODAL_HEADER in self.request.META

    def dispatch(self, request, *args, **kwargs):
        # note the newest channel before this request, so we can tell the picker about one it creates - claim flows
        # create channels in different ways, so this is simpler than having each one report what it made
        org = getattr(request, "org", None)
        last_id = None
        if self.is_claim_modal() and request.method == "POST" and org:
            last_id = org.channels.order_by("-id").values_list("id", flat=True).first() or 0

        response = super().dispatch(request, *args, **kwargs)

        # the picker can't follow a redirect itself, so hand it the destination to load or navigate to
        if self.is_claim_modal() and isinstance(response, HttpResponseRedirectBase):
            success = HttpResponse()
            success["X-Temba-Success"] = response.url

            if last_id is not None:
                channel = (
                    org.channels.filter(id__gt=last_id, created_by=request.user, is_active=True).order_by("-id").first()
                )
                if channel:
                    success["X-Temba-Channel"] = str(channel.uuid)
                    success["X-Temba-Channel-Name"] = quote(channel.name or "")
            return success

        return response

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)

        if self.is_claim_modal():
            context["base_template"] = "channels/claim_modal.html"

        return context


class ClaimViewMixin(ClaimModalMixin, ChannelTypeMixin, OrgPermsMixin, ComponentFormMixin):
    permission = "channels.channel_claim"
    submit_button_name = _("Submit")

    class Form(forms.Form):
        def __init__(self, **kwargs):
            self.request = kwargs.pop("request")
            self.channel_type = kwargs.pop("channel_type")
            super().__init__(**kwargs)

        def clean(self):
            if self.channel_type.unique_addresses and Org.FEATURE_SHARED_CHANNELS not in self.request.org.features:
                assert self.cleaned_data.get("address"), "channel type should specify an address in Form.clean method"

                # don't add the same channel address twice
                existing = Channel.objects.filter(
                    is_active=True,
                    address=self.cleaned_data["address"],
                    schemes__overlap=list(self.channel_type.schemes),
                ).first()
                if existing:
                    if existing.org == self.request.org:
                        raise forms.ValidationError(_("This channel is already connected in this workspace."))
                    raise forms.ValidationError(_("This channel is already connected in another workspace."))

            return super().clean()

    def pre_process(self, request, *args, **kwargs):
        if request.org:
            # only the region ignoring flag is a real gate - the region aware one just decides whether the type is
            # listed on the default claim page, and the claim all page deliberately lists types which fail it
            # note that staff aren't exempt - types which want to allow servicing staff do so in is_available_to
            available = self.channel_type.is_available_to(request.org, request.user)[1]
            if not available:
                raise Http404()

            if Channel.is_limit_reached(request.org):
                return HttpResponseRedirect(reverse("channels.channel_list"))

        return super().pre_process(request, *args, **kwargs)

    def get_template_names(self):
        return (
            [self.template_name]
            if self.template_name
            else ["channels/types/%s/claim.html" % self.channel_type.slug, "channels/channel_claim_form.html"]
        )

    def derive_title(self):
        return _("Connect %(channel_type)s") % {"channel_type": self.channel_type.name}

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)

        # what the type is about, shown above its form unless its page says something of its own
        if self.channel_type.claim_blurb:
            context["claim_blurb"] = self.channel_type.get_claim_blurb().render(RequestContext(self.request))
        return context

    def get_form_kwargs(self):
        kwargs = super().get_form_kwargs()
        kwargs["request"] = self.request
        kwargs["channel_type"] = self.channel_type
        return kwargs

    def get_success_url(self):
        # types which need setting up on their side first show how, otherwise there's nothing more to do
        if self.channel_type.config_ui:
            return reverse("channels.channel_configuration", args=[self.object.uuid])
        else:
            return reverse("channels.channel_list")


class AuthenticatedExternalClaimView(ClaimViewMixin, SmartFormView):
    username_label = _("Username")
    username_help = None
    password_label = _("Password")
    password_help = None

    def __init__(self, **kwargs):
        self.username_label = kwargs.pop("username_label", self.username_label)
        self.username_help = kwargs.pop("username_help", self.username_help)
        self.password_label = kwargs.pop("password_label", self.password_label)
        self.password_help = kwargs.pop("password_help", self.password_help)

        super().__init__(**kwargs)

    class Form(ClaimViewMixin.Form):
        country = forms.ChoiceField(
            choices=ALL_COUNTRIES, widget=SelectWidget(attrs={"searchable": True}), label=_("Country")
        )
        number = forms.CharField(
            max_length=14,
            min_length=1,
            label=_("Number"),
            help_text=_("A phone number with country code or a short code, e.g. +250788123124 or 15543."),
        )
        username = forms.CharField(label=_("Username"))
        password = forms.CharField(label=_("Password"))

        def __init__(self, **kwargs):
            super().__init__(**kwargs)

            # most numbers are in the workspace's own country
            if "country" in self.fields and (country := self.request.org.default_country_code):
                self.fields["country"].initial = country

        def clean_number(self):
            number = self.data["number"]

            # number is a shortcode, accept as is
            if len(number) > 0 and len(number) < 7:
                return number

            # otherwise, try to parse into an international format
            if number and number[0] != "+":
                number = "+" + number

            try:
                cleaned = phonenumbers.parse(number, None)
                return phonenumbers.format_number(cleaned, phonenumbers.PhoneNumberFormat.E164)
            except Exception:  # pragma: needs cover
                raise forms.ValidationError(
                    _("Invalid phone number, please include the country code. ex: +250788123123")
                )

    form_class = Form

    def lookup_field_label(self, context, field, default=None):
        if field == "password":
            return self.password_label

        elif field == "username":
            return self.username_label

        return super().lookup_field_label(context, field, default=default)

    def lookup_field_help(self, field, default=None):
        if field == "password":
            return self.password_help

        elif field == "username":
            return self.username_help

        return super().lookup_field_help(field, default=default)

    def get_submitted_country(self, data):
        return data["country"]

    def get_channel_config(self, org, data):
        """
        Subclasses can override this method to add in other channel config variables
        """
        return {}

    def form_valid(self, form):
        org = self.request.org

        data = form.cleaned_data
        extra_config = self.get_channel_config(org, data)
        self.object = Channel.add_authenticated_external_channel(
            org,
            self.request.user,
            self.get_submitted_country(data),
            data["number"],
            data["username"],
            data["password"],
            self.channel_type,
            data.get("url"),
            extra_config=extra_config,
        )

        return super().form_valid(form)


class AuthenticatedExternalCallbackClaimView(AuthenticatedExternalClaimView):
    def get_channel_config(self, org, data):
        return {Channel.CONFIG_CALLBACK_DOMAIN: org.get_brand_domain()}


class BaseClaimNumberMixin(ClaimViewMixin):
    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        org = self.request.org

        try:
            context["account_numbers"] = self.get_existing_numbers(org)
        except Exception as e:
            context["account_numbers"] = []
            context["error"] = str(e)

        context["search_url"] = self.get_search_url()
        context["claim_url"] = self.get_claim_url()

        context["search_countries"] = self.get_search_countries()
        context["supported_country_iso_codes"] = self.get_supported_country_iso_codes()

        return context

    def get_search_countries(self):
        search_countries = []

        for country in self.get_search_countries_tuple():
            search_countries.append(dict(key=country[0], label=country[1]))

        return search_countries

    def get_supported_country_iso_codes(self):
        supported_country_iso_codes = []

        for country in self.get_supported_countries_tuple():
            supported_country_iso_codes.append(country[0])

        return supported_country_iso_codes

    def get_search_countries_tuple(self):  # pragma: no cover
        raise NotImplementedError(
            'method "get_search_countries_tuple" should be overridden in %s.%s'
            % (self.crudl.__class__.__name__, self.__class__.__name__)
        )

    def get_supported_countries_tuple(self):  # pragma: no cover
        raise NotImplementedError(
            'method "get_supported_countries_tuple" should be overridden in %s.%s'
            % (self.crudl.__class__.__name__, self.__class__.__name__)
        )

    def get_search_url(self):  # pragma: no cover
        raise NotImplementedError(
            'method "get_search_url" should be overridden in %s.%s'
            % (self.crudl.__class__.__name__, self.__class__.__name__)
        )

    def get_claim_url(self):  # pragma: no cover
        raise NotImplementedError(
            'method "get_claim_url" should be overridden in %s.%s'
            % (self.crudl.__class__.__name__, self.__class__.__name__)
        )

    def get_existing_numbers(self, org):  # pragma: no cover
        raise NotImplementedError(
            'method "get_existing_numbers" should be overridden in %s.%s'
            % (self.crudl.__class__.__name__, self.__class__.__name__)
        )

    def is_valid_country(self, calling_code: int) -> bool:  # pragma: no cover
        raise NotImplementedError(
            'method "is_valid_country" should be overridden in %s.%s'
            % (self.crudl.__class__.__name__, self.__class__.__name__)
        )

    def is_messaging_country(self, country_code: str) -> bool:  # pragma: no cover
        raise NotImplementedError(
            'method "is_messaging_country" should be overridden in %s.%s'
            % (self.crudl.__class__.__name__, self.__class__.__name__)
        )

    def claim_number(self, user, phone_number, country, role):  # pragma: no cover
        raise NotImplementedError(
            'method "claim_number" should be overridden in %s.%s'
            % (self.crudl.__class__.__name__, self.__class__.__name__)
        )

    def remove_api_credentials_from_session(self):
        pass

    def form_valid(self, form, *args, **kwargs):
        # must have an org
        org = self.request.org
        if not org:  # pragma: needs cover
            form._errors["upgrade"] = True
            form._errors["phone_number"] = form.error_class(
                [
                    _(
                        "Sorry, you need to have a workspace to add numbers. "
                        "You can still test things out for free using an Android phone."
                    )
                ]
            )
            return self.form_invalid(form)

        data = form.cleaned_data

        # no number parse for short codes
        if len(data["phone_number"]) > 6:
            phone = phonenumbers.parse(data["phone_number"])
            if not self.is_valid_country(phone.country_code):  # pragma: needs cover
                form._errors["phone_number"] = form.error_class(
                    [
                        _(
                            "Sorry, the number you chose is not supported. "
                            "You can still deploy in any country using your "
                            "own SIM card and an Android phone."
                        )
                    ]
                )
                return self.form_invalid(form)

        error_message = None

        # try to claim the number
        try:
            role = Channel.ROLE_CALL + Channel.ROLE_ANSWER
            if self.is_messaging_country(data["country"]):
                role += Channel.ROLE_SEND + Channel.ROLE_RECEIVE
            self.claim_number(self.request.user, data["phone_number"], data["country"], role)
            self.remove_api_credentials_from_session()

            return HttpResponseRedirect(reverse("channels.channel_list"))

        except (
            HttpRequestError,
            twilio.base.exceptions.TwilioRestException,
        ) as e:  # pragma: no cover
            logger.warning(f"Unable to claim a number: {str(e)}", exc_info=True)
            error_message = form.error_class([str(e)])

        except ValidationError as e:
            logger.warning(f"Unable to claim a number: {str(e)}", exc_info=True)
            error_message = form.error_class(e.messages)

        except Exception as e:  # pragma: needs cover
            logger.error(f"Unable to claim a number: {str(e)}", exc_info=True)

            message = str(e)
            if message:
                error_message = form.error_class([message])
            else:
                error_message = form.error_class(
                    [
                        _(
                            "An error occurred connecting your Twilio number, try removing your "
                            "Twilio account, reconnecting it and trying again."
                        )
                    ]
                )

        if error_message is not None:
            form._errors["phone_number"] = error_message

        return self.form_invalid(form)


class UpdateChannelForm(forms.ModelForm):
    name = forms.CharField(label=_("Name"), max_length=64, required=True)

    def __init__(self, *args, user, **kwargs):
        super().__init__(*args, **kwargs)

        self.config_fields = []
        self.config_defaults = {}

        if URN.TEL_SCHEME in self.instance.schemes:
            self.add_config_field(
                Channel.CONFIG_ALLOW_INTERNATIONAL,
                forms.BooleanField(required=False, help_text=_("Allows sending to and calling international numbers.")),
                default=False,
            )

        if Channel.ROLE_CALL in self.instance.role:
            self.add_config_field(
                Channel.CONFIG_MACHINE_DETECTION,
                forms.BooleanField(required=False, help_text=_("Hangs up calls answered by an answering machine.")),
                default=False,
            )

        if user.is_staff:
            self.fields["tps"] = forms.IntegerField(
                label=_("TPS"),
                min_value=1,
                max_value=1000,
                required=False,
                initial=self.instance.tps,
                help_text=_("Maximum messages sent per second."),
            )

    def add_config_field(self, config_key: str, field, *, default):
        field.initial = self.instance.config.get(config_key, default)

        self.fields[config_key] = field
        self.config_fields.append(config_key)
        self.config_defaults[config_key] = default

    def get_config_values(self):
        return {k: v for k, v in self.cleaned_data.items() if k in self.config_fields}

    def clean_tps(self):
        # some types set TPS at claim time, e.g. by country, so there's no default to safely reset to
        tps = self.cleaned_data["tps"]
        return tps if tps is not None else self.instance.tps

    def clean(self) -> dict[str, Any]:
        cleaned_data = super().clean()
        config_values = self.get_config_values()
        updated_config = self.instance.config | config_values

        # only check credentials when config has changed (a missing key being unchanged if it's set to its default),
        # so a channel whose credentials have been revoked can still be renamed or disabled
        if any(self.instance.config.get(k, self.config_defaults[k]) != v for k, v in config_values.items()):
            if not self.instance.type.check_credentials(updated_config):
                raise ValidationError(_("Credentials don't appear to be valid."))

        return cleaned_data

    class Meta:
        model = Channel
        fields = ("name", "is_enabled")
        readonly = ()
        labels = {"is_enabled": _("Enabled")}


class ChannelCRUDL(SmartCRUDL):
    model = Channel
    actions = (
        "activity",
        "claim",
        "claim_all",
        "update",
        "read",
        "delete",
        "configuration",
        "logs_list",
        "logs_read",
        "facebook_whitelist",
        "list",
        "syncs",
        "templates",
    )

    class List(BaseListComponentView):
        """
        The workspace's channels, rendered by the temba-channel-list component, with the new channel picker. A
        workspace with no channels opens the picker straight away, as does a request with `new` in its query.
        """

        permission = "channels.channel_list"
        title = _("Channels")
        default_template = "channels/channel_list.html"
        list_endpoint = "api.internal.channels"
        bulk_actions = ()

        menu_path = "/settings/channels"

        def derive_list_query(self) -> str:
            return ""

        @cached_property
        def can_claim(self) -> bool:
            return self.has_org_perm("channels.channel_claim") and not Channel.is_limit_reached(self.request.org)

        def build_context_menu(self, menu):
            if self.can_claim:
                menu.add_js("openChannelPicker", _("New Channel"), primary=True, as_button=True)

        RELEASED_TWILIO_KEY = "released_twilio_channel"

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            org = self.request.org

            context["can_claim"] = self.can_claim
            context["limit_reached"] = Channel.is_limit_reached(org)
            context["help_links"] = get_channel_help_links(self.request.branding)

            # shown once, after a Twilio channel is deleted, as its number lives on in the Twilio account
            context["released_twilio"] = self.request.session.pop(self.RELEASED_TWILIO_KEY, False)

            if self.can_claim:
                has_channels = org.channels.filter(is_active=True).exists()
                context["claimable_types"] = get_claimable_types(org, self.request.user)
                context["open_picker"] = (
                    not has_channels and not context["released_twilio"]
                ) or "new" in self.request.GET

            return context

    class Read(ChannelMenuMixin, SpaMixin, ContextMenuMixin, BaseReadView):
        """
        A channel's dashboard: its status, problems that need attention, summaries of its activity, setup, templates and
        phone, and recent logs. Each summary opens the detail behind it in a sheet over the page.
        """

        RECENT_LOGS = 6

        # sheets of a summary and a table read better narrower than the full width of the window
        NARROW_SHEET_WIDTH = 960
        ACTIVITY_DAYS = 30
        CHART_DAYS = 90
        SPEED_EXAMPLE_CONTACTS = 100_000

        def build_context_menu(self, menu):
            obj = self.get_object()

            # type specific actions like reconnecting open in a sheet
            for name, sheet in self.get_action_sheets(obj).items():
                menu.add_js(f"openSheet_{name}", sheet["header"], as_button=True)

            if obj.channel_type == "FB" and self.has_org_perm("channels.channel_facebook_whitelist"):
                menu.add_modax(
                    _("Whitelist Domain"),
                    "fb-whitelist",
                    reverse("channels.channel_facebook_whitelist", args=[obj.uuid]),
                    as_button=True,
                )

            # deleting is done from the edit dialog
            if self.has_org_perm("channels.channel_update"):
                menu.add_modax(
                    _("Edit"),
                    "update-channel",
                    reverse("channels.channel_update", args=[obj.id]),
                    title=_("Edit Channel"),
                    as_button=True,
                )

        def get_action_sheets(self, channel) -> dict:
            """
            The sheets of the channel type's own actions, e.g. reconnecting its account, which are all claim views
            """
            if not self.has_org_perm("channels.channel_claim"):
                return {}

            return {
                item["view_name"].split(".")[-1]: {
                    "url": reverse(item["view_name"], args=[channel.uuid]),
                    "header": item["label"],
                    "width": self.NARROW_SHEET_WIDTH,
                }
                for item in channel.type.menu_items
            }

        def get_sheets(self, channel) -> dict:
            """
            The sheets the page can open, by name, each with the view it loads and its title - the channel's name and
            what it shows, under the channel's logo
            """
            name = channel.name
            sheets = {
                "activity": {
                    "url": reverse("channels.channel_activity", args=[channel.uuid]),
                    "header": _("%(channel)s Messages") % {"channel": name},
                    "width": self.NARROW_SHEET_WIDTH,
                }
            }

            if channel.type.has_logs and self.has_org_perm("channels.channel_logs"):
                sheets["logs"] = {
                    "url": reverse("channels.channel_logs_list", args=[channel.uuid]),
                    "header": _("%(channel)s Logs") % {"channel": name},
                    "subtitle": _("Logs are kept for 7 days."),
                    "item_header": _("%(channel)s Log") % {"channel": name},
                }
            if channel.type.config_ui and self.has_org_perm("channels.channel_configuration"):
                sheets["setup"] = {
                    "url": reverse("channels.channel_configuration", args=[channel.uuid]),
                    "header": _("%(channel)s Setup") % {"channel": name},
                    "width": self.NARROW_SHEET_WIDTH,
                }
            if channel.type.template_type:
                sheets["templates"] = {
                    "url": reverse("channels.channel_templates", args=[channel.uuid]),
                    "header": _("%(channel)s Templates") % {"channel": name},
                    "width": self.NARROW_SHEET_WIDTH,
                }
            if channel.is_android:
                sheets["syncs"] = {
                    "url": reverse("channels.channel_syncs", args=[channel.uuid]),
                    "header": _("%(channel)s Phone Syncs") % {"channel": name},
                }
            sheets.update(self.get_action_sheets(channel))
            return sheets

        def get_activity(self, channel) -> dict:
            """
            Messages over the last CHART_DAYS for the activity chart, and their totals over the last ACTIVITY_DAYS for
            the messages card
            """
            series = channel.get_daily_series(self.CHART_DAYS)
            received, sent = series["in"][-self.ACTIVITY_DAYS :], series["out"][-self.ACTIVITY_DAYS :]

            return {
                "days": self.ACTIVITY_DAYS,
                "received": sum(received),
                "sent": sum(sent),
                "total": sum(received) + sum(sent),
                "series": [r + s for r, s in zip(received, sent)],
                "chart": Channel.get_activity_chart_json(series),
            }

        def get_speed(self, channel) -> dict:
            """
            How fast the channel sends, as how long a broadcast to SPEED_EXAMPLE_CONTACTS contacts would take
            """
            return {
                "tps": channel.tps,
                "duration": self.get_rough_duration(self.SPEED_EXAMPLE_CONTACTS / channel.tps),
                # very slow channels hold everything up, slow ones just some
                "tone": {"very_slow": "bad", "slow": "warn"}.get(channel.get_speed(), ""),
                "help_url": get_channel_help_links(self.request.branding).get("channels.throughput"),
            }

        @staticmethod
        def get_rough_duration(seconds: float) -> str:
            """
            A duration rounded to read easily, e.g. "a minute", "15 minutes", "3 hours" or "2 days"
            """
            minutes = seconds / 60
            if minutes < 1.5:
                return gettext("a minute")
            if minutes < 10:
                count = round(minutes)
                return ngettext("%(count)d minute", "%(count)d minutes", count) % {"count": count}
            if minutes < 55:
                count = round(minutes / 5) * 5
                return ngettext("%(count)d minute", "%(count)d minutes", count) % {"count": count}

            hours = minutes / 60
            if hours < 1.5:
                return gettext("an hour")
            if hours < 22:
                count = round(hours)
                return ngettext("%(count)d hour", "%(count)d hours", count) % {"count": count}

            days = hours / 24
            if days < 1.5:
                return gettext("a day")
            count = round(days)
            return ngettext("%(count)d day", "%(count)d days", count) % {"count": count}

        def get_recent_logs(self, channel) -> list:
            from .api import ChannelLogsEndpoint

            logs, _prev, _next = ChannelLog.get_by_channel(channel, limit=self.RECENT_LOGS)
            return [ChannelLogsEndpoint.serialize(channel, log) for log in logs]

        @staticmethod
        def describe_template_count(status: str, count: int) -> str:
            """
            Describes a count of templates which aren't approved, e.g. "2 rejected"
            """
            from temba.templates.models import TemplateTranslation as T

            text = {
                T.STATUS_PENDING: ngettext("%(count)d pending", "%(count)d pending", count),
                T.STATUS_REJECTED: ngettext("%(count)d rejected", "%(count)d rejected", count),
                T.STATUS_PAUSED: ngettext("%(count)d paused", "%(count)d paused", count),
                T.STATUS_DISABLED: ngettext("%(count)d disabled", "%(count)d disabled", count),
                T.STATUS_IN_APPEAL: ngettext("%(count)d in appeal", "%(count)d in appeal", count),
            }[status]
            return text % {"count": count}

        def get_template_summary(self, channel) -> dict:
            from temba.request_logs.models import HTTPLog
            from temba.templates.models import TemplateTranslation

            counts = dict(
                channel.template_translations.filter(template__is_active=True)
                .values_list("status")
                .annotate(count=Count("id"))
            )
            last_sync = (
                HTTPLog.objects.filter(channel=channel, log_type=HTTPLog.WHATSAPP_TEMPLATES_SYNCED)
                .order_by("-created_on")
                .only("created_on", "is_error")
                .first()
            )
            others = []
            for status, _label in TemplateTranslation.STATUS_CHOICES:
                if status != TemplateTranslation.STATUS_APPROVED and (count := counts.get(status)):
                    others.append(self.describe_template_count(status, count))

            return {
                "approved": counts.get(TemplateTranslation.STATUS_APPROVED, 0),
                "total": sum(counts.values()),
                "others": others,
                "last_sync": last_sync,
            }

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            channel = self.object

            # paused only matters while the channel is enabled
            context["send_paused"] = channel.is_enabled and channel.is_send_paused()

            context["activity"] = self.get_activity(channel)
            context["speed"] = self.get_speed(channel)

            sheets = self.get_sheets(channel)
            context["sheets"] = sheets

            if "logs" in sheets:
                context["recent_logs"] = self.get_recent_logs(channel)
            if "templates" in sheets:
                context["templates"] = self.get_template_summary(channel)

            if channel.is_android:
                last_sync = channel.last_sync
                context["last_sync"] = last_sync

                # if the phone hasn't synced for an hour, it's not getting messages to send or reporting ones it got
                if last_sync and not channel.is_new():
                    context["delayed_sync"] = (timezone.now() - last_sync.created_on).total_seconds() > 3600

            context["status"] = self.get_status(channel, sheets, context["send_paused"], context.get("delayed_sync"))
            return context

        def get_status(self, channel, sheets: dict, send_paused: bool, delayed_sync: bool) -> dict:
            """
            Whether the channel is working, as the status card shows it: a value and note in a tone, and the sheet that
            explains it - the setup if there is one, unless something else is wrong
            """

            def status(tone, value, note, sheet=None):
                # with nothing in particular to explain it, the card leads to the setup, or else what it's been doing
                sheet = sheet or next(s for s in ("setup", "logs", "activity") if s in sheets)
                more = {
                    "setup": _("View setup"),
                    "logs": _("View logs"),
                    "syncs": _("View syncs"),
                    "activity": _("See activity"),
                }[sheet]
                return {"tone": tone, "value": value, "note": note, "sheet": sheet, "more": more}

            # a disabled channel isn't sending anyway, so whether it's paused doesn't matter
            if not channel.is_enabled:
                return status("", _("Disabled"), _("Won't send or receive messages until it's enabled."))
            if send_paused:
                return status(
                    "bad",
                    _("Paused"),
                    _("The provider isn't accepting messages."),
                    "logs" if "logs" in sheets else None,
                )
            if delayed_sync:
                return status("warn", _("Not syncing"), _("The phone hasn't synced for over an hour."), "syncs")
            if "setup" in sheets and Channel.ROLE_RECEIVE in channel.role and not channel.has_received():
                return status("warn", _("Waiting"), _("Nothing has been received from the provider yet."))
            return status("good", _("Ready"), _("Sending and receiving messages."))

    class Activity(SpaMixin, BaseReadView):
        """
        A channel's messages by day and month, shown in a sheet from its dashboard
        """

        permission = "channels.channel_read"

        # how far back the period can be browsed, and the days before that a period can be compared with
        BROWSE_DAYS = 365
        COMPARE_DAYS = 365

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            channel = self.object

            # up to a year back can be browsed, with the year before that to compare its first days with
            series = channel.get_daily_series(self.BROWSE_DAYS + self.COMPARE_DAYS + 1)
            context["chart"] = Channel.get_activity_chart_json(series)
            context["chart_min"] = max(
                timezone.localdate(channel.created_on), timezone.now().date() - timedelta(days=self.BROWSE_DAYS)
            )

            context["monthly_counts"] = monthly_counts = self.get_monthly_counts()
            context["has_voice"] = any(m["voice_in"] or m["voice_out"] for m in monthly_counts)

            # each month's share of the busiest, for the bar beside it
            for month in monthly_counts:
                month["total"] = month["text_in"] + month["text_out"] + month["voice_in"] + month["voice_out"]
            top = max((m["total"] for m in monthly_counts), default=0)
            for month in monthly_counts:
                month["share"] = round(100 * month["total"] / top) if top else 0
            return context

        def get_monthly_counts(self) -> list:
            today = timezone.now().date()
            until = today + timedelta(days=1)

            # for every month since this channel was started, up to 13 including this one so that this month last year
            # can be compared
            year, month = divmod(today.year * 12 + today.month - 13, 12)
            since = max(self.object.created_on.replace(day=1).date(), today.replace(year=year, month=month + 1, day=1))

            # get our totals grouped by month+scope
            counts = defaultdict(int)
            for (day, scope), count in self.object.get_daily_counts(since, until).items():
                counts[(day.replace(day=1), scope)] += count

            # covert into a table of totals by month
            by_month = []
            month = since
            while month < until:
                by_month.append(
                    dict(
                        month_start=month,
                        text_in=counts.get((month, Channel.TALLY_TEXT_IN), 0),
                        text_out=counts.get((month, Channel.TALLY_TEXT_OUT), 0),
                        voice_in=counts.get((month, Channel.TALLY_VOICE_IN), 0),
                        voice_out=counts.get((month, Channel.TALLY_VOICE_OUT), 0),
                    )
                )
                month = (month + timedelta(days=32)).replace(day=1)

            # reverse our table so most recent is first
            by_month.reverse()
            return by_month

    class Templates(SpaMixin, BaseReadView):
        """
        The templates synced for a channel and whether each has been approved, shown in a sheet from its dashboard
        """

        permission = "channels.channel_read"

        def get_object(self, *args, **kwargs):
            channel = super().get_object(*args, **kwargs)
            if not channel.type.template_type:
                raise Http404()
            return channel

        def get_context_data(self, **kwargs):
            from temba.request_logs.models import HTTPLog

            context = super().get_context_data(**kwargs)
            context["translations"] = (
                self.object.template_translations.filter(template__is_active=True)
                .select_related("template")
                .order_by("template__name", "locale")
            )
            context["last_sync"] = (
                HTTPLog.objects.filter(channel=self.object, log_type=HTTPLog.WHATSAPP_TEMPLATES_SYNCED)
                .order_by("-created_on")
                .first()
            )
            context["can_view_syncs"] = self.has_org_perm("request_logs.httplog_list")
            return context

    class Syncs(SpaMixin, BaseReadView):
        """
        An Android channel's latest syncs with its phone, shown in a sheet from its dashboard
        """

        permission = "channels.channel_read"

        def get_object(self, *args, **kwargs):
            channel = super().get_object(*args, **kwargs)
            if not channel.is_android:
                raise Http404()
            return channel

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["sync_events"] = self.object.sync_events.order_by("-created_on")[:20]
            return context

    class FacebookWhitelist(ComponentFormMixin, ModalFormMixin, OrgObjPermsMixin, SmartModelActionView):
        class DomainForm(forms.Form):
            whitelisted_domain = forms.URLField(
                required=True,
                initial="https://",
                help_text=_("Allows Messenger extensions on this domain, e.g. https://example.com."),
            )

        slug_url_kwarg = "uuid"
        success_url = "uuid@channels.channel_read"
        form_class = DomainForm

        def get_queryset(self):
            return self.request.org.channels.filter(is_active=True, channel_type="FB")

        def execute_action(self):
            # curl -X POST -H "Content-Type: application/json" -d '{
            #  "setting_type" : "domain_whitelisting",
            #  "whitelisted_domains" : ["https://petersfancyapparel.com"],
            #  "domain_action_type": "add"
            # }' "https://graph.facebook.com/v3.3/me/thread_settings?access_token=PAGE_ACCESS_TOKEN"
            access_token = self.object.config[Channel.CONFIG_AUTH_TOKEN]
            response = requests.post(
                "https://graph.facebook.com/v3.3/me/thread_settings?access_token=" + access_token,
                json=dict(
                    setting_type="domain_whitelisting",
                    whitelisted_domains=[self.form.cleaned_data["whitelisted_domain"]],
                    domain_action_type="add",
                ),
            )

            if response.status_code != 200:
                response_json = response.json()
                default_error = dict(message=_("An error occured contacting the Facebook API"))
                raise ValidationError(response_json.get("error", default_error)["message"])

    class Delete(BaseDependencyDeleteModal):
        cancel_url = "uuid@channels.channel_read"
        success_url = "@channels.channel_list"

        def post(self, request, *args, **kwargs):
            channel = self.get_object()

            try:
                channel.release(request.user)
            except TwilioRestException as e:
                messages.error(
                    request,
                    _("Twilio reported an error removing your channel (error code %(code)s). Please try again later.")
                    % {"code": e.code},
                )

                response = HttpResponse()
                response["X-Temba-Success"] = self.cancel_url
                return response

            # the Twilio number itself still exists, which the channel list points out
            if channel.channel_type == "T":
                request.session[ChannelCRUDL.List.RELEASED_TWILIO_KEY] = True

            response = HttpResponse()
            response["X-Temba-Success"] = self.get_success_url()
            return response

    class Update(ComponentFormMixin, ModalFormMixin, OrgObjPermsMixin, SmartUpdateView):
        submit_button_name = _("Save")
        field_config = {
            "is_enabled": {
                "help": _("Makes channel available for sending. Incoming messages will be archived if not enabled.")
            }
        }

        def derive_title(self):
            return _("%s Channel") % self.object.type.name

        def derive_readonly(self):
            return self.form.Meta.readonly if hasattr(self, "form") else []

        def get_success_url(self):
            return reverse("channels.channel_read", args=[self.object.uuid])

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)

            # the channel is deleted from here rather than from its page
            if self.has_org_perm("channels.channel_delete"):
                context["delete_url"] = reverse("channels.channel_delete", args=[self.object.uuid])
            return context

        def get_form_class(self):
            return self.object.type.get_update_form()

        def get_form_kwargs(self):
            kwargs = super().get_form_kwargs()
            kwargs["user"] = self.request.user
            return kwargs

        def derive_initial(self):
            initial = super().derive_initial()
            initial["role"] = [char for char in self.object.role]
            return initial

        def pre_save(self, obj):
            obj = super().pre_save(obj)
            obj.config.update(self.form.get_config_values())

            self.previous_tps = obj.tps
            if "tps" in self.form.cleaned_data:
                obj.tps = self.form.cleaned_data["tps"]

            return obj

        def post_save(self, obj):
            obj = super().post_save(obj)

            if obj.tps != self.previous_tps:
                audit.record(
                    "channel.tps_changed",
                    org=obj.org,
                    channel=str(obj.uuid),
                    tps=obj.tps,
                    previous_tps=self.previous_tps,
                )

            return obj

    class Claim(OrgPermsMixin, SmartTemplateView):
        """
        Channels are added from the new channel picker on the list page, so this opens that
        """

        def get(self, request, *args, **kwargs):
            return HttpResponseRedirect(reverse("channels.channel_list") + "?new=1")

    class ClaimAll(Claim):
        pass

    class Configuration(ChannelMenuMixin, SpaMixin, BaseReadView):
        def pre_process(self, request, *args, **kwargs):
            channel = self.get_object()
            if not channel.type.config_ui:
                return HttpResponseRedirect(reverse("channels.channel_read", args=[channel.uuid]))

            return super().pre_process(request, *args, **kwargs)

        def render_type_template(self, channel, name: str) -> str:
            try:
                return (
                    Engine.get_default()
                    .get_template(f"channels/types/{channel.type.slug}/{name}")
                    .render(context=RequestContext(self.request, channel.type.get_config_ui_context(channel)))
                )
            except TemplateDoesNotExist:
                return None

        def get(self, request, *args, **kwargs):
            # the page polls this while it waits for the channel's first message, so it can say when setup is working
            if "status" in request.GET:
                return JsonResponse({"receiving": self.get_object().has_received()})

            return super().get(request, *args, **kwargs)

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            channel = self.object
            config_ui = channel.type.config_ui

            endpoints = []
            for endpoint in config_ui.get_used_endpoints(channel):
                endpoints.append(dict(url=endpoint.get_url(channel), label=endpoint.label, help=endpoint.help))

            if config_ui.show_secret:
                secret = channel.secret or channel.config.get("secret")
            else:
                secret = None

            # a type's own template replaces the generic intro, and holds whatever else it needs to explain
            context["custom"] = self.render_type_template(channel, "config.html")
            # or it can add its own steps, for types with more to set up than a list of URLs
            context["custom_steps"] = self.render_type_template(channel, "config_steps.html")
            context["blurb"] = config_ui.blurb
            context["endpoints"] = endpoints
            context["secret"] = secret
            context["ip_addresses"] = settings.IP_ADDRESSES if config_ui.show_public_ips else None
            context["receiving"] = channel.has_received()
            context["guide_url"] = get_channel_help_links(self.request.branding).get(
                f"channels.types.{channel.type.slug}"
            )
            return context

    class LogsList(ChannelMenuMixin, SpaMixin, BaseReadView):
        """
        A channel's logs - the page is a shell for the log list component, which fetches and pages them itself
        """

        permission = "channels.channel_logs"

        @classmethod
        def derive_url_pattern(cls, path, action):
            return r"^%s/logs/(?P<uuid>[0-9a-f-]{36})/$" % path

        def get_object(self, *args, **kwargs):
            channel = super().get_object(*args, **kwargs)
            if not channel.type.has_logs:
                raise Http404()
            return channel

        def derive_title(self):
            return _("%(channel)s Logs") % {"channel": self.object.name}

        def get_context_data(self, **kwargs):
            context = super().get_context_data(**kwargs)
            context["list_url"] = f"{reverse('api.internal.channel_logs')}.json?channel={self.object.uuid}"

            # a log to show beside the list, which has to be one of this channel's
            selected = self.request.GET.get("selected", "")
            if selected.startswith(self.request.path):
                context["selected"] = selected
            return context

    class LogsRead(ChannelMenuMixin, SpaMixin, BaseReadView):
        permission = "channels.channel_logs"
        title = _("Channel Log")

        @classmethod
        def derive_url_pattern(cls, path, action):
            return r"^%s/logs/(?P<uuid>[0-9a-f-]{36})/(?P<reftype>log|msg|call)/(?P<refid>[0-9a-f-]{36})/$" % path

        def get_object(self, *args, **kwargs):
            channel = super().get_object(*args, **kwargs)
            if not channel.type.has_logs:
                raise Http404()
            return channel

        @cached_property
        def owner(self) -> Msg | Call | None:
            if self.kwargs["reftype"] == "msg":
                return get_object_or_404(Msg, uuid=UUID(self.kwargs["refid"]), org=self.request.org)
            elif self.kwargs["reftype"] == "call":
                return get_object_or_404(Call, uuid=UUID(self.kwargs["refid"]), org=self.request.org)
            return None

        def get_logs_and_urn(self) -> tuple:
            if self.owner:
                return self.owner.get_logs(), self.owner.contact_urn

            return ChannelLog.get_by_uuid(self.object, [UUID(self.kwargs["refid"])]), None

        def get_context_data(self, **kwargs):
            anonymize = self.request.org.is_anon and not (self.request.GET.get("break") and self.request.user.is_staff)
            raw_logs, owner_urn = self.get_logs_and_urn()

            logs = []
            for log in raw_logs:
                display = log.get_display(anonymize=anonymize, urn=owner_urn)
                display["type_display"] = log.get_log_type_display()
                logs.append(display)

            context = super().get_context_data(**kwargs)
            context["msg"] = self.owner if isinstance(self.owner, Msg) else None
            context["call"] = self.owner if isinstance(self.owner, Call) else None
            context["logs"] = logs
            return context
