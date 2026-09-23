from django.db import migrations

from temba.knowledge.models import derive_color_styles, render_markdown


def keep_article_html_addressless(apps, schema_editor):  # pragma: no cover
    KnowledgeSource = apps.get_model("knowledge", "KnowledgeSource")
    Article = apps.get_model("knowledge", "Article")

    # pages now style columns from what each palette entry looks like, kept alongside the palette
    num_sources = 0
    for source in KnowledgeSource.objects.filter(config__has_key="colors").order_by("id"):
        source.config["color_styles"] = derive_color_styles(source.config["colors"])
        source.save(update_fields=("config",))
        num_sources += 1

    # and published articles are kept with palette indexes and storage keys rather than colors and addresses. Updated
    # rather than saved so modified_on stays put and nothing looks stale to the indexer.
    num_articles = 0
    for article in Article.objects.filter(status="P").order_by("id").iterator():
        html, headings = render_markdown(article.body)
        Article.objects.filter(id=article.id).update(body_html=html, headings=[h._asdict() for h in headings])
        num_articles += 1

    print(f"Updated color styles for {num_sources} sources and rendered {num_articles} published articles")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    keep_article_html_addressless(apps, None)


class Migration(migrations.Migration):
    dependencies = [
        ("knowledge", "0009_backfill_article_html"),
    ]

    operations = [
        migrations.RunPython(keep_article_html_addressless, migrations.RunPython.noop),
    ]
