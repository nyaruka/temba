from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0055_apitoken_deleted_on"),
    ]

    # tokens revoked by the code 0055_apitoken_deleted_on replaced, while it was deploying, only cleared is_active
    operations = [
        migrations.RunSQL(
            "UPDATE api_apitoken SET deleted_on = COALESCE(last_used_on, NOW()) WHERE NOT is_active AND deleted_on IS NULL",
            migrations.RunSQL.noop,
        ),
    ]
