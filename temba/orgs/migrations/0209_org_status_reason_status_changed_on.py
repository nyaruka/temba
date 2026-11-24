from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0208_remove_org_is_suspended"),
    ]

    operations = [
        migrations.AddField(
            model_name="org",
            name="status_changed_on",
            field=models.DateTimeField(null=True),
        ),
        migrations.AddField(
            model_name="org",
            name="status_reason",
            field=models.CharField(
                choices=[("B", "Billing"), ("L", "Limits"), ("S", "Staff")],
                max_length=1,
                null=True,
            ),
        ),
    ]
