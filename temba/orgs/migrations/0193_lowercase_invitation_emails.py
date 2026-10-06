from django.db import migrations
from django.db.models.functions import Lower


def lowercase_invitation_emails(apps, schema_editor):
    Invitation = apps.get_model("orgs", "Invitation")

    num_updated = Invitation.objects.exclude(email=Lower("email")).update(email=Lower("email"))
    if num_updated:
        print(f"Lowercased emails of {num_updated} invitations")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    lowercase_invitation_emails(apps, None)


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0192_remove_unused_audit_fields"),
    ]

    operations = [
        migrations.RunPython(lowercase_invitation_emails, migrations.RunPython.noop),
    ]
