from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0193_lowercase_invitation_emails"),
    ]

    # these columns were already removed from the model state by 0192_remove_unused_audit_fields
    operations = [
        migrations.RunSQL(
            """
            ALTER TABLE orgs_orgimport DROP COLUMN modified_by_id;
            ALTER TABLE orgs_orgimport DROP COLUMN is_active;
            """,
            migrations.RunSQL.noop,
        ),
    ]
