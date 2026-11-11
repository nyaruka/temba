from django.db import migrations

# incoming messages handled by flows are counted by flow tallies, so stop also counting them as flow activity counts
SQL = """
----------------------------------------------------------------------
-- Handles UPDATE statements on msg table
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION temba_msg_on_update() RETURNS TRIGGER AS $$
BEGIN
    -- add negative item counts for all rows that belonged to a folder they no longer belong to
    INSERT INTO orgs_itemcount("org_id", "scope", "count", "is_squashed")
    SELECT o.org_id, temba_msg_countscope(o), -count(*), FALSE FROM oldtab o
    INNER JOIN newtab n ON n.id = o.id
    WHERE temba_msg_countscope(o) IS DISTINCT FROM temba_msg_countscope(n) AND temba_msg_countscope(o) IS NOT NULL
    GROUP BY 1, 2;

    -- add positive item counts for all rows that now belong to a folder they didn't belong to
    INSERT INTO orgs_itemcount("org_id", "scope", "count", "is_squashed")
    SELECT n.org_id, temba_msg_countscope(n), count(*), FALSE FROM newtab n
    INNER JOIN oldtab o ON o.id = n.id
    WHERE temba_msg_countscope(o) IS DISTINCT FROM temba_msg_countscope(n) AND temba_msg_countscope(n) IS NOT NULL
    GROUP BY 1, 2;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("flows", "0418_backfill_flow_tallies"),  # which takes the counts this stops writing as its source
        ("msgs", "0332_update_triggers"),
    ]

    operations = [
        migrations.RunSQL(SQL, migrations.RunSQL.noop),
    ]
