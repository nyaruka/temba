import itertools
from datetime import date

from django.db import connection, models
from django.db.models import Q, Sum

from temba.utils.db.queries import or_list


def get_merge_squashed_sql(table: str, columns: tuple) -> str:
    """
    Builds a query which merges any squashed rows of the given table which share values for the given columns,
    dropping them if they sum to zero.
    """

    cols = ", ".join([f'"{col}"' for col in columns])
    join_cond = " AND ".join([f'c."{col}" = d."{col}"' for col in columns])
    returning = ", ".join([f'c."{col}"' for col in columns])

    return f"""
    WITH dupes AS (
        SELECT {cols} FROM {table} WHERE "is_squashed" GROUP BY {cols} HAVING COUNT(*) > 1
    ), removed AS (
        DELETE FROM {table} c USING dupes d WHERE c."is_squashed" AND {join_cond}
        RETURNING {returning}, c."count"
    )
    INSERT INTO {table} ({cols}, "count", "is_squashed")
    SELECT {cols}, SUM("count"), TRUE FROM removed GROUP BY {cols} HAVING SUM("count") != 0;
    """


class CountQuerySet(models.QuerySet):
    """
    Custom queryset for count models.
    """

    def sum(self) -> int:
        """
        Sums counts over the matching rows.
        """
        return self.aggregate(count_sum=Sum("count"))["count_sum"] or 0


class BaseSquashableCount(models.Model):
    """
    Base class for models which track counts by delta insertions which are then periodically squashed.
    """

    squash_over = ()
    squash_max_distinct = 5000
    squash_batch_size = 500

    id = models.BigAutoField(auto_created=True, primary_key=True)
    count = models.BigIntegerField()
    is_squashed = models.BooleanField(default=False)

    objects = CountQuerySet.as_manager()

    @classmethod
    def get_squash_over(cls) -> tuple:
        return cls.squash_over

    @classmethod
    def get_unsquashed(cls):
        return cls.objects.filter(is_squashed=False)

    @classmethod
    def squash(cls) -> int:
        """
        Squashes the unsquashed rows of each distinct set of counts into that set's single squashed row, which is
        updated in place so that its id stays put. Returns the number of sets squashed.
        """

        squash_over = cls.get_squash_over()
        distinct_sets = list(
            cls.get_unsquashed()
            .values_list(*squash_over)
            .order_by(*squash_over)
            .distinct(*squash_over)[: cls.squash_max_distinct]
        )

        sql = cls.get_squash_query()

        for batch in itertools.batched(distinct_sets, cls.squash_batch_size):
            with connection.cursor() as cursor:
                cursor.execute(sql, [list(col) for col in zip(*batch)])

        return len(distinct_sets)

    @classmethod
    def get_squash_query(cls) -> str:
        """
        Builds the query which squashes a batch of sets, given as one array param per squash_over column. It relies
        on the unique index of squashed rows over the squash_over columns. Squashed rows which reach zero are deleted
        so that sets which drain, like the counts of a flow's nodes, don't leave rows behind.

        Only squashed rows are updated and only unsquashed rows are deleted, so writers inserting deltas never wait on
        it. An overlapping squash blocks on the rows being deleted and then skips them, so nothing is counted twice.
        """

        squash_over = cls.get_squash_over()
        table = cls._meta.db_table
        fields_by_column = {f.column: f for f in cls._meta.concrete_fields}

        def join(a, b):
            return " AND ".join([f'{a}."{col}" = {b}."{col}"' for col in squash_over])

        cols = ", ".join([f'"{col}"' for col in squash_over])
        arrays = ", ".join([f"%s::{fields_by_column[col].db_type(connection)}[]" for col in squash_over])
        returning = ", ".join([f'c."{col}"' for col in squash_over])

        return f"""
        WITH keys AS (
            SELECT * FROM unnest({arrays}) AS k({cols})
        ), removed AS (
            DELETE FROM {table} c USING keys k WHERE NOT c."is_squashed" AND {join("c", "k")}
            RETURNING {returning}, c."count"
        ), sums AS (
            SELECT {cols}, SUM("count") AS "count" FROM removed GROUP BY {cols}
        ), zeroed AS (
            DELETE FROM {table} c USING sums s WHERE c."is_squashed" AND {join("c", "s")} AND c."count" + s."count" = 0
            RETURNING {returning}
        )
        INSERT INTO {table} AS t ({cols}, "count", "is_squashed")
        SELECT {cols}, s."count", TRUE FROM sums s
        WHERE s."count" != 0 AND NOT EXISTS (SELECT 1 FROM zeroed z WHERE {join("z", "s")})
        ORDER BY {cols}
        ON CONFLICT ({cols}) WHERE "is_squashed" DO UPDATE SET "count" = t."count" + EXCLUDED."count";
        """

    class Meta:
        abstract = True


class ScopedCountQuerySet(CountQuerySet):
    """
    Specialized queryset for scope + count models.
    """

    def prefix(self, match: list | str):
        """
        Filters by the given scope prefix or list of prefixes.
        """
        if isinstance(match, list):
            if match:
                return self.filter(or_list([Q(scope__startswith=p) for p in match]))
            else:
                return self.none()

        return self.filter(scope__startswith=match)

    def scope_totals(self) -> dict[str, int]:
        """
        Sums counts grouped by scope.
        """
        counts = self.values_list("scope").annotate(count_sum=Sum("count"))
        return {c[0]: c[1] for c in counts}


class BaseScopedCount(BaseSquashableCount):
    """
    Base class for count models which have scope field.
    """

    scope = models.CharField(max_length=128)

    objects = ScopedCountQuerySet.as_manager()

    class Meta:
        abstract = True


class DailyCountQuerySet(ScopedCountQuerySet):
    """
    Specialized queryset for scope + day + count models.
    """

    def period(self, since, until):
        return self.filter(day__gte=since, day__lt=until)

    def day_totals(self, *, scoped: bool) -> dict[date | tuple, int]:
        """
        Sums counts grouped by day or day + scope.
        """
        if scoped:
            counts = self.values_list("day", "scope").annotate(count_sum=Sum("count"))
            return {(c[0], c[1]): c[2] for c in counts}
        else:
            counts = self.values_list("day").annotate(count_sum=Sum("count"))
            return {c[0]: c[1] for c in counts}

    def month_totals(self, *, scoped: bool) -> dict[date | tuple, int]:
        """
        Sums counts grouped by month or month + scope.
        """

        with_month = self.extra({"month": "date_trunc('month', day)::date"})

        if scoped:
            counts = with_month.values_list("month", "scope").annotate(count_sum=Sum("count"))
            return {(c[0], c[1]): c[2] for c in counts}
        else:
            counts = with_month.values_list("month").annotate(count_sum=Sum("count"))
            return {c[0]: c[1] for c in counts}


class BaseDailyCount(BaseScopedCount):
    """
    Base class for count models which have scope and day field.
    """

    day = models.DateField()

    objects = DailyCountQuerySet.as_manager()

    class Meta:
        abstract = True
