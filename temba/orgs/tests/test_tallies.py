from datetime import date, timedelta
from unittest.mock import patch

from django_valkey import get_valkey_connection

from django.db import connection
from django.utils import timezone

from temba.orgs.models import Tally, TallyFlush
from temba.orgs.tasks import trim_tallies
from temba.tests import TembaTest, cleanup


def field(org, scope: str) -> str:
    return f"{org.id}|{scope}"


class TallyTest(TembaTest):
    @cleanup(valkey=True)
    def test_get_totals(self):
        r = get_valkey_connection()

        self.org.tallies.create(scope="foo/1", count=2)
        self.org.tallies.create(scope="foo/2", count=3)
        self.org.tallies.create(scope="emails/shared@2026-11-01", count=5, expires_on=date(2027, 11, 1))
        self.org2.tallies.create(scope="foo/1", count=5)

        # nothing buffered and nothing flushed yet
        self.assertEqual({"foo/1": 2, "foo/2": 3}, Tally.get_totals(self.org, ["foo/1", "foo/2", "foo/3"]))
        self.assertEqual({}, Tally.get_totals(self.org, ["foo/3"]))
        self.assertEqual({}, Tally.get_totals(self.org, []))

        r.hset(
            "{tallies}:live",
            mapping={field(self.org, "foo/1"): 1, field(self.org, "foo/3"): 6, field(self.org2, "foo/1"): 100},
        )
        r.hset(
            "{tallies}:flushing", mapping={field(self.org, "foo/1"): 10, field(self.org, "emails/shared@2026-11-01"): 1}
        )
        r.hset("{tallies}:batch", mapping={field(self.org, "foo/2"): 20, field(self.org2, "foo/1"): 1000})
        r.set("{tallies}:batch_id", 8)
        TallyFlush.objects.create(name="tallies", last_batch=7)

        # batch 8 hasn't been committed so is included
        self.assertEqual(
            {"foo/1": 13, "foo/2": 23, "foo/3": 6, "emails/shared@2026-11-01": 6},
            Tally.get_totals(self.org, ["foo/1", "foo/2", "foo/3", "emails/shared@2026-11-01"]),
        )
        self.assertEqual({"foo/1": 1105}, Tally.get_totals(self.org2, ["foo/1"]))

        # batch 8 has been committed but not yet deleted, so is only counted in the rows
        TallyFlush.objects.filter(name="tallies").update(last_batch=8)
        self.org.tallies.filter(scope="foo/2").update(count=23)
        self.org2.tallies.filter(scope="foo/1").update(count=1005)

        self.assertEqual(
            {"foo/1": 13, "foo/2": 23, "foo/3": 6}, Tally.get_totals(self.org, ["foo/1", "foo/2", "foo/3"])
        )
        self.assertEqual({"foo/1": 1105}, Tally.get_totals(self.org2, ["foo/1"]))

        # and then deleted
        r.delete("{tallies}:batch")

        self.assertEqual(
            {"foo/1": 13, "foo/2": 23, "foo/3": 6}, Tally.get_totals(self.org, ["foo/1", "foo/2", "foo/3"])
        )

    @cleanup(valkey=True)
    def test_get_totals_retries(self):
        r = get_valkey_connection()

        # batch 5 was committed after we read Valkey, so may have taken our count from flushing into the rows
        self.org.tallies.create(scope="foo", count=5)
        r.hset("{tallies}:flushing", field(self.org, "foo"), 3)
        r.set("{tallies}:batch_id", 4)
        TallyFlush.objects.create(name="tallies", last_batch=5)

        self.assertEqual(({"foo": 8}, False), Tally._read_totals(self.org, ["foo"]))

        with patch.object(Tally, "_read_totals", side_effect=[({"foo": 8}, False), ({"foo": 5}, True)]) as mock_read:
            self.assertEqual({"foo": 5}, Tally.get_totals(self.org, ["foo"]))
            self.assertEqual(2, mock_read.call_count)

        # but only a few times
        with patch.object(Tally, "_read_totals", wraps=Tally._read_totals) as mock_read:
            self.assertEqual({"foo": 8}, Tally.get_totals(self.org, ["foo"]))
            self.assertEqual(3, mock_read.call_count)

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

        self.assertEqual({"foo/1": 6, "foo/2@2026-11-02": 4}, Tally.get_totals(self.org, ["foo/1", "foo/2@2026-11-02"]))
        self.assertEqual(date(2027, 11, 2), self.org.tallies.get(scope="foo/2@2026-11-02").expires_on)

    def test_trim(self):
        today = timezone.now().date()

        tally1 = self.org.tallies.create(scope="foo/1", count=1)
        self.org.tallies.create(scope="foo/2@2025-11-01", count=1, expires_on=today - timedelta(days=1))
        tally3 = self.org.tallies.create(scope="foo/2@2025-11-02", count=1, expires_on=today)

        self.assertEqual({"deleted": 1}, trim_tallies())
        self.assertEqual({tally1, tally3}, set(Tally.objects.all()))
