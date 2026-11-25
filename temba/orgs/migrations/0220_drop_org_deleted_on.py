from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("orgs", "0219_org_purged_on")]

    operations = [
        # catches workspaces purged by the previous release while this one was being deployed
        migrations.RunSQL(
            "UPDATE orgs_org SET purged_on = deleted_on WHERE purged_on IS NULL AND deleted_on IS NOT NULL"
        ),
        migrations.RunSQL("ALTER TABLE orgs_org DROP COLUMN deleted_on"),
    ]
