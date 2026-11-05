from datetime import date

from temba.tests import TembaTest

from ..models import ChannelCount
from ..tasks import squash_channel_counts


class ChannelCountTest(TembaTest):
    def test_counts(self):
        contact = self.create_contact("Joe", phone="+250788111222")

        # messages no longer write channel counts
        self.create_incoming_msg(contact, "A")
        self.create_outgoing_msg(contact, "B")
        self.assertEqual(0, ChannelCount.objects.count())

        def add(day, scope, count):
            ChannelCount.objects.create(channel=self.channel, day=day, scope=scope, count=count, is_squashed=False)

        add(date(2023, 5, 31), "text:in", 1)
        add(date(2023, 6, 1), "text:in", 1)
        add(date(2023, 6, 1), "text:in", 1)
        add(date(2023, 6, 1), "text:out", 3)
        add(date(2023, 6, 1), "voice:in", 1)

        expected = {
            (date(2023, 5, 31), "text:in"): 1,
            (date(2023, 6, 1), "text:in"): 2,
            (date(2023, 6, 1), "text:out"): 3,
            (date(2023, 6, 1), "voice:in"): 1,
        }
        self.assertEqual(expected, self.channel.counts.day_totals(scoped=True))

        squash_channel_counts()

        self.assertEqual(4, ChannelCount.objects.count())
        self.assertEqual(expected, self.channel.counts.day_totals(scoped=True))
