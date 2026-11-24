from django.urls import reverse

from temba.tests.base import TembaTest


class UserSettingsTest(TembaTest):
    def test_settings(self):
        settings_url = reverse("users.user_settings")

        # must be logged in
        response = self.client.post(settings_url, {}, content_type="application/json")
        self.assertEqual(302, response.status_code)

        self.login(self.admin)

        # body must be a JSON object
        response = self.client.post(settings_url, "notjson", content_type="application/json")
        self.assertEqual(400, response.status_code)

        response = self.client.post(settings_url, [1, 2], content_type="application/json")
        self.assertEqual(400, response.status_code)

        # and not absurdly large
        response = self.client.post(settings_url, {"blob": "x" * 200_000}, content_type="application/json")
        self.assertEqual(400, response.status_code)

        # only known settings keys are accepted
        response = self.client.post(settings_url, {"theme": "dark"}, content_type="application/json")
        self.assertEqual(400, response.status_code)

        # posted keys are merged into existing settings
        response = self.client.post(
            settings_url, {"contact_cards": {"order": ["card-fields"]}}, content_type="application/json"
        )
        self.assertEqual(200, response.status_code)
        self.assertEqual({"contact_cards": {"order": ["card-fields"]}}, response.json()["settings"])

        self.admin.refresh_from_db()
        self.assertEqual({"contact_cards": {"order": ["card-fields"]}}, self.admin.settings)

        # posting a key again replaces its value, leaving other stored keys alone
        self.admin.settings["other"] = {"kept": True}
        self.admin.save(update_fields=("settings",))

        self.client.post(
            settings_url, {"contact_cards": {"collapsed": ["card-nextup"]}}, content_type="application/json"
        )
        self.admin.refresh_from_db()
        self.assertEqual(
            {"contact_cards": {"collapsed": ["card-nextup"]}, "other": {"kept": True}}, self.admin.settings
        )

        # list widths are merged by view and column so independent list
        # pages (and stale tabs) don't overwrite one another
        response = self.client.post(
            settings_url,
            {"list_columns": {"contacts": {"name": 240}, "msgs": {"contact": 160}}},
            content_type="application/json",
        )
        self.assertEqual(200, response.status_code)

        response = self.client.post(
            settings_url,
            {"list_columns": {"contacts": {"last_seen_on": 180}, "msgs": {"created_on": 140}}},
            content_type="application/json",
        )
        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {
                "contacts": {"name": 240, "last_seen_on": 180},
                "msgs": {"contact": 160, "created_on": 140},
            },
            response.json()["settings"]["list_columns"],
        )

        # malformed or out-of-range widths are rejected
        for invalid in (
            [],
            {"contacts": []},
            {"contacts": {"name": "wide"}},
            {"contacts": {"name": 79}},
            {"contacts": {"name": 601}},
            {"flows": {"name": 240}},
        ):
            response = self.client.post(settings_url, {"list_columns": invalid}, content_type="application/json")
            self.assertEqual(400, response.status_code)

        # a saved value corrupted to a non-dict is discarded rather than merged
        self.admin.settings["list_columns"] = "junk"
        self.admin.save(update_fields=("settings",))
        response = self.client.post(
            settings_url,
            {"list_columns": {"contacts": {"name": 200}}},
            content_type="application/json",
        )
        self.assertEqual(200, response.status_code)
        self.assertEqual({"contacts": {"name": 200}}, response.json()["settings"]["list_columns"])

        # column names aren't validated against each list's real columns, so a single save is
        # capped at 20 columns per list...
        response = self.client.post(
            settings_url,
            {"list_columns": {"contacts": {f"field:f{i}": 100 for i in range(21)}}},
            content_type="application/json",
        )
        self.assertEqual(400, response.status_code)

        # ...and merging evicts stale columns before ones in the current save
        response = self.client.post(
            settings_url,
            {"list_columns": {"contacts": {f"field:f{i}": 100 for i in range(20)}}},
            content_type="application/json",
        )
        self.assertEqual(200, response.status_code)
        response = self.client.post(
            settings_url,
            {"list_columns": {"contacts": {"name": 240}}},
            content_type="application/json",
        )
        self.assertEqual(200, response.status_code)
        saved = response.json()["settings"]["list_columns"]["contacts"]
        self.assertEqual(20, len(saved))
        self.assertEqual(240, saved["name"])
        self.assertNotIn("field:f0", saved)

    def test_ticket_order(self):
        settings_url = reverse("users.user_settings")
        self.login(self.admin)

        response = self.client.post(settings_url, {"ticket_order": "oldest"}, content_type="application/json")
        self.assertEqual(200, response.status_code)

        self.admin.refresh_from_db()
        self.assertEqual("oldest", self.admin.settings["ticket_order"])

        # only known orders are accepted
        for order in ("sideways", 1, None):
            response = self.client.post(settings_url, {"ticket_order": order}, content_type="application/json")
            self.assertEqual(400, response.status_code)

        response = self.client.post(settings_url, {"ticket_order": "newest"}, content_type="application/json")
        self.assertEqual(200, response.status_code)

        self.admin.refresh_from_db()
        self.assertEqual("newest", self.admin.settings["ticket_order"])
