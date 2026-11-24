from django.apps import AppConfig
from django.db.models.signals import pre_save


class UtilsConfig(AppConfig):
    name = "temba.utils"

    def ready(self):
        pre_save.connect(require_update_fields, dispatch_uid="temba.require_update_fields")


def require_update_fields(sender, instance, raw, update_fields, **kwargs):
    """
    Other services (e.g. mailroom) write to our tables, so saving every field of an instance which may be stale can
    overwrite their changes. An update must name the fields it changes, unless its model sets allow_unscoped_save.
    """

    if raw or instance._state.adding or getattr(sender, "allow_unscoped_save", False):
        return

    assert update_fields is not None or not sender.__module__.startswith("temba."), (
        f"{sender.__name__}.save() of an existing instance must pass update_fields"
    )
