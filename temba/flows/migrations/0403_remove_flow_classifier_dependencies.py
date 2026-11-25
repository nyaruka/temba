# Generated for classifiers app removal

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("classifiers", "0017_squashed"),
        ("flows", "0402_backfill_flowrevision_changes"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="flow",
            name="classifier_dependencies",
        ),
    ]
