from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations, models


class Migration(migrations.Migration):
    # a plain index build would block writes to the counts tables for its duration, so they're created concurrently
    atomic = False

    dependencies = [
        ("msgs", "0330_squashed_counts_unique"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="broadcastmsgcount",
            index=models.Index(
                condition=models.Q(("is_squashed", False)), fields=["broadcast"], name="broadcastmsgcount_unsquashed"
            ),
        ),
        AddIndexConcurrently(
            model_name="labelcount",
            index=models.Index(
                condition=models.Q(("is_squashed", False)), fields=["label"], name="labelcount_unsquashed"
            ),
        ),
    ]
