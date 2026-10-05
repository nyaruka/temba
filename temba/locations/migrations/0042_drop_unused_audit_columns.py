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
            reverse_sql="""
            ALTER TABLE locations_boundaryalias ADD COLUMN modified_by_id integer NULL REFERENCES users_user (id) DEFERRABLE INITIALLY DEFERRED;
            ALTER TABLE locations_boundaryalias ADD COLUMN modified_on timestamp with time zone NULL;
            ALTER TABLE locations_boundaryalias ADD COLUMN is_active boolean NOT NULL DEFAULT TRUE;
            """,
        ),
    ]
