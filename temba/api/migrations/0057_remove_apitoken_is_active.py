from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0056_backfill_apitoken_deleted_on"),
    ]

    # is_active is only removed from the model state here, with its column given a database default so that this
    # release's code, which no longer sets it, can still insert rows - a later migration drops the column
    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[migrations.RemoveField(model_name="apitoken", name="is_active")],
            database_operations=[
                migrations.RunSQL(
                    "ALTER TABLE api_apitoken ALTER COLUMN is_active SET DEFAULT TRUE",
                    migrations.RunSQL.noop,
                )
            ],
        ),
    ]
