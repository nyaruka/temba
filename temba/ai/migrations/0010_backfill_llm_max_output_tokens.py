import itertools

from django.conf import settings
from django.db import migrations


def backfill_max_output_tokens(apps, schema_editor):  # pragma: no cover
    LLM = apps.get_model("ai", "LLM")

    # slug -> {model_id: max_output_tokens}
    models_by_type = {
        type_path.split(".")[-3]: type_settings.get("models", {})
        for type_path, type_settings in settings.LLM_TYPES.items()
    }

    num_updated = 0
    for batch in itertools.batched(LLM.objects.all().order_by("id"), 100):
        to_update = []
        for llm in batch:
            tokens = models_by_type.get(llm.llm_type, {}).get(llm.model)
            if tokens is not None:
                llm.max_output_tokens = tokens
                to_update.append(llm)
        if to_update:
            LLM.objects.bulk_update(to_update, ["max_output_tokens"])
            num_updated += len(to_update)

    print(f"Updated {num_updated} LLM records with max_output_tokens")


class Migration(migrations.Migration):
    dependencies = [
        ("ai", "0009_llm_max_output_tokens"),
    ]

    operations = [
        migrations.RunPython(backfill_max_output_tokens, migrations.RunPython.noop),
    ]
