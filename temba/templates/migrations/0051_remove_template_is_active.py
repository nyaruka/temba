from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("templates", "0050_audit_fields_cleanup"),
    ]

    # templates are deleted rather than deactivated so is_active is always true. It's only removed from the model
    # state here, with the column given a database default so that code from before and after this can both insert
    # templates - a later migration drops the column.
    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[migrations.RemoveField(model_name="template", name="is_active")],
            database_operations=[
                migrations.RunSQL("ALTER TABLE templates_template ALTER COLUMN is_active SET DEFAULT TRUE"),
            ],
        ),
    ]
