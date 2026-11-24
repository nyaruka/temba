from django.db import connection, migrations

BATCH_SIZE = 500

# Mailroom records each sync as it happens, so this only fills channels which haven't synced since it started, from
# their newest sync event, so that a phone which has stopped syncing still shows as delayed. Channels that already
# have android state are skipped, including any that sync while this runs.
BACKFILL_SQL = r"""
UPDATE channels_channel c
   SET sync_state = COALESCE(c.sync_state, '{}') || jsonb_build_object('android', jsonb_build_object(
           'synced_on', e.created_on,
           'power_source', e.power_source,
           'power_status', e.power_status,
           'power_level', e.power_level,
           'network_type', e.network_type,
           'pending_message_count', e.pending_message_count,
           'retry_message_count', e.retry_message_count,
           'incoming_command_count', e.incoming_command_count,
           'outgoing_command_count', e.outgoing_command_count
       ))
  FROM (
      SELECT DISTINCT ON (channel_id) *
        FROM channels_syncevent
       WHERE channel_id = ANY(%(channel_ids)s)
    ORDER BY channel_id, id DESC
  ) e
 WHERE c.id = e.channel_id AND (c.sync_state IS NULL OR NOT c.sync_state ? 'android')"""


def backfill_android_sync_state(apps, schema_editor):
    Channel = apps.get_model("channels", "Channel")

    channel_ids = list(
        Channel.objects.filter(channel_type="A", is_active=True).order_by("id").values_list("id", flat=True)
    )

    for i in range(0, len(channel_ids), BATCH_SIZE):
        with connection.cursor() as cursor:
            cursor.execute(BACKFILL_SQL, {"channel_ids": channel_ids[i : i + BATCH_SIZE]})


class Migration(migrations.Migration):
    atomic = False

    dependencies = [("channels", "0229_channel_sync_state_default")]

    operations = [migrations.RunPython(backfill_android_sync_state, migrations.RunPython.noop)]
