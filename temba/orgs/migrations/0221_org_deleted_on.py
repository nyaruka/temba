from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("orgs", "0220_drop_org_deleted_on")]

    # workspaces released before released_on was recorded fall back to when they were last modified
    operations = [
        migrations.AddField(model_name="org", name="deleted_on", field=models.DateTimeField(null=True)),
        migrations.RunSQL(
            "UPDATE orgs_org SET deleted_on = COALESCE(released_on, modified_on) WHERE NOT is_active",
            migrations.RunSQL.noop,
        ),
    ]
