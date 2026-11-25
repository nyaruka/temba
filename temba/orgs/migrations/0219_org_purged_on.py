from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("orgs", "0218_drop_org_is_flagged")]

    # deleted_on is only removed from the model state here, so that the code from the previous release can still load
    # orgs - a later migration drops the column
    operations = [
        migrations.AddField(model_name="org", name="purged_on", field=models.DateTimeField(null=True)),
        migrations.RunSQL(
            "UPDATE orgs_org SET purged_on = deleted_on WHERE deleted_on IS NOT NULL",
            migrations.RunSQL.noop,
        ),
        migrations.SeparateDatabaseAndState(
            state_operations=[migrations.RemoveField(model_name="org", name="deleted_on")]
        ),
    ]
