from django.db import migrations, models


def split_engine_role(apps, schema_editor):
    LLM = apps.get_model("ai", "LLM")

    for llm in LLM.objects.filter(roles__contains="F"):
        llm.roles = llm.roles.replace("F", "GC")
        llm.save(update_fields=("roles",))


class Migration(migrations.Migration):
    dependencies = [("ai", "0013_alter_llm_id")]

    operations = [
        migrations.AlterField(model_name="llm", name="roles", field=models.CharField(default="TGC", max_length=3)),
        migrations.RunPython(split_engine_role, migrations.RunPython.noop),
    ]
