from temba.channels.models import Channel
from temba.contacts.models import URN
from temba.tests import MigrationTest
from temba.triggers.models import Trigger


class DeactivateRemovedTypeChannelsTest(MigrationTest):
    app = "channels"
    migrate_from = "0222_drop_channelcount"
    migrate_to = "0223_deactivate_removed_type_channels"

    def setUpBeforeMigration(self, apps):
        # these types no longer exist so their channels have to be created directly
        self.removed1 = self._create_channel("DK", "1234")
        self.removed2 = self._create_channel("H9", "2345")
        self.removed3 = self._create_channel("DK", "4567", is_active=False)
        self.other = self.create_channel("EX", "External", "3456", schemes=[URN.TEL_SCHEME])

        flow = self.create_flow("Test")
        self.removed1_trigger = self._create_trigger(flow, self.removed1)
        self.removed3_trigger = self._create_trigger(flow, self.removed3)
        self.other_trigger = self._create_trigger(flow, self.other)

    def _create_channel(self, channel_type: str, address: str, is_active: bool = True):
        return Channel.objects.create(
            org=self.org,
            channel_type=channel_type,
            name="Old",
            address=address,
            config={},
            role=Channel.DEFAULT_ROLE,
            schemes=[URN.TEL_SCHEME],
            created_by=self.admin,
            modified_by=self.admin,
            is_active=is_active,
        )

    def _create_trigger(self, flow, channel):
        return Trigger.objects.create(
            org=self.org,
            trigger_type=Trigger.TYPE_NEW_CONVERSATION,
            flow=flow,
            channel=channel,
            priority=0,
            created_by=self.admin,
            modified_by=self.admin,
        )

    def test_migration(self):
        for ch in (self.removed1, self.removed2, self.other):
            ch.refresh_from_db()

        self.assertFalse(self.removed1.is_active)
        self.assertFalse(self.removed2.is_active)
        self.assertTrue(self.other.is_active)

        for trigger in (self.removed1_trigger, self.removed3_trigger, self.other_trigger):
            trigger.refresh_from_db()

        self.assertFalse(self.removed1_trigger.is_active)
        self.assertTrue(self.removed1_trigger.is_archived)
        self.assertFalse(self.removed3_trigger.is_active)  # channel was already inactive
        self.assertTrue(self.removed3_trigger.is_archived)
        self.assertTrue(self.other_trigger.is_active)
        self.assertFalse(self.other_trigger.is_archived)
