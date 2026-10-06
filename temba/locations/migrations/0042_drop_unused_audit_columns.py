from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("locations", "0041_remove_unused_audit_fields"),
    ]

    # these columns were already removed from the model state by 0041_remove_unused_audit_fields
    operations = [
        migrations.RunSQL(
            """
            ALTER TABLE locations_boundaryalias DROP COLUMN modified_by_id;
            ALTER TABLE locations_boundaryalias DROP COLUMN modified_on;
            ALTER TABLE locations_boundaryalias DROP COLUMN is_active;
            """,
            migrations.RunSQL.noop,
        ),
    ]
