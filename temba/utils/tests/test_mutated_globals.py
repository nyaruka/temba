from pathlib import Path
from textwrap import dedent

from django.test import SimpleTestCase

from temba.utils.mutated_globals import find_mutated_globals, is_app_source


class MutatedGlobalsTest(SimpleTestCase):
    def find(self, source: str) -> list[str]:
        return find_mutated_globals(dedent(source), "mod.py")

    def test_mutating_calls_and_assignments(self):
        problems = self.find(
            """
            CACHE = {}
            ITEMS: list = []
            SEEN = set()

            def add(k, v):
                CACHE[k] = v
                ITEMS.append(v)
                SEEN.add(k)
                del CACHE[k]
            """
        )
        self.assertEqual(
            [
                "mod.py:7: add() mutates module-level `CACHE` (defined line 2)",
                "mod.py:8: add() mutates module-level `ITEMS` (defined line 3)",
                "mod.py:9: add() mutates module-level `SEEN` (defined line 4)",
                "mod.py:10: add() mutates module-level `CACHE` (defined line 2)",
            ],
            problems,
        )

    def test_container_constructors(self):
        problems = self.find(
            """
            from collections import OrderedDict, defaultdict
            import collections

            BY_KEY = defaultdict(list)
            ORDERED = collections.OrderedDict()
            COUNTS = dict(a=1)
            NAMES = [n.upper() for n in ("a", "b")]

            def touch():
                BY_KEY["k"].append(1)
                ORDERED["k"] = 1
                COUNTS.update(b=2)
                NAMES.clear()
            """
        )
        self.assertEqual(3, len(problems))
        self.assertIn("mod.py:12: touch() mutates module-level `ORDERED` (defined line 6)", problems)
        self.assertIn("mod.py:13: touch() mutates module-level `COUNTS` (defined line 7)", problems)
        self.assertIn("mod.py:14: touch() mutates module-level `NAMES` (defined line 8)", problems)

    def test_thread_safe_marker(self):
        self.assertEqual(
            [],
            self.find(
                """
                LOCKED = {}  # thread-safe: guarded by a lock in touch()

                def touch():
                    LOCKED["k"] = 1
                """
            ),
        )

    def test_non_containers_ignored(self):
        self.assertEqual(
            [],
            self.find(
                """
                COUNT = 0
                NAME = "x"

                def touch():
                    global COUNT
                    COUNT += 1
                    NAME.upper()
                """
            ),
        )

    def test_shadowing(self):
        self.assertEqual(
            [],
            self.find(
                """
                CACHE = {}
                ITEMS = []
                ERRORS = []

                def by_param(CACHE):
                    CACHE["k"] = 1

                def by_assignment():
                    ITEMS = []
                    ITEMS.append(1)

                def by_except():
                    try:
                        pass
                    except Exception as ERRORS:
                        ERRORS.append(1)
                """
            ),
        )

    def test_global_declaration_defeats_shadowing(self):
        # an augmented assignment makes a name local unless it's declared global, so it only mutates in place here
        self.assertEqual(
            [
                "mod.py:7: touch() mutates module-level `ITEMS` (defined line 2)",
                "mod.py:8: touch() mutates module-level `ITEMS` (defined line 2)",
            ],
            self.find(
                """
                ITEMS = []

                def touch():
                    global ITEMS
                    ITEMS = ITEMS or []
                    ITEMS.append(1)
                    ITEMS += [2]
                """
            ),
        )

    def test_nested_scopes(self):
        problems = self.find(
            """
            ITEMS = []

            def outer():
                ITEMS = []  # shadows in outer only

                def inner():
                    ITEMS.append(1)

                class Thing:
                    def method(self):
                        ITEMS.append(2)

                async def later():
                    ITEMS.append(3)
            """
        )
        self.assertEqual(
            [
                "mod.py:8: inner() mutates module-level `ITEMS` (defined line 2)",
                "mod.py:12: method() mutates module-level `ITEMS` (defined line 2)",
                "mod.py:15: later() mutates module-level `ITEMS` (defined line 2)",
            ],
            problems,
        )

    def test_no_containers(self):
        self.assertEqual([], self.find("X = 1\n\ndef f():\n    return X\n"))

    def test_is_app_source(self):
        self.assertTrue(is_app_source(Path("temba/msgs/models.py")))
        self.assertFalse(is_app_source(Path("temba/msgs/migrations/0001_initial.py")))
        self.assertFalse(is_app_source(Path("temba/msgs/tests/test_models.py")))
        self.assertFalse(is_app_source(Path("temba/msgs/tests.py")))
