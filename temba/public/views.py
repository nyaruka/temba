from smartmin.views import SmartFormView, SmartTemplateView

from django import forms
from django.http import HttpResponse, HttpResponseRedirect, JsonResponse
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from django.views.generic import RedirectView, View

from temba import __version__ as temba_version
from temba.apks.models import Apk
from temba.channels.models import ChannelEvent
from temba.utils import json
from temba.utils.text import generate_secret
from temba.utils.uuid import is_uuid
from temba.utils.views.mixins import ComponentFormMixin, NoNavMixin, SpaMixin


class IndexView(NoNavMixin, ComponentFormMixin, SmartTemplateView):
    template_name = "public/public_index.html"

    def derive_title(self):
        return f"{self.request.branding['name']}"

    def pre_process(self, request, *args, **kwargs):
        response = super().pre_process(request, *args, **kwargs)
        redirect = self.request.branding.get("redirect")
        if redirect:
            return HttpResponseRedirect(redirect)
        return response

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["version"] = temba_version
        return context


class WelcomeRedirect(RedirectView):
    url = "/welcome"


class Style(SmartTemplateView):
    template_name = "public/public_style.html"


class Forgetme(NoNavMixin, ComponentFormMixin, SmartFormView):
    class Form(forms.Form):
        code = forms.CharField(label=_("Confirmation Code"))

        def clean_code(self):
            code = self.data.get("code")
            if not is_uuid(code):
                raise forms.ValidationError(_("Invalid confirmation code"))
            return code

    form_class = Form
    submit_button_name = _("Submit")

    template_name = "public/public_forgetme.html"

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)

        code = self.request.GET.get("code", "")
        event = None
        if code:
            event = ChannelEvent.objects.filter(event_type=ChannelEvent.TYPE_DELETE_CONTACT, uuid=code).first()

        context["unknown_code"] = code and not event
        context["event"] = event
        return context

    def form_valid(self, form):
        code = form.cleaned_data["code"]

        return HttpResponseRedirect(f"{reverse('public.public_forgetme')}?code={code}")


class Android(SmartTemplateView):
    def render_to_response(self, context, **response_kwargs):
        pack = int(self.request.GET.get("pack", 0))
        version = self.request.GET.get("v", "")

        if not pack and not version:
            apk = Apk.objects.filter(apk_type=Apk.TYPE_RELAYER).order_by("-created_on").first()
        else:
            latest_ids = (
                Apk.objects.filter(apk_type=Apk.TYPE_MESSAGE_PACK, version=version, pack=pack)
                .order_by("-created_on")
                .only("id")
                .values_list("id", flat=True)[:10]
            )
            apk = Apk.objects.filter(id__in=latest_ids).order_by("created_on").first()

        if not apk:
            return HttpResponse("No APK found", status=404)
        else:
            return HttpResponseRedirect(apk.apk_file.url)


class Welcome(SpaMixin, SmartTemplateView):
    template_name = "public/public_welcome.html"
    menu_path = "/settings"
    title = _("Getting Started")

    def has_permission(self, request, *args, **kwargs):
        return request.user.is_authenticated


class DemoGenerateCoupon(View):
    """
    Used to demo webhook calls from sample flow
    """

    def post(self, *args, **kwargs):
        return JsonResponse({"coupon": generate_secret(6)})

    def get(self, *args, **kwargs):
        return self.post(*args, **kwargs)


class DemoOrderStatus(View):
    """
    Used to demo webhook calls from sample flow
    """

    def post(self, request, *args, **kwargs):
        if request.method == "POST":
            request_body = json.loads(request.body)
            text = request_body.get("input", dict()).get("text", "")
        else:
            text = request.GET.get("text", "")

        if text.lower() == "cu001":
            response = dict(
                status="Shipped",
                order="CU001",
                name="Ben Haggerty",
                order_number="PLAT2012",
                ship_date="October 9th",
                delivery_date="April 3rd",
                description="Vogue White Wall x 4",
            )

        elif text.lower() == "cu002":
            response = dict(
                status="Pending",
                order="CU002",
                name="Ryan Lewis",
                username="rlewis",
                ship_date="August 14th",
                order_number="FLAG13",
                description="American Flag x 1",
            )

        elif text.lower() == "cu003":
            response = dict(
                status="Cancelled",
                order="CU003",
                name="R Kelly",
                username="rkelly",
                cancel_date="December 2nd",
                order_number="SHET51",
                description="Bed Sheets, Queen x 1",
            )
        else:
            response = dict(status="Invalid")

        return JsonResponse(response)

    def get(self, *args, **kwargs):
        return self.post(*args, **kwargs)
