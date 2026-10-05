from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0192_remove_unused_audit_fields"),
    ]

    # these columns were already removed from the model state by 0192_remove_unused_audit_fields
    operations = [
        migrations.RunSQL(
            """
            ALTER TABLE orgs_orgimport DROP COLUMN modified_by_id;
            ALTER TABLE orgs_orgimport DROP COLUMN is_active;
            """,
            reverse_sql="""
            ALTER TABLE orgs_orgimport ADD COLUMN modified_by_id integer NULL REFERENCES users_user (id) DEFERRABLE INITIALLY DEFERRED;
            ALTER TABLE orgs_orgimport ADD COLUMN is_active boolean NOT NULL DEFAULT TRUE;
            """,
        ),
    ]
