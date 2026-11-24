from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("contacts", "0231_remove_contact_current_flow"),
    ]

    operations = [
        migrations.RunSQL(
            "ALTER TABLE contacts_contact DROP COLUMN current_flow_id",
            # lets MigrationTests reverse past this, since earlier migrations need the column back
            "ALTER TABLE contacts_contact ADD COLUMN current_flow_id integer NULL",
        ),
    ]
