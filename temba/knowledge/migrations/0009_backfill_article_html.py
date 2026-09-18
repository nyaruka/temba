from django.db import migrations

from temba.knowledge.models import render_markdown


def backfill_article_html(apps, schema_editor):  # pragma: no cover
    Article = apps.get_model("knowledge", "Article")

    num_rendered = 0

    # every published article gets the HTML the site serves it from, rendered as saving it published would - with
    # the helpdesk's palette, and links to other articles left for the site to resolve. Updated rather than saved so
    # modified_on stays put and nothing looks stale to the indexer.
    for article in Article.objects.filter(status="P").select_related("source").order_by("id").iterator():
        html, headings = render_markdown(article.body, article.source.config.get("colors", {}))
        Article.objects.filter(id=article.id).update(body_html=html, headings=[h._asdict() for h in headings])
        num_rendered += 1

    print(f"Rendered {num_rendered} published articles")


def apply_manual():  # pragma: no cover
    from django.apps import apps

    backfill_article_html(apps, None)


class Migration(migrations.Migration):
    dependencies = [
        ("knowledge", "0008_article_body_html_headings"),
    ]

    operations = [
        migrations.RunPython(backfill_article_html, migrations.RunPython.noop),
    ]
