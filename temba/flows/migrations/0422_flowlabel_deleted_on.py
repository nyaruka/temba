from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("flows", "0421_update_triggers"),
    ]

    # is_active is only removed from the model state here, with its column given a database default so that the code
    # from the previous release can still insert rows - a later migration drops the column
    operations = [
        migrations.AddField(model_name="flowlabel", name="deleted_on", field=models.DateTimeField(null=True)),
        migrations.RunSQL(
            "UPDATE flows_flowlabel SET deleted_on = modified_on WHERE NOT is_active",
            migrations.RunSQL.noop,
        ),
        migrations.SeparateDatabaseAndState(
            state_operations=[migrations.RemoveField(model_name="flowlabel", name="is_active")],
            database_operations=[
                migrations.RunSQL(
                    "ALTER TABLE flows_flowlabel ALTER COLUMN is_active SET DEFAULT TRUE",
                    reverse_sql="ALTER TABLE flows_flowlabel ALTER COLUMN is_active DROP DEFAULT",
                )
            ],
        ),
    ]
