from django.db import migrations
from django.db.models import F


def backfill_deleted_on(apps, schema_editor):  # pragma: no cover
    Team = apps.get_model("tickets", "Team")

    num_updated = Team.objects.filter(is_active=False, deleted_on=None).update(deleted_on=F("modified_on"))
    if num_updated:
        print(f"Set deleted_on on {num_updated} teams")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_deleted_on(apps, None)


class Migration(migrations.Migration):
    dependencies = [
        ("tickets", "0103_team_deleted_on"),
    ]

    operations = [
        migrations.RunPython(backfill_deleted_on, migrations.RunPython.noop),
    ]
