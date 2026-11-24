from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("orgs", "0217_parent_status_reason")]

    operations = [
        migrations.RunSQL(
            "ALTER TABLE orgs_org DROP COLUMN is_flagged;",
            # lets MigrationTests reverse past this, since earlier migrations need the column back
            "ALTER TABLE orgs_org ADD COLUMN is_flagged boolean NOT NULL DEFAULT FALSE;",
        ),
    ]
