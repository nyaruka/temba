from datetime import datetime, timedelta, timezone as tzone

from temba.channels.models import ChannelEvent
from temba.tests import MigrationTest


class FixBadLastSeenOnsTest(MigrationTest):
    app = "contacts"
    migrate_from = "0214_alter_contactimport_uuid"
    migrate_to = "0215_fix_bad_last_seen_ons"

    def setUpBeforeMigration(self, apps):
        zero_date = datetime(1, 1, 1, 0, 0, tzinfo=tzone.utc)
        good_date = datetime(2025, 6, 15, 12, 0, tzinfo=tzone.utc)

        # contact with bad last_seen_on and a message
        self.contact1 = self.create_contact("Bob", urns=["tel:+593979000001"])
        self.msg1 = self.create_incoming_msg(self.contact1, "Hello")
        self.contact1.last_seen_on = zero_date
        self.contact1.save(update_fields=["last_seen_on"])

        # contact with bad last_seen_on and no messages/events
        self.contact2 = self.create_contact("Jim", urns=["tel:+593979000002"])
        self.contact2.last_seen_on = zero_date
        self.contact2.save(update_fields=["last_seen_on"])

        # contact with good last_seen_on - should not be affected
        self.contact3 = self.create_contact("Ann", urns=["tel:+593979000003"])
        self.contact3.last_seen_on = good_date
        self.contact3.save(update_fields=["last_seen_on"])

        # contact with bad last_seen_on, message and event - should pick newest
        self.contact4 = self.create_contact("Eve", urns=["tel:+593979000004"])
        self.msg4 = self.create_incoming_msg(self.contact4, "Hi")
        self.evt4 = self.create_channel_event(
            self.channel,
            "tel:+593979000004",
            ChannelEvent.TYPE_CALL_IN_MISSED,
        )
        # set event's created_on to be later than message's created_on
        self.evt4.created_on = self.msg4.created_on + timedelta(hours=1)
        self.evt4.save(update_fields=["created_on"])
        self.contact4.last_seen_on = zero_date
        self.contact4.save(update_fields=["last_seen_on"])

        self.start = datetime.now(tzone.utc)

    def test_migration(self):
        self.contact1.refresh_from_db()
        self.assertEqual(self.msg1.created_on, self.contact1.last_seen_on)
        self.assertGreater(self.contact1.modified_on, self.start)

        # contact with no messages/events falls back to modified_on
        self.contact2.refresh_from_db()
        self.assertIsNotNone(self.contact2.last_seen_on)
        self.assertGreater(self.contact2.modified_on, self.start)

        self.contact3.refresh_from_db()
        self.assertEqual(datetime(2025, 6, 15, 12, 0, tzinfo=tzone.utc), self.contact3.last_seen_on)
        self.assertLess(self.contact3.modified_on, self.start)

        self.contact4.refresh_from_db()
        self.assertEqual(self.evt4.created_on, self.contact4.last_seen_on)  # event is newer than message
        self.assertGreater(self.contact4.modified_on, self.start)
