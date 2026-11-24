import django.db.models.deletion
from django.db import migrations, models

from temba.utils.db.operations import drop_column_index


class Migration(migrations.Migration):
    # each foreign key leads a composite index which serves its lookups
    atomic = False

    dependencies = [
        ("msgs", "0333_update_triggers"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[drop_column_index("msgs_msg_labels", "msg_id", "msgs_msg_labels_msg_id_a1f8fefa")],
            state_operations=[
                migrations.AlterField(
                    model_name="msglabel",
                    name="msg",
                    field=models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.CASCADE,
                        to="msgs.msg",
                    ),
                )
            ],
        ),
    ]
