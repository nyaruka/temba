from datetime import date, timedelta

from django_valkey import get_valkey_connection

from django.db import connection
from django.utils import timezone

from temba.orgs.models import Tally
from temba.orgs.tasks import trim_tallies
from temba.tests import TembaTest


class TallyTest(TembaTest):
    def test_get_totals(self):
        r = get_valkey_connection()

        self.org.tallies.create(scope="foo/1", count=2)
        self.org.tallies.create(scope="foo/2", count=3)
        self.org.tallies.create(scope="bar/1", count=4)
        self.org.tallies.create(scope="emails/shared@2026-11-01", count=5, expires_on=date(2027, 11, 1))
        self.org.tallies.create(scope="_gen", count=7)
        self.org2.tallies.create(scope="foo/1", count=5)

        self.assertEqual({"foo/1": 2, "foo/2": 3}, Tally.get_totals(self.org, "foo/"))
        self.assertEqual(
            {"foo/1": 2, "foo/2": 3, "bar/1": 4, "emails/shared@2026-11-01": 5}, Tally.get_totals(self.org, "")
        )

        self.assertEqual((f"tallies:{self.org.id}", f"tallies:{self.org.id}:flushing"), Tally.get_keys(self.org))

        r.hset(
            f"tallies:{self.org.id}",
            mapping={"foo/1": 1, "foo/3": 6, "bar/1": 1, "emails/shared@2026-11-02": 2},
        )
        r.hset(f"tallies:{self.org.id}:flushing", mapping={"foo/1": 10, "emails/shared@2026-11-01": 1, "_gen": 8})
        r.hset(f"tallies:{self.org2.id}", mapping={"foo/1": 100})
        r.sadd("tallies:pending", self.org.id, self.org2.id)

        self.assertEqual({"foo/1": 13, "foo/2": 3, "foo/3": 6}, Tally.get_totals(self.org, "foo/"))
        self.assertEqual(
            {"emails/shared@2026-11-01": 6, "emails/shared@2026-11-02": 2},
            Tally.get_totals(self.org, "emails/shared@"),
        )
        self.assertEqual({"emails/shared@2026-11-02": 2}, Tally.get_totals(self.org, "emails/shared@2026-11-02"))
        self.assertEqual({"foo/1": 105}, Tally.get_totals(self.org2, "foo/"))

        Tally.clear_buffered(self.org)

        self.assertEqual({"foo/1": 2, "foo/2": 3}, Tally.get_totals(self.org, "foo/"))
        self.assertEqual({"foo/1": 105}, Tally.get_totals(self.org2, "foo/"))
        self.assertFalse(r.sismember("tallies:pending", self.org.id))
        self.assertTrue(r.sismember("tallies:pending", self.org2.id))

    def test_upsert(self):
        # check the unique index can be the target of the upserts used for flushing, which only set expiry on insert
        sql = """
        INSERT INTO orgs_tally AS t (org_id, scope, count, expires_on)
        SELECT %s, unnest(%s::text[]), unnest(%s::bigint[]), unnest(%s::date[])
        ON CONFLICT (org_id, scope) DO UPDATE SET count = t.count + excluded.count
        """
        with connection.cursor() as cursor:
            cursor.execute(sql, (self.org.id, ["foo/1", "foo/2@2026-11-02"], [2, 3], [None, date(2027, 11, 2)]))
            cursor.execute(sql, (self.org.id, ["foo/1", "foo/2@2026-11-02"], [4, 1], [None, date(2028, 1, 1)]))

        self.assertEqual({"foo/1": 6, "foo/2@2026-11-02": 4}, Tally.get_totals(self.org, "foo/"))
        self.assertEqual(date(2027, 11, 2), self.org.tallies.get(scope="foo/2@2026-11-02").expires_on)

    def test_trim(self):
        today = timezone.now().date()

        tally1 = self.org.tallies.create(scope="foo/1", count=1)
        self.org.tallies.create(scope="foo/2@2025-11-01", count=1, expires_on=today - timedelta(days=1))
        tally3 = self.org.tallies.create(scope="foo/2@2025-11-02", count=1, expires_on=today)

        self.assertEqual({"deleted": 1}, trim_tallies())
        self.assertEqual({tally1, tally3}, set(Tally.objects.all()))
