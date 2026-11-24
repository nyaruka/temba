from django.db import migrations

# runs by status are counted by flow tallies, so stop also counting them as flow activity counts, which leaves the
# update and delete triggers with nothing to do
SQL = """
DROP TRIGGER temba_flowrun_on_delete ON flows_flowrun;
DROP FUNCTION temba_flowrun_on_delete();

DROP TRIGGER temba_flowrun_on_update ON flows_flowrun;
DROP FUNCTION temba_flowrun_on_update();

----------------------------------------------------------------------
-- Handles INSERT statements on flowrun table
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION temba_flowrun_on_insert() RETURNS TRIGGER AS $$
BEGIN
    -- add start counts for all new start values
    INSERT INTO flows_flowstartcount("start_id", "count", "is_squashed")
    SELECT start_id, count(*), FALSE FROM newtab WHERE start_id IS NOT NULL GROUP BY start_id;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("flows", "0424_backfill_status_tallies"),  # which takes the counts this stops writing as its source
    ]

    operations = [
        migrations.RunSQL(SQL, migrations.RunSQL.noop),
    ]
