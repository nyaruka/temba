from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations, models


class Migration(migrations.Migration):
    # A plain index build would block writes to the counts tables for its duration, so they're created concurrently.
    # Installations large enough to care can run the following ahead of the deploy, and fake this migration:
    #
    #   CREATE INDEX CONCURRENTLY "broadcastmsgcount_unsquashed" ON msgs_broadcastmsgcount ("broadcast_id") WHERE NOT "is_squashed";
    #   CREATE INDEX CONCURRENTLY "labelcount_unsquashed" ON msgs_labelcount ("label_id") WHERE NOT "is_squashed";
    #
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
