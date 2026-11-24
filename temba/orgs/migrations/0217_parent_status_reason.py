from django.db import migrations, models

# children sharing their parent's billing or limits restriction or suspension get their own reason for it
BACKFILL_SQL = """
UPDATE orgs_org SET status_reason = 'P', modified_on = NOW()
WHERE parent_id IS NOT NULL AND status != 'A' AND status_reason IN ('B', 'L');
"""


class Migration(migrations.Migration):
    dependencies = [("orgs", "0216_per_workspace_status")]

    operations = [
        migrations.AlterField(
            model_name="org",
            name="status_reason",
            field=models.CharField(
                choices=[("B", "Billing"), ("L", "Limits"), ("S", "Staff"), ("F", "Flagged"), ("P", "Parent")],
                max_length=1,
                null=True,
            ),
        ),
        migrations.RunSQL(BACKFILL_SQL, migrations.RunSQL.noop),
    ]
