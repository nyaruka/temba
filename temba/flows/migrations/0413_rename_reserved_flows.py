from django.db import migrations
from django.db.models.functions import Lower

RESERVED_NAMES = ("ticket",)


def rename_reserved_flows(apps, schema_editor):  # pragma: no cover
    Flow = apps.get_model("flows", "Flow")

    num_renamed = 0

    for flow in Flow.objects.annotate(lower_name=Lower("name")).filter(lower_name__in=RESERVED_NAMES, is_active=True):
        # names are unique per org regardless of is_active
        count = 2
        while Flow.objects.filter(org_id=flow.org_id, name__iexact=f"{flow.name} {count}").exists():
            count += 1

        flow.name = f"{flow.name} {count}"
        flow.save(update_fields=("name",))
        num_renamed += 1

    if num_renamed:
        print(f"Renamed {num_renamed} flows with reserved names")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    rename_reserved_flows(apps, None)


class Migration(migrations.Migration):
    dependencies = [
        ("flows", "0412_audit_fields_cleanup"),
    ]

    operations = [
        migrations.RunPython(rename_reserved_flows, migrations.RunPython.noop),
    ]
