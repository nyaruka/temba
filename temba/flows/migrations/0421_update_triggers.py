from django.db import migrations

# runs at each node are counted by flow tallies, so stop also counting them as flow activity counts
SQL = """
----------------------------------------------------------------------
-- Handles DELETE statements on flowrun table
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION temba_flowrun_on_delete() RETURNS TRIGGER AS $$
BEGIN
    -- add negative status counts for any deleted runs which were still active or waiting
    INSERT INTO flows_flowactivitycount("flow_id", "scope", "count", "is_squashed")
    SELECT flow_id, format('status:%s', status), -count(*), FALSE FROM oldtab
    WHERE status IN ('A', 'W') GROUP BY 1, 2;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

----------------------------------------------------------------------
-- Handles INSERT statements on flowrun table
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION temba_flowrun_on_insert() RETURNS TRIGGER AS $$
BEGIN
    -- add status counts for all new status values
    INSERT INTO flows_flowactivitycount("flow_id", "scope", "count", "is_squashed")
    SELECT flow_id, format('status:%s', status), count(*), FALSE FROM newtab GROUP BY 1, 2;

    -- add start counts for all new start values
    INSERT INTO flows_flowstartcount("start_id", "count", "is_squashed")
    SELECT start_id, count(*), FALSE FROM newtab WHERE start_id IS NOT NULL GROUP BY start_id;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

----------------------------------------------------------------------
-- Handles UPDATE statements on flowrun table
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION temba_flowrun_on_update() RETURNS TRIGGER AS $$
BEGIN
    -- add negative status counts for all old status values that don't match the new ones
    INSERT INTO flows_flowactivitycount("flow_id", "scope", "count", "is_squashed")
    SELECT o.flow_id, format('status:%s', o.status), -count(*), FALSE FROM oldtab o
    INNER JOIN newtab n ON n.id = o.id
    WHERE o.status != n.status
    GROUP BY 1, 2;

    -- add status counts for all new status values that don't match the old ones
    INSERT INTO flows_flowactivitycount("flow_id", "scope", "count", "is_squashed")
    SELECT n.flow_id, format('status:%s', n.status), count(*), FALSE FROM newtab n
    INNER JOIN oldtab o ON o.id = n.id
    WHERE o.status != n.status
    GROUP BY 1, 2;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("flows", "0420_backfill_node_tallies"),  # which takes the counts this stops writing as its source
    ]

    operations = [
        migrations.RunSQL(SQL, migrations.RunSQL.noop),
    ]
