from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0211_switch_org_status_fields"),
    ]

    operations = [
        migrations.RunSQL(
            """
            ALTER TABLE orgs_org
                DROP COLUMN is_suspended,
                DROP COLUMN restricted_reason,
                DROP COLUMN suspended_on;
            """,
            # lets MigrationTests reverse past this, since earlier migrations need the columns back
            """
            ALTER TABLE orgs_org
                ADD COLUMN is_suspended boolean NOT NULL DEFAULT FALSE,
                ADD COLUMN restricted_reason varchar(1) NULL,
                ADD COLUMN suspended_on timestamp with time zone NULL;
            """,
        ),
    ]
