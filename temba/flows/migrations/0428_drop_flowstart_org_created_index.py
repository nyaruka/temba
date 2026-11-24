from django.db import migrations


def drop_index(apps, schema_editor):
    # concurrently so as not to block writes, except in tests which migrate inside a transaction
    concurrently = "" if schema_editor.connection.in_atomic_block else " CONCURRENTLY"
    schema_editor.execute(f"DROP INDEX{concurrently} IF EXISTS flows_flowstarts_org_created")


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("flows", "0427_drop_redundant_fk_indexes"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.RunPython(drop_index, migrations.RunPython.noop, atomic=False)],
            state_operations=[migrations.RemoveIndex(model_name="flowstart", name="flows_flowstarts_org_created")],
        )
    ]
