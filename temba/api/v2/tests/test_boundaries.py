from django.urls import reverse

from temba.locations.models import BoundaryAlias

from . import APITest


class BoundariesEndpointTest(APITest):
    def test_endpoint(self):
        endpoint_url = reverse("api.v2.boundaries") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None])
        self.assertPostNotAllowed(endpoint_url)
        self.assertDeleteNotAllowed(endpoint_url)

        self.setUpLocations()

        BoundaryAlias.create(self.org, self.admin, self.state1, "Kigali")
        BoundaryAlias.create(self.org, self.admin, self.state2, "East Prov")
        BoundaryAlias.create(self.org2, self.admin2, self.state1, "Other Org")  # shouldn't be returned

        self.state1.geometry = {"type": "MultiPolygon", "coordinates": [[[[1, 1], [1, -1], [-1, -1], [-1, 1], [1, 1]]]]}
        self.state1.save()

        self.assertGet(
            endpoint_url,
            [self.editor, self.admin],
            results=[
                {
                    "osm_id": "1708283",
                    "name": "Kigali City",
                    "parent": {"osm_id": "171496", "name": "Rwanda"},
                    "level": 1,
                    "aliases": ["Kigali", "Kigari"],
                    "geometry": {
                        "type": "MultiPolygon",
                        "coordinates": [[[[1.0, 1.0], [1.0, -1.0], [-1.0, -1.0], [-1.0, 1.0], [1.0, 1.0]]]],
                    },
                },
                {
                    "osm_id": "171113181",
                    "name": "Kageyo",
                    "parent": {"osm_id": "R1711131", "name": "Gatsibo"},
                    "level": 3,
                    "aliases": [],
                    "geometry": None,
                },
                {
                    "osm_id": "1711142",
                    "name": "Rwamagana",
                    "parent": {"osm_id": "171591", "name": "Eastern Province"},
                    "level": 2,
                    "aliases": [],
                    "geometry": None,
                },
                {
                    "osm_id": "1711163",
                    "name": "Kay\u00f4nza",
                    "parent": {"osm_id": "171591", "name": "Eastern Province"},
                    "level": 2,
                    "aliases": [],
                    "geometry": None,
                },
                {
                    "osm_id": "171116381",
                    "name": "Kabare",
                    "parent": {"osm_id": "1711163", "name": "Kay\u00f4nza"},
                    "level": 3,
                    "aliases": [],
                    "geometry": None,
                },
                {"osm_id": "171496", "name": "Rwanda", "parent": None, "level": 0, "aliases": [], "geometry": None},
                {
                    "osm_id": "171591",
                    "name": "Eastern Province",
                    "parent": {"osm_id": "171496", "name": "Rwanda"},
                    "level": 1,
                    "aliases": ["East Prov"],
                    "geometry": None,
                },
                {
                    "osm_id": "3963734",
                    "name": "Nyarugenge",
                    "parent": {"osm_id": "1708283", "name": "Kigali City"},
                    "level": 2,
                    "aliases": [],
                    "geometry": None,
                },
                {
                    "osm_id": "R1711131",
                    "name": "Gatsibo",
                    "parent": {"osm_id": "171591", "name": "Eastern Province"},
                    "level": 2,
                    "aliases": [],
                    "geometry": None,
                },
                {
                    "osm_id": "VMN.49.1_1",
                    "name": "Bukure",
                    "parent": {"osm_id": "1711142", "name": "Rwamagana"},
                    "level": 3,
                    "aliases": [],
                    "geometry": None,
                },
            ],
            num_queries=self.BASE_SESSION_QUERIES + 3,
        )

        # if org doesn't have a country, just return no results
        self.org.root_location = None
        self.org.save(update_fields=("root_location",))

        self.assertGet(endpoint_url, [self.admin], results=[])
