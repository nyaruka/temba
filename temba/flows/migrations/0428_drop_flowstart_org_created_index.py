from django.contrib.postgres.operations import RemoveIndexConcurrently
from django.db import migrations


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("flows", "0427_drop_redundant_fk_indexes"),
    ]

    operations = [
        RemoveIndexConcurrently(model_name="flowstart", name="flows_flowstarts_org_created"),
    ]
