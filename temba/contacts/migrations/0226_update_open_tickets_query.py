from django.db import migrations


def update_open_tickets_query(apps, schema_editor):  # pragma: no cover
    ContactGroup = apps.get_model("contacts", "ContactGroup")

    # both queries match the same contacts so membership doesn't need re-evaluating
    num_updated = ContactGroup.objects.filter(is_system=True, group_type="Q").update(query='ticket = "open"')

    if num_updated:
        print(f"Updated query of {num_updated} open tickets groups")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    update_open_tickets_query(apps, None)


class Migration(migrations.Migration):
    dependencies = [
        ("contacts", "0225_squashed_counts_unique"),
    ]

    operations = [
        migrations.RunPython(update_open_tickets_query, migrations.RunPython.noop),
    ]
