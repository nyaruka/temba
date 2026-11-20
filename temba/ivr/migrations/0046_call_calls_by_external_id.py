from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations, models


class Migration(migrations.Migration):
    # a plain index build would block writes to the calls table for its duration, so it's created concurrently
    atomic = False

    dependencies = [
        ("ivr", "0045_backfill_call_minute_tallies"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="call",
            index=models.Index(fields=["channel", "external_id"], name="calls_by_external_id"),
        ),
    ]
