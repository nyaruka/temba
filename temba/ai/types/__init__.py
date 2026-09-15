from collections import OrderedDict

from django.conf import settings
from django.utils.module_loading import import_string

TYPES = OrderedDict({})  # thread-safe: populated once at import


def register_llm_type(type_class):
    """
    Registers an llm type
    """
    if not type_class.slug:  # pragma: no cover
        type_class.slug = type_class.__module__.split(".")[-2]

    assert type_class.slug not in TYPES, f"llm type slug {type_class.slug} already taken"

    TYPES[type_class.slug] = type_class()


def reload_llm_types():
    """
    Re-loads the dynamic llm types
    """
    global TYPES  # noqa: PLW0603 - rebuilt by reassignment so a concurrent reader never sees it half-built

    TYPES = OrderedDict({})
    for class_name in settings.LLM_TYPES.keys():
        register_llm_type(import_string(class_name))


reload_llm_types()
