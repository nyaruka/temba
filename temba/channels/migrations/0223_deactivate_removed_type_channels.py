from django.db import migrations
from django.utils import timezone

REMOVED_TYPES = ("SC", "NV", "MG", "DK", "H9")


def deactivate_removed_type_channels(apps, schema_editor):  # pragma: no cover
    Channel = apps.get_model("channels", "Channel")
    Trigger = apps.get_model("triggers", "Trigger")

    channels = list(Channel.objects.filter(channel_type__in=REMOVED_TYPES, is_active=True).only("id"))

    # active triggers on a channel of a removed type, even an already inactive one, would have to resolve the
    # channel's type, which no longer exists
    num_triggers = Trigger.objects.filter(channel__channel_type__in=REMOVED_TYPES, is_active=True).update(
        is_active=False, is_archived=True, modified_on=timezone.now()
    )

    num_channels = Channel.objects.filter(id__in=[c.id for c in channels]).update(
        is_active=False, modified_on=timezone.now()
    )

    if num_channels:
        print(f"Deactivated {num_channels} channels of removed types ({num_triggers} triggers)")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    deactivate_removed_type_channels(apps, None)


class Migration(migrations.Migration):
    dependencies = [
        ("channels", "0222_drop_channelcount"),
        ("triggers", "0050_audit_fields_cleanup"),
    ]

    operations = [
        migrations.RunPython(deactivate_removed_type_channels, migrations.RunPython.noop),
    ]
