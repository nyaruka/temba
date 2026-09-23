from django.db import migrations


class Migration(migrations.Migration):
    # rendered every published article's HTML, which 0010 does again in the form articles are now kept in
    dependencies = [
        ("knowledge", "0008_article_body_html_headings"),
    ]

    operations = []
