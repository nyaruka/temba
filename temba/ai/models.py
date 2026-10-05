from django.conf import settings
from django.contrib.postgres.indexes import OpClass
from django.db import models
from django.db.models import Q
from django.db.models.functions import Lower

from temba import mailroom
from temba.orgs.models import DependencyMixin, Org
from temba.utils.models import OrgAsset, delete_in_batches
from temba.utils.models.counts import BaseDailyCount


class LLMCredentialsError(Exception):
    pass


class LLMType:
    """
    Base type for all LLM model types
    """

    # icon to show in UI
    icon = "icon-llm"

    # help text to show for the API key field
    api_key_help = None

    # roles models of this type can perform, if not all, e.g. a type that can classify but not generate text
    roles = None

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

    def get_model_choices(self, api_key: str) -> list[tuple[str, str]]:  # pragma: no cover
        """
        Validates the API key and returns the models available with it.
        """
        raise NotImplementedError()

    def get_config(self, api_key: str) -> dict:
        """
        Returns the provider-specific configuration to persist for a model.
        """
        return {"api_key": api_key}


class LLM(OrgAsset, DependencyMixin):
    """
    A language model that can be used for AI tasks
    """

    ROLE_TRANSLATION = "T"
    ROLE_GENERATION = "G"
    ROLE_CLASSIFICATION = "C"
    ROLE_NAMES = {ROLE_TRANSLATION: "translation", ROLE_GENERATION: "generation", ROLE_CLASSIFICATION: "classification"}
    ALL_ROLES = ROLE_TRANSLATION + ROLE_GENERATION + ROLE_CLASSIFICATION

    org = models.ForeignKey(Org, related_name="llms", on_delete=models.PROTECT)
    llm_type = models.CharField(max_length=16)
    model = models.CharField(max_length=64)
    max_output_tokens = models.PositiveIntegerField(default=4_096)
    config = models.JSONField()
    roles = models.CharField(max_length=3, default=ALL_ROLES)

    org_limit_key = Org.LIMIT_LLMS

    @staticmethod
    def _get_max_output_tokens(typ: LLMType, model: str) -> int:
        models_settings = typ.settings.get("models") or {}
        assert not models_settings or model in models_settings

        return models_settings.get(model, LLM._meta.get_field("max_output_tokens").get_default())

    @classmethod
    def create(cls, org, user, typ, model: str, name: str, config: dict, roles: str = None):
        kwargs = dict(
            org=org,
            name=name,
            llm_type=typ.slug,
            model=model,
            config=config,
            roles=roles or typ.roles or cls.ALL_ROLES,
            created_by=user,
            modified_by=user,
            max_output_tokens=cls._get_max_output_tokens(typ, model),
        )

        return cls.objects.create(**kwargs)

    def update_config(self, user, typ: LLMType, model: str, name: str, config: dict):
        if typ.slug != self.llm_type:
            self.roles = typ.roles or self.ALL_ROLES

        self.llm_type = typ.slug
        self.model = model
        self.name = name
        self.config = config
        self.max_output_tokens = self._get_max_output_tokens(typ, model)
        self.modified_by = user
        self.save(
            update_fields=(
                "llm_type",
                "roles",
                "model",
                "name",
                "config",
                "max_output_tokens",
                "modified_by",
                "modified_on",
            )
        )

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
