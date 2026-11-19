from unittest.mock import ANY, patch

from django.db import IntegrityError, connection, transaction

from temba.orgs.models import ItemCount
from temba.orgs.tasks import squash_item_counts
from temba.tests import TembaTest
from temba.utils.models.counts import get_merge_squashed_sql


class ItemCountTest(TembaTest):
    def test_model(self):
        self.org.counts.create(scope="foo:1", count=2)
        self.org.counts.create(scope="foo:1", count=3)
        self.org.counts.create(scope="foo:2", count=1)
        self.org.counts.create(scope="foo:3", count=4)
        self.org2.counts.create(scope="foo:4", count=1)
        self.org2.counts.create(scope="foo:4", count=1)

        self.assertEqual(9, self.org.counts.filter(scope__in=("foo:1", "foo:3")).sum())
        self.assertEqual(10, self.org.counts.prefix("foo:").sum())
        self.assertEqual(10, self.org.counts.prefix(["foo:"]).sum())
        self.assertEqual(0, self.org.counts.prefix([]).sum())
        self.assertEqual(4, self.org.counts.count())

        squash_item_counts()

        self.assertEqual(9, self.org.counts.filter(scope__in=("foo:1", "foo:3")).sum())
        self.assertEqual(10, self.org.counts.prefix("foo:").sum())
        self.assertEqual(3, self.org.counts.count())

        self.org.counts.all().delete()

    def test_squashing(self):
        def squashed(org) -> dict:
            self.assertEqual(0, org.counts.filter(is_squashed=False).count())
            return {c.scope: (c.id, c.count) for c in org.counts.filter(is_squashed=True)}

        self.org.counts.create(scope="foo:1", count=1)
        self.org.counts.create(scope="foo:1", count=2)
        self.org.counts.create(scope="foo:2", count=4)
        self.org.counts.create(scope="foo:3", count=-6)  # negative counts supported
        self.org.counts.create(scope="foo:3", count=-1)

        self.org2.counts.create(scope="foo:1", count=7)
        self.org2.counts.create(scope="foo:1", count=3)
        self.org2.counts.create(scope="foo:2", count=8)  # unsquashed that sum to zero
        self.org2.counts.create(scope="foo:2", count=-8)
        self.org2.counts.create(scope="foo:3", count=5)

        self.assertEqual(0, self.org.counts.filter(scope="foo:4").sum())  # zero if no such scope exists

        self.assertEqual(6, ItemCount.squash())

        # each set now has a single squashed row, unless it sums to zero
        org1_rows = squashed(self.org)
        org2_rows = squashed(self.org2)
        self.assertEqual({"foo:1": 3, "foo:2": 4, "foo:3": -7}, {k: v[1] for k, v in org1_rows.items()})
        self.assertEqual({"foo:1": 10, "foo:3": 5}, {k: v[1] for k, v in org2_rows.items()})

        # nothing to squash
        self.assertEqual(0, ItemCount.squash())
        self.assertEqual(org1_rows, squashed(self.org))

        self.org.counts.create(scope="foo:1", count=-3)  # squashed total goes to zero
        self.org.counts.create(scope="foo:2", count=-5)  # squashed total goes negative
        self.org.counts.create(scope="foo:3", count=3)
        self.org.counts.create(scope="foo:3", count=-3)  # unsquashed sum to zero
        self.org.counts.create(scope="foo:4", count=2)  # new set
        self.org2.counts.create(scope="foo:2", count=6)  # set which previously squashed to zero

        squash_item_counts()

        # existing squashed rows are updated in place, or deleted if they reach zero
        self.assertEqual(
            {"foo:2": (org1_rows["foo:2"][0], -1), "foo:3": org1_rows["foo:3"], "foo:4": (ANY, 2)},
            squashed(self.org),
        )
        self.assertEqual(
            {"foo:1": org2_rows["foo:1"], "foo:2": (ANY, 6), "foo:3": org2_rows["foo:3"]}, squashed(self.org2)
        )
        self.assertEqual({"foo:2": -1, "foo:3": -7, "foo:4": 2}, self.org.counts.scope_totals())

        # a set whose squashed row was deleted gets a new one
        self.org.counts.create(scope="foo:1", count=4)

        squash_item_counts()

        self.assertEqual(
            {"foo:1": 4, "foo:2": -1, "foo:3": -7, "foo:4": 2}, {k: v[1] for k, v in squashed(self.org).items()}
        )

        # squashed rows must be unique per set
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.org.counts.create(scope="foo:1", count=1, is_squashed=True)

        # sets are squashed up to a maximum number per call
        for i in range(5):
            self.org2.counts.create(scope=f"bar:{i}", count=i + 1)
            self.org2.counts.create(scope=f"bar:{i}", count=1)

        with patch.object(ItemCount, "squash_max_distinct", 3):
            self.assertEqual(3, ItemCount.squash())
            self.assertEqual(2, ItemCount.squash())
            self.assertEqual(0, ItemCount.squash())

        self.assertEqual(
            {"bar:0": 2, "bar:1": 3, "bar:2": 4, "bar:3": 5, "bar:4": 6},
            {k: v[1] for k, v in squashed(self.org2).items() if k.startswith("bar:")},
        )

        # squashing a set that matches no rows doesn't insert anything
        with connection.cursor() as cursor:
            cursor.execute(*ItemCount.get_squash_query({"org_id": self.org.id, "scope": "foo:9"}))

        self.assertFalse(self.org.counts.filter(scope="foo:9").exists())

    def test_merge_squashed(self):

        with connection.cursor() as cursor:
            # duplicate squashed rows predate the unique index
            cursor.execute("DROP INDEX orgcount_squashed")

            self.org.counts.create(scope="foo:1", count=3, is_squashed=True)
            self.org.counts.create(scope="foo:1", count=-1, is_squashed=True)
            self.org.counts.create(scope="foo:1", count=4, is_squashed=True)
            self.org.counts.create(scope="foo:1", count=2)  # unsquashed rows are left alone
            self.org.counts.create(scope="foo:2", count=5, is_squashed=True)
            self.org.counts.create(scope="foo:2", count=-5, is_squashed=True)
            foo3 = self.org.counts.create(scope="foo:3", count=6, is_squashed=True)
            self.org2.counts.create(scope="foo:1", count=7, is_squashed=True)
            self.org2.counts.create(scope="foo:1", count=1, is_squashed=True)

            cursor.execute(get_merge_squashed_sql("orgs_itemcount", ("org_id", "scope")))

        self.assertEqual(
            [("foo:1", 2, False), ("foo:1", 6, True), ("foo:3", 6, True)],  # foo:2 merged to zero so dropped
            list(self.org.counts.order_by("scope", "is_squashed").values_list("scope", "count", "is_squashed")),
        )
        self.assertEqual([("foo:1", 8, True)], list(self.org2.counts.values_list("scope", "count", "is_squashed")))
        self.assertTrue(self.org.counts.filter(id=foo3.id).exists())  # sets without duplicates are untouched
