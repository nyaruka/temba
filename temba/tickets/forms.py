from django import forms
from django.utils.translation import gettext_lazy as _

from temba.orgs.views.mixins import UniqueNameMixin
from temba.utils.fields import CheckboxWidget, SelectMultipleWidget

from .models import Shortcut, Team, Topic


class ShortcutForm(UniqueNameMixin, forms.ModelForm):
    def __init__(self, org, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.org = org

    class Meta:
        model = Shortcut
        fields = ("name", "text")


class TeamForm(UniqueNameMixin, forms.ModelForm):
    all_topics = forms.BooleanField(
        label=_("All topics"),
        help_text=_("Members can access tickets of any topic, including topics created later."),
        required=False,
        initial=True,
        widget=CheckboxWidget(attrs={"widget_only": True}),
    )
    topics = forms.ModelMultipleChoiceField(
        queryset=Topic.objects.none(), required=False, widget=SelectMultipleWidget(attrs={"optional": False})
    )

    def __init__(self, org, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.org = org
        self.fields["topics"].queryset = org.topics.filter(is_active=True)

    def clean_topics(self):
        topics = self.cleaned_data["topics"]

        # topics are ignored for a team that can access all topics
        if self.cleaned_data.get("all_topics"):
            return topics.none()

        if not topics:
            raise forms.ValidationError(_("Select at least one topic or allow access to all topics."))

        if len(topics) > Team.max_topics:
            raise forms.ValidationError(
                _("Teams can have at most %(limit)d topics."), params={"limit": Team.max_topics}
            )
        return topics

    class Meta:
        model = Team
        fields = ("name", "all_topics", "topics")


class TopicForm(UniqueNameMixin, forms.ModelForm):
    def __init__(self, org, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.org = org

    class Meta:
        model = Topic
        fields = ("name",)
