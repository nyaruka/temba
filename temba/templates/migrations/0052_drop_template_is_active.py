from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("templates", "0051_remove_template_is_active"),
    ]

    # this column was already removed from the model state by 0051_remove_template_is_active, and has to be dropped
    # only once no running code still inserts it
    operations = [
        migrations.RunSQL("ALTER TABLE templates_template DROP COLUMN is_active", migrations.RunSQL.noop),
    ]
