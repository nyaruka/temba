from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("flows", "0423_backfill_flowlabel_deleted_on"),
    ]

    # is_active is only removed from the model state here, with its column given a database default so that code from
    # before and after this can both run against it - a later migration drops the column
    operations = [
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
