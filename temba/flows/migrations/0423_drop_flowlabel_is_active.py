from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("flows", "0422_flowlabel_deleted_on"),
    ]

    # is_active was already removed from the model state by 0422_flowlabel_deleted_on
    operations = [
        migrations.RunSQL(
            """ALTER TABLE flows_flowlabel DROP COLUMN is_active""",
            migrations.RunSQL.noop,
        )
    ]
