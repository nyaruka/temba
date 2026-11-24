from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0054_audit_fields_cleanup"),
    ]

    # tokens don't record when they were revoked, so last use is the closest stamp there is
    operations = [
        migrations.AddField(model_name="apitoken", name="deleted_on", field=models.DateTimeField(null=True)),
        migrations.RunSQL(
            "UPDATE api_apitoken SET deleted_on = COALESCE(last_used_on, NOW()) WHERE NOT is_active",
            migrations.RunSQL.noop,
        ),
    ]
