import django.contrib.postgres.indexes
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("ai", "0010_backfill_llm_max_output_tokens"),
    ]

    operations = [
        migrations.CreateModel(
            name="LLMCount",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ("count", models.BigIntegerField()),
                ("is_squashed", models.BooleanField(default=False)),
                ("scope", models.CharField(max_length=128)),
                ("day", models.DateField()),
                (
                    "llm",
                    models.ForeignKey(
                        db_index=False,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="counts",
                        to="ai.llm",
                    ),
                ),
            ],
        ),
        migrations.AddIndex(
            model_name="llmcount",
            index=models.Index(
                models.F("llm"),
                models.F("day"),
                django.contrib.postgres.indexes.OpClass("scope", name="varchar_pattern_ops"),
                name="llmcount_llm_scope",
            ),
        ),
        migrations.AddIndex(
            model_name="llmcount",
            index=models.Index(
                condition=models.Q(("is_squashed", False)),
                fields=["llm", "day", "scope"],
                name="llmcount_unsquashed",
            ),
        ),
    ]
