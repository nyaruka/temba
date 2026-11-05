from datetime import date

from django.urls import reverse

from . import APITest


class StatisticsEndpointTest(APITest):
    def test_endpoint(self):
        endpoint_url = reverse("api.v2.statistics") + ".json"

        self.assertGetNotPermitted(endpoint_url + "?since=2026-02-01&until=2026-02-28", [None, self.agent])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        # docs request (without .json suffix) returns 200
        self.login(self.admin)
        response = self.client.get(reverse("api.v2.statistics"), HTTP_X_FORWARDED_HTTPS="https")
        self.assertEqual(200, response.status_code)

        # invalid date
        response = self._getJSON(endpoint_url + "?since=bad&until=2026-02-28", self.admin)
        self.assertEqual(400, response.status_code)

        # date range > 366 days
        response = self._getJSON(endpoint_url + "?since=2024-01-01&until=2025-06-01", self.admin)
        self.assertEqual(400, response.status_code)

        # no params defaults to last 90 days
        self.assertGet(endpoint_url, [self.editor], results=[])

        # no data in range
        self.assertGet(
            endpoint_url + "?since=2026-02-01&until=2026-02-28",
            [self.editor],
            results=[],
        )

        # create a second channel
        channel2 = self.create_channel("FBA", "Facebook", "12345")

        # add some counts
        d1, d2 = date(2026, 2, 10), date(2026, 2, 11)
        self.create_channel_tally(self.channel, "text:in", d1, 100)
        self.create_channel_tally(self.channel, "text:out", d1, 200)
        self.create_channel_tally(self.channel, "voice:in", d1, 10)
        self.create_channel_tally(self.channel, "voice:out", d1, 20)
        self.create_channel_tally(channel2, "text:in", d1, 50)
        self.create_channel_tally(channel2, "text:out", d1, 75)
        self.create_channel_tally(self.channel, "text:in", d2, 300)
        self.create_channel_tally(self.channel, "text:out", d2, 400)

        # counts on other org shouldn't appear
        org2_channel = self.create_channel("A", "Org2Channel", "123456", country="RW", org=self.org2)
        self.create_channel_tally(org2_channel, "text:in", d1, 999)

        # nor counts on inactive channels
        channel3 = self.create_channel("FBA", "Facebook", "23456")
        channel3.is_active = False
        channel3.save(update_fields=("is_active",))
        self.create_channel_tally(channel3, "text:in", d1, 888)

        self.assertGet(
            endpoint_url + "?since=2026-02-10&until=2026-02-12",
            [self.admin],
            results=[
                {
                    "date": "2026-02-10",
                    "channels": {
                        str(self.channel.uuid): {
                            "type": "android",
                            "text:in": 100,
                            "text:out": 200,
                            "voice:in": 10,
                            "voice:out": 20,
                        },
                        str(channel2.uuid): {"type": "facebook", "text:in": 50, "text:out": 75},
                    },
                },
                {
                    "date": "2026-02-11",
                    "channels": {
                        str(self.channel.uuid): {"type": "android", "text:in": 300, "text:out": 400},
                    },
                },
            ],
        )

        # until is exclusive, so querying up to 2026-02-11 should only return first day
        self.assertGet(
            endpoint_url + "?since=2026-02-10&until=2026-02-11",
            [self.admin],
            results=[
                {
                    "date": "2026-02-10",
                    "channels": {
                        str(self.channel.uuid): {
                            "type": "android",
                            "text:in": 100,
                            "text:out": 200,
                            "voice:in": 10,
                            "voice:out": 20,
                        },
                        str(channel2.uuid): {"type": "facebook", "text:in": 50, "text:out": 75},
                    },
                },
            ],
        )

        # works with API token
        self.assertGet(
            endpoint_url + "?since=2026-02-10&until=2026-02-11",
            [self.admin],
            by_token=True,
            results=[
                {
                    "date": "2026-02-10",
                    "channels": {
                        str(self.channel.uuid): {
                            "type": "android",
                            "text:in": 100,
                            "text:out": 200,
                            "voice:in": 10,
                            "voice:out": 20,
                        },
                        str(channel2.uuid): {"type": "facebook", "text:in": 50, "text:out": 75},
                    },
                },
            ],
        )
