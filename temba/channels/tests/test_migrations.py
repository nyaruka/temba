from datetime import timedelta

from django.utils import timezone

from temba.tests import MigrationTest


class BackfillAndroidSyncStateTest(MigrationTest):
    app = "channels"
    migrate_from = "0229_channel_sync_state_not_null"
    migrate_to = "0230_backfill_android_sync_state"

    def setUpBeforeMigration(self, apps):
        Channel = apps.get_model("channels", "Channel")
        SyncEvent = apps.get_model("channels", "SyncEvent")

        def sync(channel, hours_ago: int, power_level: int):
            SyncEvent.objects.create(
                channel_id=channel.id,
                power_source="BAT",
                power_status="DIS",
                power_level=power_level,
                network_type="WIFI",
                pending_message_count=2,
                retry_message_count=1,
                incoming_command_count=3,
                outgoing_command_count=4,
                created_on=timezone.now() - timedelta(hours=hours_ago),
            )

        # a phone that stopped syncing before mailroom recorded its state, with another kind of sync's state
        self.stopped = self.create_channel("A", "Stopped", "+250788000001")
        Channel.objects.filter(id=self.stopped.id).update(sync_state={"templates": {"failures": 1}})
        sync(self.stopped, 5, 40)
        sync(self.stopped, 3, 30)

        # one that has synced since, so already has its state
        self.syncing = self.create_channel("A", "Syncing", "+250788000002")
        sync(self.syncing, 3, 20)
        self.set_android_sync(self.syncing, power_level=90)

        # one that has never synced
        self.never = self.create_channel("A", "Never", "+250788000003")

    def test_migration(self):
        def android(channel):
            channel.refresh_from_db()
            return channel.sync_state

        state = android(self.stopped)
        self.assertEqual({"failures": 1}, state["templates"])
        self.assertEqual(
            {
                "power_source": "BAT",
                "power_status": "DIS",
                "power_level": 30,
                "network_type": "WIFI",
                "pending_message_count": 2,
                "retry_message_count": 1,
                "incoming_command_count": 3,
                "outgoing_command_count": 4,
            },
            {k: v for k, v in state["android"].items() if k != "synced_on"},
        )

        # it's what is_sync_delayed reads
        self.assertTrue(timezone.now() - self.stopped.last_sync.synced_on > timedelta(hours=2, minutes=59))

        self.assertEqual(90, android(self.syncing)["android"]["power_level"])
        self.assertEqual({}, android(self.never))
