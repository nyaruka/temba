from django.db import migrations

# daily scopes used to end with /<date> before switching to @<date>
OLD_DAILY_SCOPE = r"/\d{4}-\d{2}-\d{2}$"


def delete_slash_daily_tallies(apps, schema_editor):
    Tally = apps.get_model("orgs", "Tally")

    num_deleted, _ = Tally.objects.filter(scope__regex=OLD_DAILY_SCOPE).delete()
    if num_deleted:
        print(f"Deleted {num_deleted} daily tallies with old style scopes")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    delete_slash_daily_tallies(apps, None)


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0197_tallies"),
    ]

    operations = [
        migrations.RunPython(delete_slash_daily_tallies, migrations.RunPython.noop),
    ]
