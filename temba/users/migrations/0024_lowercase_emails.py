from django.db import migrations
from django.db.models.functions import Lower


def lowercase_emails(apps, schema_editor):
    User = apps.get_model("users", "User")

    num_updated = User.objects.exclude(email=Lower("email")).update(email=Lower("email"))
    if num_updated:
        print(f"Lowercased emails of {num_updated} users")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    lowercase_emails(apps, None)


class Migration(migrations.Migration):
    dependencies = [
        ("users", "0023_reset_dropped_languages"),
    ]

    operations = [
        migrations.RunPython(lowercase_emails, migrations.RunPython.noop),
    ]
