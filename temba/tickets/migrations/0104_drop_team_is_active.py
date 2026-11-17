from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("tickets", "0103_team_deleted_on"),
    ]

    # is_active was already removed from the model state by 0103_team_deleted_on, but teams released by the code it
    # replaced while it was deploying only cleared is_active, so they get deleted_on here
    operations = [
        migrations.RunSQL(
            """
            UPDATE tickets_team SET deleted_on = modified_on WHERE NOT is_active AND deleted_on IS NULL;
            ALTER TABLE tickets_team DROP COLUMN is_active;
            """,
            migrations.RunSQL.noop,
        )
    ]
