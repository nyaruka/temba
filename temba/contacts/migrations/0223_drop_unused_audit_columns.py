from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("contacts", "0222_remove_unused_audit_fields"),
    ]

    # these columns were already removed from the model state by 0222_remove_unused_audit_fields
    operations = [
        migrations.RunSQL(
            """
            ALTER TABLE contacts_contactimport DROP COLUMN modified_by_id;
            ALTER TABLE contacts_contactimport DROP COLUMN modified_on;
            ALTER TABLE contacts_contactimport DROP COLUMN is_active;
            """,
            migrations.RunSQL.noop,
        ),
    ]
