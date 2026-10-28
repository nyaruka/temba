# -*- coding: utf-8 -*-
from __future__ import absolute_import, division, print_function, unicode_literals

from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from temba.utils.fields import SelectWidget

from ...models import Channel
from ...views import ALL_COUNTRIES, ClaimViewMixin


class ClaimView(ClaimViewMixin, SmartFormView):
    class Form(ClaimViewMixin.Form):
        ROLES = (
            (Channel.ROLE_SEND + Channel.ROLE_RECEIVE, _("Messaging")),
            (Channel.ROLE_CALL + Channel.ROLE_ANSWER, _("Voice")),
        )
        country = forms.ChoiceField(
            choices=ALL_COUNTRIES, widget=SelectWidget(attrs={"searchable": True}), label=_("Country")
        )
        number = forms.CharField(max_length=14, min_length=4, label=_("Number"))

        role = forms.ChoiceField(choices=ROLES, label=_("Role"))
        username = forms.CharField(max_length=64, label=_("Username"))
        password = forms.CharField(max_length=64, label=_("Password"))
        account_id = forms.CharField(max_length=64, label=_("Account ID"))

    form_class = Form

    def form_valid(self, form):
        data = form.cleaned_data

        org = self.request.org
        domain = org.get_brand_domain()

        config = {
            Channel.CONFIG_USERNAME: data["username"],
            Channel.CONFIG_PASSWORD: data["password"],
            "account_id": data["account_id"],
            Channel.CONFIG_CALLBACK_DOMAIN: domain,
            Channel.CONFIG_MAX_CONCURRENT_CALLS: 100,
        }
        role = data.get("role")

        self.object = Channel.create(
            org,
            self.request.user,
            data["country"],
            self.channel_type,
            name=f"Bandwidth: {data['number']}",
            address=data["number"],
            config=config,
            role=role,
        )

        return super().form_valid(form)
