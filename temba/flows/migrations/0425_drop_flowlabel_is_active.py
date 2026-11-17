from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("flows", "0424_remove_flowlabel_is_active"),
    ]

    # is_active was already removed from the model state by 0424_remove_flowlabel_is_active
    operations = [migrations.RunSQL("ALTER TABLE flows_flowlabel DROP COLUMN is_active", migrations.RunSQL.noop)]
