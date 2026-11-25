# Generated for classifiers app removal

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("classifiers", "0017_squashed"),
        ("flows", "0403_remove_flow_classifier_dependencies"),
    ]

    operations = [
        migrations.DeleteModel(name="Intent"),
        migrations.DeleteModel(name="Classifier"),
    ]
