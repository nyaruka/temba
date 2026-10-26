from django.db import migrations
from django.utils import timezone


def release_chip_channels(apps, schema_editor):  # pragma: no cover
    Channel = apps.get_model("channels", "Channel")
    Trigger = apps.get_model("triggers", "Trigger")
    Incident = apps.get_model("notifications", "Incident")

    channels = list(Channel.objects.filter(channel_type="CHP", is_active=True))

    # archive and release any triggers for these channels
    num_triggers = Trigger.objects.filter(channel__in=channels, is_active=True).update(
        is_active=False, is_archived=True, modified_on=timezone.now()
    )

    # end any open incidents for these channels
    num_incidents = Incident.objects.filter(channel__in=channels, ended_on=None).update(ended_on=timezone.now())

    # finally make the channels themselves inactive - note that unlike Channel.release we don't try to deactivate them
    # with the provider, or interrupt sessions on them via mailroom
    num_channels = Channel.objects.filter(id__in=[c.id for c in channels]).update(
        is_active=False, modified_on=timezone.now()
    )

    if num_channels:
        print(f"Released {num_channels} chip channels ({num_triggers} triggers, {num_incidents} incidents)")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    release_chip_channels(apps, None)


class Migration(migrations.Migration):
    dependencies = [
        ("channels", "0215_release_legacy_whatsapp_channels"),
        ("notifications", "0035_squashed"),
        ("triggers", "0049_alter_trigger_uuid"),
    ]

    operations = [
        migrations.RunPython(release_chip_channels, migrations.RunPython.noop),
    ]
