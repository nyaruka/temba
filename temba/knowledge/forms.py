import re

from django import forms
from django.conf import settings
from django.utils.translation import gettext_lazy as _

from temba.orgs.views.mixins import UniqueNameMixin
from temba.utils.fields import CheckboxWidget, ColorInputWidget, InputWidget, SelectWidget

from .models import Article, HelpdeskImport, HelpSite, KnowledgeSource


class MarkdownEditorWidget(forms.Widget):
    """
    The article body editor - a rich editor over the article's markdown, with a formatting toolbar and screenshot
    uploads. It renders client side, escaping raw HTML the same way the read page does.
    """

    template_name = "knowledge/forms/markdown_editor.html"
    is_annotated = True

    # The form's title field, when the title is to be edited at the head of the article as the site shows it. It's
    # slotted into the editor as the input it is - so its name, value, length and errors stay the form's - and the
    # editor draws it as the site's heading. Set by the view that has the bound form.
    title = None

    def get_context(self, name, value, attrs):
        context = super().get_context(name, value, attrs)
        context["title"] = self.title
        return context


class KnowledgeSourceForm(UniqueNameMixin, forms.ModelForm):
    """
    Create form - the type picker plus the website-only settings.
    """

    source_type = forms.ChoiceField(
        choices=(
            (KnowledgeSource.TYPE_WEBSITE, _("Website")),
            (KnowledgeSource.TYPE_DOCUMENTS, _("Documents")),
        ),
        label=_("Type"),
        widget=SelectWidget(attrs={"widget_only": False}),
    )
    url = forms.URLField(
        required=False,
        max_length=KnowledgeSource.MAX_URL_LEN,
        label=_("URL"),
        widget=InputWidget(),
        help_text=_("The address to crawl, e.g. https://help.example.com"),
    )
    max_pages = forms.IntegerField(
        required=False, min_value=1, max_value=KnowledgeSource.MAX_MAX_PAGES, label=_("Max Pages"), widget=InputWidget()
    )
    refresh = forms.ChoiceField(
        choices=KnowledgeSource.REFRESH_CHOICES, required=False, label=_("Refresh"), widget=SelectWidget()
    )

    def __init__(self, org, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.org = org

    def clean(self):
        cleaned = super().clean()
        if cleaned.get("source_type") == KnowledgeSource.TYPE_WEBSITE and not cleaned.get("url"):
            self.add_error("url", _("This field is required."))
        return cleaned

    class Meta:
        model = KnowledgeSource
        fields = ("name", "source_type", "url", "max_pages", "refresh")
        widgets = {"name": InputWidget()}


class KnowledgeSourceUpdateForm(UniqueNameMixin, forms.ModelForm):
    """
    Update form - type is fixed; website sources also expose their crawl settings.
    """

    url = forms.URLField(required=True, max_length=KnowledgeSource.MAX_URL_LEN, label=_("URL"), widget=InputWidget())
    max_pages = forms.IntegerField(
        required=False, min_value=1, max_value=KnowledgeSource.MAX_MAX_PAGES, label=_("Max Pages"), widget=InputWidget()
    )
    refresh = forms.ChoiceField(
        choices=KnowledgeSource.REFRESH_CHOICES, required=False, label=_("Refresh"), widget=SelectWidget()
    )

    def __init__(self, org, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.org = org

        if self.instance.source_type != KnowledgeSource.TYPE_WEBSITE:
            for f in ("url", "max_pages", "refresh"):
                del self.fields[f]
        else:
            self.fields["url"].initial = self.instance.config.get(KnowledgeSource.CONFIG_URL)
            self.fields["max_pages"].initial = self.instance.config.get(KnowledgeSource.CONFIG_MAX_PAGES)
            self.fields["refresh"].initial = self.instance.config.get(KnowledgeSource.CONFIG_REFRESH)

    class Meta:
        model = KnowledgeSource
        fields = ("name",)
        widgets = {"name": InputWidget()}


class ArticleForm(forms.ModelForm):
    """
    Create and update form for a helpdesk article. Publishing isn't a field here - the editor asks for it explicitly
    alongside the save, so that saving an edit can never silently make a draft public.
    """

    def __init__(self, org, *args, **kwargs):
        super().__init__(*args, **kwargs)

        if "body" in self.fields:  # the create form asks only for a title
            self.fields["body"].max_length = Article.MAX_BODY_LEN

    class Meta:
        model = Article
        fields = ("title", "body")
        widgets = {
            "title": InputWidget(attrs={"widget_only": False}),
            "body": MarkdownEditorWidget(),
        }
        labels = {"title": _("Title"), "body": _("Body")}


class ArticleCreateForm(ArticleForm):
    """
    New articles are created with just a title - the body is written on the editor page they land on.
    """

    class Meta(ArticleForm.Meta):
        fields = ("title",)


class SectionForm(forms.ModelForm):
    """
    A section - a root of the helpdesk tree - is a heading over the articles filed under it, so it's titled and
    described in plain text rather than written.
    """

    description = forms.CharField(
        label=_("Description"),
        required=False,
        max_length=Article.MAX_DESCRIPTION_LEN,
        widget=InputWidget(attrs={"widget_only": False, "textarea": True}),
    )

    def __init__(self, org, *args, **kwargs):
        super().__init__(*args, **kwargs)

    class Meta:
        model = Article
        fields = ("title", "description")
        widgets = {"title": InputWidget(attrs={"widget_only": False})}
        labels = {"title": _("Title")}


class HelpSiteForm(forms.ModelForm):
    """
    The help site's settings - what it says about itself, whether it's up, where it lives, and its few colors.
    """

    COLOR_PATTERN = re.compile(r"^#[0-9a-f]{6}$")

    title = forms.CharField(
        max_length=HelpSite.MAX_TITLE_LEN,
        label=_("Title"),
        help_text=_("The name of your help site, shown in its header."),
        widget=InputWidget(),
    )
    tagline = forms.CharField(
        required=False,
        max_length=HelpSite.MAX_TAGLINE_LEN,
        label=_("Tagline"),
        help_text=_("A welcome shown above the search on the home page."),
        widget=InputWidget(),
    )
    footer = forms.CharField(
        required=False,
        max_length=HelpSite.MAX_FOOTER_LEN,
        label=_("Footer"),
        help_text=_("Shown at the bottom of every page."),
        widget=InputWidget(),
    )
    primary_color = forms.CharField(
        label=_("Primary Color"),
        help_text=_("Used for links, buttons and highlights."),
        widget=ColorInputWidget(),
    )
    header_color = forms.CharField(
        label=_("Header Color"),
        help_text=_("The background of the header on every page."),
        widget=ColorInputWidget(),
    )
    # the bubbles share a help text, which the dialog shows beneath all three of them
    bubble_1 = forms.CharField(
        required=False, label=_("Bubble 1"), widget=ColorInputWidget(attrs={"placeholder": _("None")})
    )
    bubble_2 = forms.CharField(
        required=False, label=_("Bubble 2"), widget=ColorInputWidget(attrs={"placeholder": _("None")})
    )
    bubble_3 = forms.CharField(
        required=False, label=_("Bubble 3"), widget=ColorInputWidget(attrs={"placeholder": _("None")})
    )

    def __init__(self, org, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def _clean_color(self, field: str, required: bool) -> str:
        value = (self.cleaned_data[field] or "").strip().lower()
        if not value and not required:
            return ""
        if not self.COLOR_PATTERN.match(value):
            raise forms.ValidationError(_("Not a valid color."))
        return value

    def clean_primary_color(self):
        return self._clean_color("primary_color", required=True)

    def clean_header_color(self):
        return self._clean_color("header_color", required=True)

    def clean_bubble_1(self):
        return self._clean_color("bubble_1", required=False)

    def clean_bubble_2(self):
        return self._clean_color("bubble_2", required=False)

    def clean_bubble_3(self):
        return self._clean_color("bubble_3", required=False)

    class Meta:
        model = HelpSite
        fields = ("title", "tagline", "footer")


class HelpSiteDomainForm(forms.ModelForm):
    """
    The domain the site is served on - which the org then proves is theirs before it's served, see the domain
    dialog - and whether it's served at all. The domain is set through the model rather than as a field of the
    form, so a change starts verification over.
    """

    DOMAIN_PATTERN = re.compile(r"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")

    domain = forms.CharField(
        required=False,
        max_length=HelpSite.MAX_DOMAIN_LEN,
        label=_("Domain"),
        help_text=_("A domain of your own to serve your help site on, such as help.example.com."),
        # the dialog shows the records to add for whatever domain is being typed - see helpsite_domain.html
        widget=InputWidget(attrs={"placeholder": "help.example.com", "oninput": "updateHelpSiteRecords(this)"}),
    )

    is_enabled = forms.BooleanField(
        required=False,
        label=_("Enabled"),
        help_text=_("Whether the site is available to the public on its domain."),
        widget=CheckboxWidget(),
    )

    def __init__(self, org, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def _get_validation_exclusions(self):
        # the domain is validated here and written by set_domain, never through the instance - which still holds the
        # old value, or none, when the model would otherwise be asked to validate it
        return super()._get_validation_exclusions() | {"domain"}

    def clean_domain(self):
        value = HelpSite.clean_domain(self.cleaned_data["domain"])
        if value:
            if not self.DOMAIN_PATTERN.match(value):
                raise forms.ValidationError(_("Not a valid domain name."))
            # a subdomain of our own is fine - it's how we'll serve our own helpdesk - but the app's domain itself
            # can't be a help site
            if value == settings.BRAND["domain"]:
                raise forms.ValidationError(_("Can't use the default domain."))
            # a domain another site has proven is theirs can't be claimed here - an unverified claim on it can
            taken = HelpSite.objects.filter(domain=value).exclude(domain_verified_on=None).exclude(id=self.instance.id)
            if taken.exists():
                raise forms.ValidationError(_("This domain is already in use by another help site."))
        return value

    class Meta:
        model = HelpSite
        fields = ("is_enabled",)


class HelpdeskImportForm(forms.ModelForm):
    """
    Base form for what an import type needs to bring a help site over. A type's own form declares the fields, and
    what they collect - checked with the other site here, so the dialog says now if it's wrong - becomes the
    import's config.
    """

    def __init__(self, org, import_type, *args, **kwargs):
        self.org = org
        self.import_type = import_type
        super().__init__(*args, **kwargs)

    def get_config(self) -> dict:
        """
        What the import is given to work with - the type's own fields, not the modal's plumbing.
        """
        return {name: self.cleaned_data[name] for name in self.declared_fields if name in self.cleaned_data}

    class Meta:
        model = HelpdeskImport
        fields = ()
