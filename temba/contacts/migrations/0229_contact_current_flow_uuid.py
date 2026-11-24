from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("contacts", "0228_drop_contact_ticket_count"),
    ]

    operations = [
        migrations.AddField(
            model_name="contact",
            name="current_flow_uuid",
            field=models.UUIDField(null=True),
        ),
    ]
