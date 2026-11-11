from django.db import connection, migrations

BATCH_SIZE = 5_000

# each batch deletes legacy rows and adds them onto channel tallies in one statement, so a re-run only moves rows that
# have been flushed since. Rows for channels that don't exist in that org are deleted without being moved because
# nothing can read them. Expiry dates are kept unless either row has none, as that means kept forever.
FOLD_SQL = r"""
WITH legacy AS (
    DELETE FROM orgs_orgtally
     WHERE (org_id, scope) IN (
             SELECT org_id, scope
               FROM orgs_orgtally
              WHERE org_id = %(org_id)s AND scope >= 'channels/' AND scope < 'channels0' AND scope ~ '^channels/[0-9]+/.'
           ORDER BY scope
              LIMIT %(batch_size)s
           )
 RETURNING org_id, substring(scope FROM '^channels/([0-9]+)/')::bigint AS channel_id,
           substring(scope FROM '^channels/[0-9]+/(.+)$') AS scope, count, expires_on
), moved AS (
    INSERT INTO channels_channeltally AS t (channel_id, scope, count, expires_on)
         SELECT l.channel_id, l.scope, l.count, l.expires_on
           FROM legacy l
           JOIN channels_channel c ON c.id = l.channel_id AND c.org_id = l.org_id
    ON CONFLICT (channel_id, scope) DO UPDATE
            SET count = t.count + excluded.count,
                expires_on = CASE
                    WHEN t.expires_on IS NULL OR excluded.expires_on IS NULL THEN NULL
                    ELSE GREATEST(t.expires_on, excluded.expires_on)
                END
      RETURNING 1
)
SELECT (SELECT count(*) FROM legacy), (SELECT count(*) FROM moved)"""


def fold_legacy_channel_tallies(apps, schema_editor):
    Org = apps.get_model("orgs", "Org")

    num_moved, num_dropped = 0, 0

    for org_id in Org.objects.order_by("id").values_list("id", flat=True).iterator():
        while True:
            with connection.cursor() as cursor:
                cursor.execute(FOLD_SQL, {"org_id": org_id, "batch_size": BATCH_SIZE})
                num_deleted, num_batch_moved = cursor.fetchone()

            num_moved += num_batch_moved
            num_dropped += num_deleted - num_batch_moved

            if num_deleted < BATCH_SIZE:
                break

    if num_moved or num_dropped:
        print(f"Moved {num_moved} legacy channel tallies (dropped {num_dropped} for channels that no longer exist)")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    fold_legacy_channel_tallies(apps, None)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("channels", "0224_channeltally"),
        ("orgs", "0202_grant_shared_email"),
    ]

    operations = [
        migrations.RunPython(fold_legacy_channel_tallies, migrations.RunPython.noop),
    ]
