from datetime import date, timedelta

from django.utils import timezone

from temba.ai.models import LLM, LLMCount
from temba.ai.tasks import squash_llm_counts, trim_llm_counts
from temba.ai.types.openai.type import OpenAIType
from temba.tests import TembaTest


class LLMCountTest(TembaTest):
    def test_counts(self):
        llm = LLM.create(self.org, self.admin, OpenAIType(), "gpt-4o", "GPT-4", {})

        self.assertEqual(0, LLMCount.objects.count())

        # simulate mailroom inserting unsquashed deltas across two days
        d1 = date(2025, 5, 1)
        d2 = date(2025, 5, 2)

        LLMCount.objects.create(llm=llm, day=d1, scope=LLMCount.SCOPE_CALLS, count=1)
        LLMCount.objects.create(llm=llm, day=d1, scope=LLMCount.SCOPE_CALLS, count=2)
        LLMCount.objects.create(llm=llm, day=d1, scope=LLMCount.SCOPE_TOKENS_IN, count=120)
        LLMCount.objects.create(llm=llm, day=d1, scope=LLMCount.SCOPE_TOKENS_OUT, count=340)
        LLMCount.objects.create(llm=llm, day=d2, scope=LLMCount.SCOPE_CALLS, count=4)
        LLMCount.objects.create(llm=llm, day=d2, scope=LLMCount.SCOPE_TOKENS_IN, count=200)
        LLMCount.objects.create(llm=llm, day=d2, scope=LLMCount.SCOPE_TOKENS_OUT, count=500)

        self.assertEqual(
            {
                (d1, "calls"): 3,
                (d1, "tokens:in"): 120,
                (d1, "tokens:out"): 340,
                (d2, "calls"): 4,
                (d2, "tokens:in"): 200,
                (d2, "tokens:out"): 500,
            },
            llm.counts.day_totals(scoped=True),
        )

        squash_llm_counts()

        # one row per (llm, day, scope)
        self.assertEqual(6, LLMCount.objects.count())
        self.assertEqual(0, LLMCount.objects.filter(is_squashed=False).count())

        # totals are unchanged
        self.assertEqual(
            {
                (d1, "calls"): 3,
                (d1, "tokens:in"): 120,
                (d1, "tokens:out"): 340,
                (d2, "calls"): 4,
                (d2, "tokens:in"): 200,
                (d2, "tokens:out"): 500,
            },
            llm.counts.day_totals(scoped=True),
        )

        # period filtering for "last N days" style queries
        self.assertEqual(
            {(d2, "calls"): 4, (d2, "tokens:in"): 200, (d2, "tokens:out"): 500},
            llm.counts.period(d2, d2 + timedelta(days=1)).day_totals(scoped=True),
        )

        # prefix-only totals
        self.assertEqual({"tokens:in": 320, "tokens:out": 840}, llm.counts.prefix("tokens:").scope_totals())

    def test_trim(self):
        llm = LLM.create(self.org, self.admin, OpenAIType(), "gpt-4o", "GPT-4", {})

        today = timezone.now().date()
        old = today - timedelta(days=31)
        recent = today - timedelta(days=29)

        LLMCount.objects.create(llm=llm, day=old, scope=LLMCount.SCOPE_CALLS, count=1)
        LLMCount.objects.create(llm=llm, day=recent, scope=LLMCount.SCOPE_CALLS, count=2)

        trim_llm_counts()

        self.assertEqual([recent], list(LLMCount.objects.values_list("day", flat=True)))

    def test_release_keeps_counts_delete_drops_them(self):
        llm = LLM.create(self.org, self.admin, OpenAIType(), "gpt-4o", "GPT-4", {})
        LLMCount.objects.create(llm=llm, day=date(2025, 5, 1), scope=LLMCount.SCOPE_CALLS, count=1)

        # release is a soft-delete and leaves counts alone
        llm.release(self.admin)
        self.assertEqual(1, LLMCount.objects.count())

        # hard delete drops them
        llm.delete()
        self.assertEqual(0, LLMCount.objects.count())
