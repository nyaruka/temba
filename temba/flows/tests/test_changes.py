from temba.flows.changes import compute_changes
from temba.tests import TembaTest


def _flow(nodes=None, ui_nodes=None, stickies=None, localization=None, **top):
    """Helper for building minimal flow definitions for diffing."""
    defn = {
        "uuid": "11111111-1111-1111-1111-111111111111",
        "name": "Flow",
        "language": "eng",
        "type": "messaging",
        "expire_after_minutes": 10080,
        "nodes": nodes or [],
        "localization": localization or {},
        "_ui": {"nodes": ui_nodes or {}, "stickies": stickies or {}},
    }
    defn.update(top)
    return defn


def _tags(old, new):
    return compute_changes(old, new)["tags"]


class ComputeChangesTest(TembaTest):
    def test_no_changes(self):
        defn = _flow()
        self.assertEqual({"tags": []}, compute_changes(defn, defn))

    def test_metadata(self):
        old = _flow()
        self.assertEqual(["metadata"], _tags(old, _flow(name="Renamed")))
        self.assertEqual(["metadata"], _tags(old, _flow(expire_after_minutes=60)))
        self.assertEqual(["metadata"], _tags(old, _flow(type="voice")))
        self.assertEqual(["metadata"], _tags(old, _flow(language="spa")))

    def test_nodes(self):
        node_a = {"uuid": "a" * 36, "actions": [], "exits": []}
        node_b = {"uuid": "b" * 36, "actions": [], "exits": []}

        self.assertEqual(["nodes"], _tags(_flow(nodes=[node_a]), _flow(nodes=[node_a, node_b])))
        self.assertEqual(["nodes"], _tags(_flow(nodes=[node_a, node_b]), _flow(nodes=[node_a])))

        # swapping which node is first changes the entry point — counts as a structural change
        self.assertEqual(
            ["nodes"],
            _tags(_flow(nodes=[node_a, node_b]), _flow(nodes=[node_b, node_a])),
        )

    def test_layout(self):
        ui = {"a" * 36: {"position": {"left": 0, "top": 0}, "type": "execute_actions"}}
        ui_moved = {"a" * 36: {"position": {"left": 50, "top": 50}, "type": "execute_actions"}}

        self.assertEqual(["layout"], _tags(_flow(ui_nodes=ui), _flow(ui_nodes=ui_moved)))

        # type-only change in _ui isn't a layout move, but still falls through to "other"
        # so the empty tag list remains a reliable signal that nothing changed
        ui_retyped = {"a" * 36: {"position": {"left": 0, "top": 0}, "type": "wait_for_response"}}
        self.assertEqual(["other"], _tags(_flow(ui_nodes=ui), _flow(ui_nodes=ui_retyped)))

    def test_actions(self):
        a1 = {"uuid": "ac" + "0" * 34, "type": "send_msg", "text": "hello"}
        a2 = {"uuid": "ac" + "1" * 34, "type": "send_msg", "text": "world"}
        node = {"uuid": "n" * 36, "actions": [a1], "exits": []}

        # added
        self.assertEqual(
            ["actions"],
            _tags(_flow(nodes=[node]), _flow(nodes=[{**node, "actions": [a1, a2]}])),
        )
        # removed
        self.assertEqual(
            ["actions"],
            _tags(_flow(nodes=[{**node, "actions": [a1, a2]}]), _flow(nodes=[node])),
        )
        # edited
        self.assertEqual(
            ["actions"],
            _tags(_flow(nodes=[node]), _flow(nodes=[{**node, "actions": [{**a1, "text": "hi"}]}])),
        )
        # reordered
        self.assertEqual(
            ["actions"],
            _tags(
                _flow(nodes=[{**node, "actions": [a1, a2]}]),
                _flow(nodes=[{**node, "actions": [a2, a1]}]),
            ),
        )

    def test_routing(self):
        node = {
            "uuid": "n" * 36,
            "actions": [],
            "exits": [{"uuid": "e" * 36, "destination_uuid": None}],
            "router": {"type": "switch", "operand": "@input.text", "categories": []},
        }

        # router config changed
        new_router = {**node, "router": {**node["router"], "operand": "@contact.name"}}
        self.assertEqual(["routing"], _tags(_flow(nodes=[node]), _flow(nodes=[new_router])))

        # exit destination changed
        new_dest = {**node, "exits": [{"uuid": "e" * 36, "destination_uuid": "x" * 36}]}
        self.assertEqual(["routing"], _tags(_flow(nodes=[node]), _flow(nodes=[new_dest])))

    def test_stickies(self):
        sticky = {
            "position": {"left": 0, "top": 0},
            "title": "Hello",
            "body": "World",
            "color": "yellow",
        }

        # added / removed
        self.assertEqual(["stickies"], _tags(_flow(), _flow(stickies={"s" * 36: sticky})))
        self.assertEqual(["stickies"], _tags(_flow(stickies={"s" * 36: sticky}), _flow()))

        # moved → layout, not stickies
        moved = {**sticky, "position": {"left": 100, "top": 50}}
        self.assertEqual(
            ["layout"],
            _tags(_flow(stickies={"s" * 36: sticky}), _flow(stickies={"s" * 36: moved})),
        )

        # resized → layout
        resized = {**sticky, "width": 300}
        self.assertEqual(
            ["layout"],
            _tags(_flow(stickies={"s" * 36: sticky}), _flow(stickies={"s" * 36: resized})),
        )

        # content edit → stickies
        edited = {**sticky, "body": "Goodbye"}
        self.assertEqual(
            ["stickies"],
            _tags(_flow(stickies={"s" * 36: sticky}), _flow(stickies={"s" * 36: edited})),
        )

        # both at once → both tags
        both = {**sticky, "position": {"left": 100, "top": 50}, "title": "New"}
        self.assertEqual(
            ["layout", "stickies"],
            _tags(_flow(stickies={"s" * 36: sticky}), _flow(stickies={"s" * 36: both})),
        )

        # unknown non-layout fields fall through to "stickies" rather than being dropped
        future_field = {**sticky, "linked_node": "n" * 36}
        self.assertEqual(
            ["stickies"],
            _tags(_flow(stickies={"s" * 36: sticky}), _flow(stickies={"s" * 36: future_field})),
        )

    def test_localization(self):
        item = "t" * 36
        old = _flow()

        # add a Spanish translation
        self.assertEqual(
            ["localization:spa"],
            _tags(old, _flow(localization={"spa": {item: {"text": "hola"}}})),
        )

        # multiple languages → one tag per language
        self.assertEqual(
            ["localization:fra", "localization:spa"],
            _tags(
                old,
                _flow(localization={"spa": {item: {"text": "hola"}}, "fra": {item: {"text": "salut"}}}),
            ),
        )

        # update existing
        self.assertEqual(
            ["localization:spa"],
            _tags(
                _flow(localization={"spa": {item: {"text": "hola"}}}),
                _flow(localization={"spa": {item: {"text": "buenas"}}}),
            ),
        )

    def test_other_catch_all(self):
        # uuid/revision are stripped before the catch-all check so they don't fire
        # false positives on every save; spec_version differences are recorded as "spec"
        old = _flow(uuid="11111111-1111-1111-1111-111111111111", revision=1, spec_version="13.0.0")
        new = _flow(uuid="22222222-2222-2222-2222-222222222222", revision=2, spec_version="13.0.0")
        self.assertEqual([], _tags(old, new))

        # spec_version bump on its own is a recorded change
        self.assertEqual(["spec"], _tags(_flow(spec_version="13.0.0"), _flow(spec_version="13.1.0")))

        # an unanticipated top-level field difference produces "other" so the empty
        # tag list remains a reliable signal that nothing changed
        self.assertEqual(["other"], _tags(_flow(), _flow(future_top_level={"foo": "bar"})))

    def test_combined(self):
        node_a = {"uuid": "a" * 36, "actions": [], "exits": []}
        node_b = {"uuid": "b" * 36, "actions": [], "exits": []}
        ui = {"a" * 36: {"position": {"left": 0, "top": 0}}}
        ui_moved = {"a" * 36: {"position": {"left": 50, "top": 50}}}

        old = _flow(nodes=[node_a], ui_nodes=ui)
        new = _flow(nodes=[node_a, node_b], ui_nodes=ui_moved, name="Renamed")

        self.assertEqual(["layout", "metadata", "nodes"], _tags(old, new))
