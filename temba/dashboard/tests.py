from datetime import timedelta, timezone as tzone

from django.urls import reverse
from django.utils import timezone

from temba.orgs.models import Org
from temba.tests import TembaTest


class DashboardTest(TembaTest):
    def create_activity(self):
        # some message and call activity today
        today = timezone.now().date().isoformat()
        for scope, count in (("text:in", 1), ("text:out", 2), ("voice:in", 1), ("voice:out", 1)):
            self.org.tallies.create(scope=f"msgs/{scope}@{today}", count=count)

        # and on another workspace
        self.org2.tallies.create(scope=f"msgs/text:in@{today}", count=5)

    def test_dashboard_home(self):
        dashboard_url = reverse("dashboard.dashboard_home")

        # visit this page without authenticating
        response = self.client.get(dashboard_url, follow=True)

        # nope! cannot visit dashboard.
        self.assertRedirects(response, "/accounts/login/?next=%s" % dashboard_url)

        self.login(self.admin)
        response = self.client.get(dashboard_url, follow=True)

        # yep! it works
        self.assertEqual(response.request["PATH_INFO"], dashboard_url)

    def test_message_history(self):
        url = reverse("dashboard.dashboard_message_history")

        # visit this page without authenticating
        response = self.client.get(url, follow=True)

        # nope!
        self.assertRedirects(response, "/accounts/login/?next=%s" % url)

        self.login(self.admin)
        self.create_activity()
        response = self.client.get(url).json()

        # check the new temba-chart format
        self.assertIn("data", response)
        data = response["data"]
        self.assertEqual(2, len(data["datasets"]))

        # incoming messages
        self.assertEqual("Incoming", data["datasets"][0]["label"])
        self.assertEqual(1, data["datasets"][0]["data"][0])

        # outgoing messages
        self.assertEqual("Outgoing", data["datasets"][1]["label"])
        self.assertEqual(2, data["datasets"][1]["data"][0])  # test with since and until parameters
        today = timezone.now().date()
        yesterday = today - timedelta(days=1)
        tomorrow = today + timedelta(days=1)

        # test with specific date range
        response = self.client.get(url, {"since": yesterday.isoformat(), "until": tomorrow.isoformat()}).json()

        # should still get the same data since messages are from today
        data = response["data"]
        self.assertEqual(2, len(data["datasets"]))
        self.assertEqual(1, data["datasets"][0]["data"][0])  # incoming
        self.assertEqual(2, data["datasets"][1]["data"][0])  # outgoing

        # test with date range that excludes our messages
        old_date = today - timedelta(days=10)
        response = self.client.get(url, {"since": old_date.isoformat(), "until": yesterday.isoformat()}).json()

        # should get empty data
        data = response["data"]
        self.assertEqual(2, len(data["datasets"]))
        self.assertEqual(0, len(data["datasets"][0]["data"]))  # no incoming data
        self.assertEqual(0, len(data["datasets"][1]["data"]))  # no outgoing data

    def test_workspace_stats(self):
        stats_url = reverse("dashboard.dashboard_workspace_stats")

        self.create_activity()

        # create child with no activity
        self.org.features += [Org.FEATURE_CHILD_ORGS]
        self.org.create_new(self.admin, "Test Org", tzone.utc, as_child=True)

        # visit this page without authenticating
        response = self.client.get(stats_url)
        self.assertLoginRedirect(response)

        self.login(self.admin, choose_org=self.org)
        response = self.client.get(stats_url).json()

        # check the new temba-chart format
        data = response["data"]
        self.assertEqual(["Nyaruka"], data["labels"])
        self.assertEqual(2, len(data["datasets"]))
        self.assertEqual("Incoming", data["datasets"][0]["label"])
        self.assertEqual("Outgoing", data["datasets"][1]["label"])
        self.assertEqual(1, data["datasets"][0]["data"][0])  # incoming
        self.assertEqual(2, data["datasets"][1]["data"][0])  # outgoing

        # test with since and until parameters
        today = timezone.now().date()
        yesterday = today - timedelta(days=1)
        tomorrow = today + timedelta(days=1)

        # test with specific date range that includes our data
        response = self.client.get(stats_url, {"since": yesterday.isoformat(), "until": tomorrow.isoformat()}).json()

        # should get the same data since messages are from today
        data = response["data"]
        self.assertEqual(["Nyaruka"], data["labels"])
        self.assertEqual(2, len(data["datasets"]))
        self.assertEqual(1, data["datasets"][0]["data"][0])  # incoming
        self.assertEqual(2, data["datasets"][1]["data"][0])  # outgoing

        # test with date range that excludes our messages
        old_date = today - timedelta(days=10)
        response = self.client.get(stats_url, {"since": old_date.isoformat(), "until": yesterday.isoformat()}).json()

        # should get empty data since no activity in that range
        data = response["data"]
        self.assertEqual([], data["labels"])
        self.assertEqual(2, len(data["datasets"]))
        self.assertEqual([], data["datasets"][0]["data"])  # no incoming data
        self.assertEqual([], data["datasets"][1]["data"])  # no outgoing data
