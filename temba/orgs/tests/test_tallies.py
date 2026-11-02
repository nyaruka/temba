from datetime import date, timedelta

from django_valkey import get_valkey_connection

from django.db import connection
from django.utils import timezone

from temba.orgs.models import DailyTally, ItemTally
from temba.orgs.tasks import trim_daily_tallies
from temba.tests import TembaTest


class ItemTallyTest(TembaTest):
    def test_get_totals(self):
        r = get_valkey_connection()

        self.org.tallies.create(scope="foo:1", count=2)
        self.org.tallies.create(scope="foo:2", count=3)
        self.org.tallies.create(scope="bar:1", count=4)
        self.org.tallies.create(scope="_gen", count=7)
        self.org2.tallies.create(scope="foo:1", count=5)

        self.assertEqual({"foo:1": 2, "foo:2": 3}, ItemTally.get_totals(self.org, "foo:"))
        self.assertEqual({"foo:1": 2, "foo:2": 3, "bar:1": 4}, ItemTally.get_totals(self.org, ""))

        self.assertEqual((f"tallies:{self.org.id}", f"tallies:{self.org.id}:flushing"), ItemTally.get_keys(self.org))

        r.hset(f"tallies:{self.org.id}", mapping={"foo:1": 1, "foo:3": 6, "bar:1": 1})
        r.hset(f"tallies:{self.org.id}:flushing", mapping={"foo:1": 10, "_gen": 8})
        r.hset(f"tallies:{self.org2.id}", mapping={"foo:1": 100})

        self.assertEqual({"foo:1": 13, "foo:2": 3, "foo:3": 6}, ItemTally.get_totals(self.org, "foo:"))
        self.assertEqual({"foo:1": 105}, ItemTally.get_totals(self.org2, "foo:"))

        ItemTally.clear_buffered(self.org)

        self.assertEqual({"foo:1": 2, "foo:2": 3}, ItemTally.get_totals(self.org, "foo:"))
        self.assertEqual({"foo:1": 105}, ItemTally.get_totals(self.org2, "foo:"))

    def test_upsert(self):
        # check the unique index can be the target of the upserts used for flushing
        sql = """
        INSERT INTO orgs_itemtally AS t (org_id, scope, count) SELECT %s, unnest(%s::text[]), unnest(%s::bigint[])
        ON CONFLICT (org_id, scope) DO UPDATE SET count = t.count + excluded.count
        """
        with connection.cursor() as cursor:
            cursor.execute(sql, (self.org.id, ["foo:1", "foo:2"], [2, 3]))
            cursor.execute(sql, (self.org.id, ["foo:1"], [4]))

        self.assertEqual({"foo:1": 6, "foo:2": 3}, ItemTally.get_totals(self.org, "foo:"))

        sql = """
        INSERT INTO orgs_dailytally AS t (org_id, scope, day, count)
        SELECT %s, unnest(%s::text[]), unnest(%s::date[]), unnest(%s::bigint[])
        ON CONFLICT (org_id, scope, day) DO UPDATE SET count = t.count + excluded.count
        """
        with connection.cursor() as cursor:
            cursor.execute(sql, (self.org.id, ["foo", "foo"], [date(2026, 11, 1), date(2026, 11, 2)], [2, 3]))
            cursor.execute(sql, (self.org.id, ["foo"], [date(2026, 11, 2)], [4]))

        self.assertEqual(
            {(date(2026, 11, 1), "foo"): 2, (date(2026, 11, 2), "foo"): 7},
            DailyTally.get_totals(self.org, "foo", date(2026, 11, 1), date(2026, 11, 3)),
        )


class DailyTallyTest(TembaTest):
    def test_get_totals(self):
        r = get_valkey_connection()

        self.org.daily_tallies.create(scope="emails:shared", day=date(2026, 10, 31), count=2)
        self.org.daily_tallies.create(scope="emails:shared", day=date(2026, 11, 1), count=3)
        self.org.daily_tallies.create(scope="other", day=date(2026, 11, 1), count=4)
        self.org2.daily_tallies.create(scope="emails:shared", day=date(2026, 11, 1), count=5)

        r.hset(
            f"tallies:daily:{self.org.id}",
            mapping={"emails:shared:2026-11-01": 1, "emails:shared:2026-11-02": 6, "emails:shared:2026-11-03": 9},
        )
        r.hset(f"tallies:daily:{self.org.id}:flushing", mapping={"emails:shared:2026-11-01": 10, "_gen": 3})

        self.assertEqual(
            {(date(2026, 11, 1), "emails:shared"): 14, (date(2026, 11, 2), "emails:shared"): 6},
            DailyTally.get_totals(self.org, "emails:", date(2026, 11, 1), date(2026, 11, 3)),
        )
        self.assertEqual(
            {(date(2026, 11, 1), "emails:shared"): 5},
            DailyTally.get_totals(self.org2, "emails:", date(2026, 11, 1), date(2026, 11, 3)),
        )

    def test_trim(self):
        today = timezone.now().date()

        def create(scope, days_ago):
            return self.org.daily_tallies.create(scope=scope, day=today - timedelta(days=days_ago), count=1)

        email1 = create("emails:shared", 366)
        email2 = create("emails:shared", 365)
        other1 = create("other", 91)
        other2 = create("other", 90)

        self.assertEqual({"deleted": 2}, trim_daily_tallies())
        self.assertEqual({email2, other2}, set(DailyTally.objects.all()))
        self.assertFalse(DailyTally.objects.filter(id__in=(email1.id, other1.id)).exists())
