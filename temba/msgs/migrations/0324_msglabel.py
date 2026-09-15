import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    # Msg.labels becomes a ManyToManyField with an explicit through model, MsgLabel, so that a labelling can carry
    # the message's uuid (added here as nullable, and backfilled, made NOT NULL and indexed in later migrations). The
    # model adopts the table Django created for the auto-generated through model - it's declared with that table's
    # name and with fields matching its columns and indexes exactly, so the only DDL here is renaming the unique
    # constraint to something readable (a metadata-only change) and adding the column. This follows the "Changing a
    # ManyToManyField to use a through model" recipe in Django's migrations how-to, which is still, as of 6.1, the
    # way to do it: the change is made to the migration state only, since a plain AlterField on Msg.labels would
    # drop the table and recreate it, losing every labelling.
    #
    # The table's id column is already bigint - the auto-generated through model's pk was converted along with the
    # others - so the state declares it as such.
    #
    # Nothing writes the new column until the services which insert labellings are deployed with support for it,
    # so this needs to land before that deploy, and the migrations which follow it need to wait until after it.

    dependencies = [
        ("msgs", "0323_remove_msg_outgoing_to_retry"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql="ALTER TABLE msgs_msg_labels RENAME CONSTRAINT msgs_msg_labels_msg_id_label_id_98060205_uniq "
                    "TO unique_msg_labels",
                    reverse_sql="ALTER TABLE msgs_msg_labels RENAME CONSTRAINT unique_msg_labels "
                    "TO msgs_msg_labels_msg_id_label_id_98060205_uniq",
                ),
            ],
            state_operations=[
                migrations.CreateModel(
                    name="MsgLabel",
                    fields=[
                        ("id", models.BigAutoField(primary_key=True, serialize=False)),
                        (
                            "msg",
                            models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="msgs.msg"),
                        ),
                        (
                            "label",
                            models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="msgs.label"),
                        ),
                    ],
                    options={
                        "db_table": "msgs_msg_labels",
                        "constraints": [
                            models.UniqueConstraint(fields=("msg", "label"), name="unique_msg_labels"),
                        ],
                    },
                ),
                migrations.AlterField(
                    model_name="msg",
                    name="labels",
                    field=models.ManyToManyField(related_name="msgs", through="msgs.MsgLabel", to="msgs.label"),
                ),
            ],
        ),
        migrations.AddField(
            model_name="msglabel",
            name="msg_uuid",
            field=models.UUIDField(null=True),
        ),
    ]
