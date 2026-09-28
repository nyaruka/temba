"""
Publishing of workspace-wide realtime events to the ``org:<org-uuid>`` socket, so that clients can keep their caches of
assets fresh without refetching or reloading.

Phase one deliberately only publishes renames of flows and groups (see `AssetMixin`) as those are the references which
appear most often in flow definitions, and creations of groups, which the client store caches to tell smart groups from
manual ones. The other asset types resolvable via the internal assets endpoint (channels, contacts, labels, LLMs,
templates, topics, fields, globals and users) don't publish, so clients still fall back to refetching or a page reload
to see those changes.

Each publication is a synchronous call to mailroom on commit, so creations are only published where a client acts on
them: a flow import publishes one event per new group but nothing for its flows.
"""

import logging

from django.db import transaction

logger = logging.getLogger(__name__)


def publish_asset_changed(org, asset: dict):
    """Publishes a committed workspace asset creation or name change, best effort."""
    event = {"type": "asset_changed", "asset": asset}
    transaction.on_commit(lambda: _publish_org_event(org, event))


def _publish_org_event(org, event: dict):
    # Keep realtime delivery outside the saving transaction and non-fatal: the
    # cache will recover from a missed publication on its next socket refresh.
    from temba.mailroom import get_client

    try:
        get_client().org_publish(org, event)
    except Exception:
        logger.exception("error publishing workspace event to mailroom")


class AssetMixin:
    """
    Mixin for models whose renames, and optionally creations, are published as `asset_changed` events. Must be listed
    before the model base classes so that our `save` runs, and `asset_type` must be set to the type name used in flow
    definitions.

    We hook into saving rather than the handful of places which create or rename (the create and update modals, flow
    imports, the API v2 groups endpoint) so that no path can be missed, and we track the loaded name so that detecting
    a rename never costs an extra query.
    """

    asset_type = None
    publish_creations = False

    @classmethod
    def from_db(cls, db, field_names, values, *, fetch_mode=None):
        obj = super().from_db(db, field_names, values, fetch_mode=fetch_mode)

        if "name" in field_names:  # won't be if name was deferred, in which case we can't detect renames
            obj._loaded_name = obj.name

        return obj

    def as_asset(self) -> dict:
        """
        The asset as published to clients. Subclasses can add the type specific fields a client needs to cache a new
        object of this type.
        """
        return {"type": self.asset_type, "uuid": str(self.uuid), "name": self.name}

    def is_published_asset(self) -> bool:
        """
        Whether clients should hear about this object at all. Checked last as it's the only part of deciding whether
        to publish which can cost a query.
        """
        return self.is_active

    def save(self, *args, **kwargs):
        creating = self._state.adding

        super().save(*args, **kwargs)

        # if name wasn't written then any in-memory change to it isn't persisted, so there's nothing to publish and we
        # mustn't start tracking it either (Model.save is keyword only so update_fields is always in kwargs if given)
        update_fields = kwargs.get("update_fields")
        if update_fields is not None and "name" not in update_fields:
            return

        loaded_name = getattr(self, "_loaded_name", None)
        renamed = loaded_name is not None and loaded_name != self.name

        # objects being deactivated aren't published as release() renames to a tombstone
        if ((creating and self.publish_creations) or renamed) and self.is_published_asset():
            publish_asset_changed(self.org, self.as_asset())

        self._loaded_name = self.name
