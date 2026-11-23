from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("orgs", "0215_flagged_status_reason")]

    # the column records which workspaces were flagged before 0215 moved flags to top-level workspaces, so it's kept
    # until that can be undone - this only puts it back where an earlier version of this migration dropped it
    operations = [
        migrations.RunSQL(
            "ALTER TABLE orgs_org ADD COLUMN IF NOT EXISTS is_flagged boolean NOT NULL DEFAULT FALSE;",
            migrations.RunSQL.noop,
        ),
    ]
