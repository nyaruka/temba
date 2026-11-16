from django.db import migrations
from django.db.models import F, Func, Value


def grant_shared_email(apps, schema_editor):  # pragma: no cover
    Org = apps.get_model("orgs", "Org")

    # existing workspaces which rely on the shared email service, i.e. have no SMTP settings of their own or from their
    # parent, keep it
    num_updated = (
        Org.objects.filter(is_active=True, flow_smtp=None)
        .exclude(parent__flow_smtp__isnull=False)
        .exclude(features__contains=["shared_email"])
        .update(features=Func(F("features"), Value("shared_email"), function="array_append"))
    )

    if num_updated:
        print(f"Granted shared_email to {num_updated} workspaces")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    grant_shared_email(apps, None)


class Migration(migrations.Migration):
    dependencies = [("orgs", "0201_drop_tally")]

    operations = [migrations.RunPython(grant_shared_email, migrations.RunPython.noop)]
