from django.db import migrations

# adds to any tallies already flushed, so views tallied before this runs aren't lost, and gives each the expiry mailroom
# would, which is 90 days after its day
SQL = """
INSERT INTO knowledge_articletally AS t (article_id, scope, count, expires_on)
     SELECT article_id, 'views@' || to_char(day, 'YYYY-MM-DD'), SUM(count), day + 90
       FROM knowledge_articlecount
      WHERE scope = 'views' AND day + 90 >= CURRENT_DATE
   GROUP BY article_id, day
     HAVING SUM(count) != 0
ON CONFLICT (article_id, scope) DO UPDATE SET count = t.count + excluded.count, expires_on = excluded.expires_on
"""


def backfill_article_tallies(apps, schema_editor):
    schema_editor.execute(SQL)


class Migration(migrations.Migration):
    dependencies = [("knowledge", "0015_articletally")]

    operations = [migrations.RunPython(backfill_article_tallies, migrations.RunPython.noop)]
