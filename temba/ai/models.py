from abc import ABCMeta

from django.conf import settings
from django.contrib.postgres.indexes import OpClass
from django.db import models
from django.db.models import Q
from django.db.models.functions import Lower
from django.template import Engine
from django.urls import re_path

from temba import mailroom
from temba.orgs.models import DependencyMixin, Org
from temba.utils.models import TembaModel, delete_in_batches
from temba.utils.models.counts import BaseDailyCount


class LLMType(metaclass=ABCMeta):
    """
    Base type for all LLM model types
    """

    # icon to show in UI
    icon = "icon-llm"

    # the view that handles connection of a new model
    connect_view = None

    # the blurb to show on the connect form page
    form_blurb = None

    def get_form_blurb(self):
        """
        Gets the blurb to show on the connect form
        """
        return Engine.get_default().from_string(self.form_blurb)

    def get_urls(self):
        """
        Returns all the URLs this llm exposes to Django, the URL should be relative.
        """
        return [re_path(r"^connect", self.connect_view.as_view(llm_type=self), name="connect")]

    @property
    def settings(self) -> dict:
        """
        Gets the deployment level settings for this type
        """

        return settings.LLM_TYPES[self.__module__ + "." + self.__class__.__name__]

    def is_available_to(self, org, user) -> bool:
        """
        Determines whether this LLM type is available to the given user.
        """
        return True


class LLM(TembaModel, DependencyMixin):
    """
    A language model that can be used for AI tasks
    """

    ROLE_EDITING = "T"
    ROLE_ENGINE = "F"
    ROLE_NAMES = {ROLE_EDITING: "editing", ROLE_ENGINE: "engine"}
    DEFAULT_ROLES = ROLE_EDITING + ROLE_ENGINE

    org = models.ForeignKey(Org, related_name="llms", on_delete=models.PROTECT)
    llm_type = models.CharField(max_length=16)
    model = models.CharField(max_length=64)
    max_output_tokens = models.PositiveIntegerField(default=4_096)
    config = models.JSONField()
    roles = models.CharField(max_length=2, default=DEFAULT_ROLES)

    org_limit_key = Org.LIMIT_LLMS

    @classmethod
    def create(cls, org, user, typ, model: str, name: str, config: dict, roles: str = DEFAULT_ROLES):
        models_settings = typ.settings.get("models") or {}
        assert not models_settings or model in models_settings

        kwargs = dict(
            org=org,
            name=name,
            llm_type=typ.slug,
            model=model,
            config=config,
            roles=roles,
            created_by=user,
            modified_by=user,
        )
        if model in models_settings:
            kwargs["max_output_tokens"] = models_settings[model]

        return cls.objects.create(**kwargs)

    @property
    def type(self) -> LLMType:
        return self.get_type_from_code()

    @classmethod
    def get_types(cls):
        from .types import TYPES

        return TYPES.values()

    def get_type_from_code(self):
        """
        Returns the type instance for this AI model
        """
        from .types import TYPES

        return TYPES[self.llm_type]

    def translate(self, source: str, target: str, items: dict[str, list[str]]) -> dict[str, list[str]]:
        return mailroom.get_client().llm_translate(self, source, target, items)

    def release(self, user):
        assert not (self.is_system and self.org.is_active), "can't release system LLMs"

        super().release(user)

        self.is_active = False
        self.name = self._deleted_name()
        self.modified_by = user
        self.save(update_fields=("name", "is_active", "modified_by", "modified_on"))

    def delete(self):
        delete_in_batches(self.counts.all())

        super().delete()

    class Meta:
        constraints = [models.UniqueConstraint("org", Lower("name"), name="unique_llm_names")]


class LLMCount(BaseDailyCount):
    """
    Tracks daily counts of LLM activity (calls and tokens used) by mailroom.
    """

    squash_over = ("llm_id", "day", "scope")

    SCOPE_CALLS = "calls"
    SCOPE_TOKENS_IN = "tokens:in"
    SCOPE_TOKENS_OUT = "tokens:out"

    llm = models.ForeignKey(LLM, on_delete=models.PROTECT, related_name="counts", db_index=False)

    class Meta:
        indexes = [
            models.Index("llm", "day", OpClass("scope", name="varchar_pattern_ops"), name="llmcount_llm_scope"),
            # for squashing task
            models.Index(name="llmcount_unsquashed", fields=("llm", "day", "scope"), condition=Q(is_squashed=False)),
        ]
