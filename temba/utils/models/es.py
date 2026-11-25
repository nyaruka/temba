from django.db import models


class SearchSliceQuerySet(models.query.RawQuerySet):
    """
    QuerySet defined by a model, set of UUIDs, offset and total count
    """

    def __init__(self, model, uuids, *, offset, total, only=None, using="default", _raw_query=None):
        if _raw_query:
            # we're being cloned so can reuse our SQL query
            raw_query = _raw_query
        else:
            cols = ", ".join([f"t.{f}" for f in only]) if only else "t.*"
            table = model._meta.db_table

            if len(uuids) > 0:
                # build a list of sequence to model uuid, so we can sort by the sequence in our results
                pairs = ", ".join(f"({seq}, '{uuid}')" for seq, uuid in enumerate(uuids, start=1))

                raw_query = f"""SELECT {cols} FROM {table} t JOIN (VALUES {pairs}) tmp_resultset (seq, model_uuid) ON t.uuid = tmp_resultset.model_uuid ORDER BY tmp_resultset.seq"""
            else:
                raw_query = f"""SELECT {cols} FROM {table} t WHERE t.id < 0"""

        super().__init__(raw_query, model, using=using)

        self.uuids = uuids
        self.offset = offset
        self.total = total

    def __getitem__(self, k):
        """
        Called to slice our queryset. UUID Slice Query Sets are created pre-sliced, that is the offset and counts should
        match the way any kind of paginator is going to try to slice the queryset.
        """
        if isinstance(k, int):
            # single item
            if k < self.offset or k >= self.offset + len(self.uuids):
                raise IndexError("attempt to access element outside slice")

            return super().__getitem__(k - self.offset)

        elif isinstance(k, slice):
            start = k.start if k.start else 0
            if start != self.offset:
                raise IndexError(
                    f"attempt to slice UUID queryset with differing offset: [{k.start}:{k.stop}] != [{self.offset}:{self.offset + len(self.uuids)}]"
                )

            return list(self)[: k.stop - self.offset]

        else:
            raise TypeError(f"__getitem__ index must be int, not {type(k)}")

    def all(self):
        return self

    def none(self):
        return SearchSliceQuerySet(self.model, [], offset=0, total=0, using=self._db)

    def count(self):
        return self.total

    def filter(self, **kwargs):
        uuids = list(self.uuids)

        for k, v in kwargs.items():
            if k == "uuid":
                uuids = [u for u in uuids if u == str(v)]
            elif k == "uuid__in":
                v = {str(j) for j in v}
                uuids = [u for u in uuids if u in v]
            elif k == "pk":
                # look up UUID for this pk so we can filter against our UUID list
                match = self.model.objects.filter(pk=v).values_list("uuid", flat=True).first()
                uuids = [u for u in uuids if u == str(match)] if match else []
            elif k == "pk__in":
                matches = {str(u) for u in self.model.objects.filter(pk__in=v).values_list("uuid", flat=True)}
                uuids = [u for u in uuids if u in matches]
            else:
                raise ValueError(f"SearchSliceQuerySet instances can only be filtered by pk or uuid, not {k}")

        return SearchSliceQuerySet(self.model, uuids, offset=0, total=len(uuids), using=self._db)

    def _clone(self):
        return self.__class__(
            self.model,
            self.uuids,
            offset=self.offset,
            total=self.total,
            using=self._db,
            _raw_query=self.raw_query,
        )
