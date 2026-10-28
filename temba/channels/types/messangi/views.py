# -*- coding: utf-8 -*-
from __future__ import absolute_import, division, print_function, unicode_literals

from smartmin.views import SmartFormView

from django import forms
from django.utils.translation import gettext_lazy as _

from ...models import Channel
from ...views import ClaimViewMixin


class ClaimView(ClaimViewMixin, SmartFormView):
    class MGClaimForm(ClaimViewMixin.Form):
        shortcode = forms.CharField(max_length=15, min_length=1)
        carrier_id = forms.IntegerField(label=_("Carrier Id"))
        public_key = forms.CharField(max_length=30, min_length=1, label=_("Public Key"))
        private_key = forms.CharField(max_length=30, min_length=1, label=_("Private Key"))
        instance_id = forms.IntegerField(label=_("Instance Id"))

    form_class = MGClaimForm

    def form_valid(self, form):
        data = form.cleaned_data

        from .type import MessangiType

        config = {
            MessangiType.CONFIG_PUBLIC_KEY: data["public_key"],
            MessangiType.CONFIG_PRIVATE_KEY: data["private_key"],
            MessangiType.CONFIG_CARRIER_ID: data["carrier_id"],
            MessangiType.CONFIG_INSTANCE_ID: data["instance_id"],
        }

        self.object = Channel.create(
            self.request.org,
            self.request.user,
            "JM",
            self.channel_type,
            name="Messangi: %s" % data["shortcode"],
            address=data["shortcode"],
            config=config,
        )

        return super(ClaimView, self).form_valid(form)
