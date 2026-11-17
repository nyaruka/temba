from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("tickets", "0105_remove_team_is_active"),
    ]

    # is_active was already removed from the model state by 0105_remove_team_is_active
    operations = [migrations.RunSQL("ALTER TABLE tickets_team DROP COLUMN is_active", migrations.RunSQL.noop)]
