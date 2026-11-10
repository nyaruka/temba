from datetime import date, datetime, timedelta, timezone as tzone
from unittest.mock import patch

from django_valkey import get_valkey_connection

from django.db import connection, connections
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from temba.flows.models import FlowTally
from temba.orgs.models import OrgTally, TallyFlush
from temba.orgs.tasks import trim_tallies
from temba.tests import TembaTest, cleanup


def field(org, scope: str) -> str:
    return f"O{org.id}|{scope}"


class TallyTest(TembaTest):
    @cleanup(valkey=True)
    def test_get_totals(self):
        r = get_valkey_connection()

        self.org.org_tallies.create(scope="foo/1", count=2)
        self.org.org_tallies.create(scope="foo/2", count=3)
        self.org.org_tallies.create(scope="emails/shared@2026-11-01", count=5, expires_on=date(2027, 11, 1))
        self.org2.org_tallies.create(scope="foo/1", count=5)

        # nothing buffered and nothing flushed yet
        self.assertEqual({"foo/1": 2, "foo/2": 3}, OrgTally.get_totals(self.org, ["foo/1", "foo/2", "foo/3"]))
        self.assertEqual({}, OrgTally.get_totals(self.org, ["foo/3"]))
        self.assertEqual({}, OrgTally.get_totals(self.org, []))
        self.assertEqual({"foo/1": 2}, OrgTally.get_totals(self.org, ["foo/1", "foo/1"]))

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

        # duplicate scopes are only counted once
        self.assertEqual({"foo/1": 13}, OrgTally.get_totals(self.org, ["foo/1", "foo/1"]))

        # batch 8 hasn't been committed so is included
        self.assertEqual(
            {"foo/1": 13, "foo/2": 23, "foo/3": 6, "emails/shared@2026-11-01": 6},
            OrgTally.get_totals(self.org, ["foo/1", "foo/2", "foo/3", "emails/shared@2026-11-01"]),
        )
        self.assertEqual({"foo/1": 1105}, OrgTally.get_totals(self.org2, ["foo/1"]))
        self.assertEqual(
            {(self.org.id, "foo/1"): 13, (self.org.id, "foo/3"): 6, (self.org2.id, "foo/1"): 1105},
            OrgTally.get_totals_by_org([self.org, self.org2], ["foo/1", "foo/3"]),
        )
        self.assertEqual({}, OrgTally.get_totals_by_org([], ["foo/1"]))

        # batch 8 has been committed but not yet deleted, so is only counted in the rows
        TallyFlush.objects.filter(name="tallies").update(last_batch=8)
        self.org.org_tallies.filter(scope="foo/2").update(count=23)
        self.org2.org_tallies.filter(scope="foo/1").update(count=1005)

        self.assertEqual(
            {"foo/1": 13, "foo/2": 23, "foo/3": 6}, OrgTally.get_totals(self.org, ["foo/1", "foo/2", "foo/3"])
        )
        self.assertEqual({"foo/1": 1105}, OrgTally.get_totals(self.org2, ["foo/1"]))

        # and then deleted
        r.delete("{tallies}:batch")

        self.assertEqual(
            {"foo/1": 13, "foo/2": 23, "foo/3": 6}, OrgTally.get_totals(self.org, ["foo/1", "foo/2", "foo/3"])
        )

        # fields with an unprefixed org from older writers are also counted
        r.hset("{tallies}:live", f"{self.org.id}|foo/1", 100)

        self.assertEqual({"foo/1": 113}, OrgTally.get_totals(self.org, ["foo/1"]))

    @cleanup(valkey=True)
    def test_get_daily_totals(self):
        r = get_valkey_connection()

        def tally(org, scope: str, count: int):
            org.org_tallies.create(scope=scope, count=count, expires_on=date(2027, 11, 5))

        tally(self.org, "foo/1@2026-10-31", 1)
        tally(self.org, "foo/1@2026-11-01", 2)
        tally(self.org, "foo/1@2026-11-04", 3)
        tally(self.org, "foo/1@2026-11-05", 4)
        tally(self.org, "foo/2@2026-11-01", 5)
        tally(self.org, "foo/10@2026-11-01", 6)  # shares foo/1's prefix
        tally(self.org, "foo/1/x@2026-11-01", 7)
        tally(self.org2, "foo/1@2026-11-01", 8)
        self.org.org_tallies.create(scope="foo/1", count=9)

        # only today's are read from Valkey
        r.hset(
            "{tallies}:live",
            mapping={
                field(self.org, "foo/1@2026-11-05"): 10,
                field(self.org, "foo/1@2026-11-04"): 100,
                field(self.org2, "foo/1@2026-11-05"): 20,
            },
        )

        with patch("django.utils.timezone.now", return_value=datetime(2026, 11, 5, 12, 0, 0, 0, tzone.utc)):
            self.assertEqual(
                {
                    (date(2026, 11, 1), "foo/1"): 2,
                    (date(2026, 11, 4), "foo/1"): 3,
                    (date(2026, 11, 5), "foo/1"): 14,
                    (date(2026, 11, 1), "foo/2"): 5,
                },
                OrgTally.get_daily_totals(self.org, ["foo/1", "foo/2", "foo/1"], date(2026, 11, 1), date(2026, 11, 6)),
            )

            # until is exclusive
            self.assertEqual(
                {(date(2026, 10, 31), "foo/1"): 1, (date(2026, 11, 1), "foo/1"): 2},
                OrgTally.get_daily_totals(self.org, ["foo/1"], date(2026, 10, 1), date(2026, 11, 4)),
            )

            # just today
            self.assertEqual(
                {(date(2026, 11, 5), "foo/1"): 14},
                OrgTally.get_daily_totals(self.org, ["foo/1"], date(2026, 11, 5), date(2026, 11, 6)),
            )

            self.assertEqual({}, OrgTally.get_daily_totals(self.org, ["foo/3"], date(2026, 11, 1), date(2026, 11, 6)))
            self.assertEqual({}, OrgTally.get_daily_totals(self.org, [], date(2026, 11, 1), date(2026, 11, 6)))

            # across workspaces
            self.assertEqual(
                {
                    (self.org.id, date(2026, 11, 1), "foo/1"): 2,
                    (self.org.id, date(2026, 11, 4), "foo/1"): 3,
                    (self.org.id, date(2026, 11, 5), "foo/1"): 14,
                    (self.org2.id, date(2026, 11, 1), "foo/1"): 8,
                    (self.org2.id, date(2026, 11, 5), "foo/1"): 20,
                },
                OrgTally.get_daily_totals_by_org(
                    [self.org, self.org2], ["foo/1"], date(2026, 11, 1), date(2026, 11, 6)
                ),
            )
            self.assertEqual({}, OrgTally.get_daily_totals_by_org([], ["foo/1"], date(2026, 11, 1), date(2026, 11, 6)))

            # earlier days can be read from another database, but today's always come from the default one
            with (
                CaptureQueriesContext(connections["default"]) as default_queries,
                CaptureQueriesContext(connections["readonly"]) as readonly_queries,
            ):
                totals = OrgTally.get_daily_totals(
                    self.org, ["foo/1"], date(2026, 11, 1), date(2026, 11, 6), using="readonly"
                )

            # the readonly connection is outside the test's transaction so can't see earlier days' rows
            self.assertEqual({(date(2026, 11, 5), "foo/1"): 14}, totals)
            self.assertEqual(1, len(readonly_queries))
            self.assertNotIn("orgs_tallyflush", readonly_queries[0]["sql"])
            self.assertEqual(1, len(default_queries))
            self.assertIn("orgs_tallyflush", default_queries[0]["sql"])

            # and earlier days' rows read from it are included, given a connection which can see them
            with patch("temba.orgs.models.connections", {"readonly": connection}):
                self.assertEqual(
                    {
                        (date(2026, 11, 1), "foo/1"): 2,
                        (date(2026, 11, 4), "foo/1"): 3,
                        (date(2026, 11, 5), "foo/1"): 14,
                    },
                    OrgTally.get_daily_totals(
                        self.org, ["foo/1"], date(2026, 11, 1), date(2026, 11, 6), using="readonly"
                    ),
                )

    @cleanup(valkey=True)
    def test_get_totals_retries(self):
        r = get_valkey_connection()

        # batch 5 was committed after we read Valkey, so may have taken our count from flushing into the rows
        self.org.org_tallies.create(scope="foo", count=5)
        r.hset("{tallies}:flushing", field(self.org, "foo"), 3)
        r.set("{tallies}:batch_id", 4)
        TallyFlush.objects.create(name="tallies", last_batch=5)

        self.assertEqual(({(self.org.id, "foo"): 8}, False), OrgTally._read_totals([self.org.id], ["foo"]))

        # same if no batch had been created when we read Valkey
        r.delete("{tallies}:batch_id")
        self.assertEqual(({(self.org.id, "foo"): 8}, False), OrgTally._read_totals([self.org.id], ["foo"]))
        r.set("{tallies}:batch_id", 4)

        with patch.object(
            OrgTally,
            "_read_totals",
            side_effect=[({(self.org.id, "foo"): 8}, False), ({(self.org.id, "foo"): 5}, True)],
        ) as mock_read:
            self.assertEqual({"foo": 5}, OrgTally.get_totals(self.org, ["foo"]))
            self.assertEqual(2, mock_read.call_count)

        # but only a few times
        with (
            patch.object(OrgTally, "_read_totals", wraps=OrgTally._read_totals) as mock_read,
            self.assertLogs("temba.orgs.models", level="WARNING"),
        ):
            self.assertEqual({"foo": 8}, OrgTally.get_totals(self.org, ["foo"]))
            self.assertEqual(3, mock_read.call_count)

    def test_trim(self):
        today = timezone.now().date()
        flow = self.create_flow("Test")

        tally1 = self.org.org_tallies.create(scope="foo/1", count=1)
        self.org.org_tallies.create(scope="foo/2@2025-11-01", count=1, expires_on=today - timedelta(days=1))
        tally3 = self.org.org_tallies.create(scope="foo/2@2025-11-02", count=1, expires_on=today)
        flow_tally1 = flow.tallies.create(scope="foo/1", count=1)
        flow.tallies.create(scope="foo/2@2025-11-01", count=1, expires_on=today - timedelta(days=1))

        self.assertEqual({"deleted": 2}, trim_tallies())
        self.assertEqual({tally1, tally3}, set(OrgTally.objects.all()))
        self.assertEqual({flow_tally1}, set(FlowTally.objects.all()))

    def test_upsert(self):
        # check the primary key can be the target of the upserts used for flushing
        sql = """
        INSERT INTO orgs_orgtally AS t (org_id, scope, count, expires_on)
        SELECT %s, unnest(%s::text[]), unnest(%s::bigint[]), unnest(%s::date[])
        ON CONFLICT (org_id, scope) DO UPDATE SET count = t.count + excluded.count
        """
        with connection.cursor() as cursor:
            cursor.execute(sql, (self.org.id, ["foo/1", "foo/2@2026-11-02"], [2, 3], [None, date(2027, 11, 2)]))
            cursor.execute(sql, (self.org.id, ["foo/1", "foo/2@2026-11-02"], [4, 1], [None, date(2028, 1, 1)]))

        self.assertEqual(6, self.org.org_tallies.get(scope="foo/1").count)
        self.assertEqual(4, self.org.org_tallies.get(scope="foo/2@2026-11-02").count)
        self.assertEqual(date(2027, 11, 2), self.org.org_tallies.get(scope="foo/2@2026-11-02").expires_on)

    def test_ranges(self):
        # under the C collation, a scope's dated rows are a range under plain comparison, whereas under a locale
        # collation punctuation is ignored at first so foo-2026-11-03 would sort between them
        for scope in (
            "foo@2026-11-01",
            "foo@2026-11-02",
            "foo@2026-11-03",
            "foo/1@2026-11-02",
            "fooa@2026-11-02",
            "foo-2026-11-03",
        ):
            self.org.org_tallies.create(scope=scope, count=1)

        in_range = self.org.org_tallies.filter(scope__gte="foo@2026-11-02", scope__lt="foo@2026-11-04")
        self.assertEqual(
            ["foo@2026-11-02", "foo@2026-11-03"], list(in_range.order_by("scope").values_list("scope", flat=True))
        )
        self.assertEqual(
            ["foo/1@2026-11-02"],
            list(self.org.org_tallies.filter(scope__startswith="foo/").values_list("scope", flat=True)),
        )
