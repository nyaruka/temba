from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("locations", "0040_audit_fields_cleanup"),
    ]

    # fields are only removed from the model state here, with their columns made nullable or given a database default
    # so that code from before and after this can both run against them - a later migration drops the columns
    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RemoveField(model_name="boundaryalias", name="is_active"),
                migrations.RemoveField(model_name="boundaryalias", name="modified_by"),
                migrations.RemoveField(model_name="boundaryalias", name="modified_on"),
            ],
            database_operations=[
                migrations.RunSQL(
                    """
                    ALTER TABLE locations_boundaryalias ALTER COLUMN modified_by_id DROP NOT NULL;
                    ALTER TABLE locations_boundaryalias ALTER COLUMN modified_on DROP NOT NULL;
                    ALTER TABLE locations_boundaryalias ALTER COLUMN is_active SET DEFAULT TRUE;
                    """,
                    reverse_sql="""
                    ALTER TABLE locations_boundaryalias ALTER COLUMN is_active DROP DEFAULT;
                    ALTER TABLE locations_boundaryalias ALTER COLUMN modified_on SET NOT NULL;
                    ALTER TABLE locations_boundaryalias ALTER COLUMN modified_by_id SET NOT NULL;
                    """,
                ),
            ],
        ),
    ]
