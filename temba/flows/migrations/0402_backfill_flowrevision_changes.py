import logging

from packaging.version import InvalidVersion, Version

from django.db import migrations

logger = logging.getLogger(__name__)

# the schema compute_changes understands; older revisions used materially different
# definition shapes and aren't worth diffing here
MIN_SPEC = Version("13.0.0")

_METADATA_FIELDS = ("name", "type", "expire_after_minutes")
_STICKY_LAYOUT_FIELDS = ("position", "width", "height")
_SYSTEM_FIELDS = ("uuid", "revision")


def compute_changes(old: dict, new: dict) -> dict:  # pragma: no cover
    tags = set()

    if old.get("spec_version") != new.get("spec_version"):
        tags.add("spec")

    if old.get("language") != new.get("language"):
        tags.add("metadata")
    if any(old.get(f) != new.get(f) for f in _METADATA_FIELDS):
        tags.add("metadata")

    old_node_list = old.get("nodes") or []
    new_node_list = new.get("nodes") or []
    old_nodes = {n["uuid"]: n for n in old_node_list}
    new_nodes = {n["uuid"]: n for n in new_node_list}

    if old_nodes.keys() ^ new_nodes.keys():
        tags.add("nodes")

    old_entry = old_node_list[0]["uuid"] if old_node_list else None
    new_entry = new_node_list[0]["uuid"] if new_node_list else None
    if old_entry != new_entry:
        tags.add("nodes")

    for uuid in old_nodes.keys() & new_nodes.keys():
        _tag_node_diff(old_nodes[uuid], new_nodes[uuid], tags)

    old_ui = old.get("_ui") or {}
    new_ui = new.get("_ui") or {}

    old_ui_nodes = old_ui.get("nodes") or {}
    new_ui_nodes = new_ui.get("nodes") or {}
    for uuid in old_ui_nodes.keys() & new_ui_nodes.keys():
        if old_ui_nodes[uuid].get("position") != new_ui_nodes[uuid].get("position"):
            tags.add("layout")
            break

    old_stickies = old_ui.get("stickies") or {}
    new_stickies = new_ui.get("stickies") or {}
    if old_stickies.keys() ^ new_stickies.keys():
        tags.add("stickies")
    for uuid in old_stickies.keys() & new_stickies.keys():
        old_s, new_s = old_stickies[uuid], new_stickies[uuid]
        if any(old_s.get(f) != new_s.get(f) for f in _STICKY_LAYOUT_FIELDS):
            tags.add("layout")
        non_layout_keys = (set(old_s) | set(new_s)) - set(_STICKY_LAYOUT_FIELDS)
        if any(old_s.get(k) != new_s.get(k) for k in non_layout_keys):
            tags.add("stickies")

    old_loc = old.get("localization") or {}
    new_loc = new.get("localization") or {}
    for lang in set(old_loc) | set(new_loc):
        if (old_loc.get(lang) or {}) != (new_loc.get(lang) or {}):
            tags.add(f"localization:{lang}")

    if not tags:
        old_stripped = {k: v for k, v in old.items() if k not in _SYSTEM_FIELDS}
        new_stripped = {k: v for k, v in new.items() if k not in _SYSTEM_FIELDS}
        if old_stripped != new_stripped:
            tags.add("other")

    return {"tags": sorted(tags)}


def _tag_node_diff(old: dict, new: dict, tags: set) -> None:  # pragma: no cover
    old_action_list = old.get("actions") or []
    new_action_list = new.get("actions") or []
    old_actions = {a["uuid"]: a for a in old_action_list}
    new_actions = {a["uuid"]: a for a in new_action_list}

    if old_actions.keys() ^ new_actions.keys():
        tags.add("actions")
    else:
        for uuid in old_actions.keys() & new_actions.keys():
            if old_actions[uuid] != new_actions[uuid]:
                tags.add("actions")
                break
        else:
            old_order = [a["uuid"] for a in old_action_list]
            new_order = [a["uuid"] for a in new_action_list]
            if old_order != new_order:
                tags.add("actions")

    if old.get("router") != new.get("router"):
        tags.add("routing")

    old_exits = {e["uuid"]: e for e in old.get("exits") or []}
    new_exits = {e["uuid"]: e for e in new.get("exits") or []}
    for uuid in old_exits.keys() & new_exits.keys():
        if old_exits[uuid].get("destination_uuid") != new_exits[uuid].get("destination_uuid"):
            tags.add("routing")
            break


def backfill_flowrevision_changes(apps, schema_editor):  # pragma: no cover
    FlowRevision = apps.get_model("flows", "FlowRevision")

    # iterate flows that still have any null-changes revision, paged by flow_id
    flow_ids_qs = (
        FlowRevision.objects.filter(changes__isnull=True)
        .values_list("flow_id", flat=True)
        .distinct()
        .order_by("flow_id")
    )

    last_flow_id = 0
    num_flows = 0
    num_updated = 0

    while True:
        flow_ids = list(flow_ids_qs.filter(flow_id__gt=last_flow_id)[:500])
        if not flow_ids:
            break

        for flow_id in flow_ids:
            # load the whole flow's revisions; flows have bounded revision counts
            # (trim keeps recent + dailies), and a single bulk_update at the end
            # avoids interleaving writes with a server-side cursor
            revs = list(
                FlowRevision.objects.filter(flow_id=flow_id)
                .order_by("revision", "id")
                .only("id", "definition", "spec_version", "changes")
            )

            prev_def = None
            updates = []

            for rev in revs:
                try:
                    spec_ok = Version(rev.spec_version) >= MIN_SPEC
                except InvalidVersion:
                    spec_ok = False

                if spec_ok and prev_def is not None and not rev.changes:
                    try:
                        rev.changes = compute_changes(prev_def, rev.definition)
                    except Exception:
                        # malformed definition (e.g. nodes/actions missing uuid) — leave
                        # changes as null and keep going so one bad row doesn't block
                        # the rest of the backfill
                        logger.warning("could not compute changes for revision %d", rev.id, exc_info=True)
                    else:
                        updates.append(rev)

                # only carry forward a definition compute_changes can read; this also
                # ensures the first 13.x revision after a pre-13 history isn't diffed
                # against an incompatible prior shape
                prev_def = rev.definition if spec_ok else None

            if updates:
                FlowRevision.objects.bulk_update(updates, ["changes"])
                num_updated += len(updates)

            num_flows += 1
            last_flow_id = flow_id

        print(f"Processed {num_flows} flows, updated {num_updated} revisions")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_flowrevision_changes(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("flows", "0401_flowrevision_changes"),
    ]

    operations = [
        migrations.RunPython(backfill_flowrevision_changes, reverse_code=migrations.RunPython.noop),
    ]
