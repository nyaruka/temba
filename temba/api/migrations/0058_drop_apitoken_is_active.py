from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0057_remove_apitoken_is_active"),
    ]

    # is_active was already removed from the model state by 0057_remove_apitoken_is_active
    operations = [migrations.RunSQL("ALTER TABLE api_apitoken DROP COLUMN is_active", migrations.RunSQL.noop)]
