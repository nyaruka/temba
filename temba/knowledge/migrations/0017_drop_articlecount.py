from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("knowledge", "0016_backfill_article_tallies"),  # copies article counts into tallies
    ]

    operations = [
        migrations.DeleteModel(name="ArticleCount"),
    ]
