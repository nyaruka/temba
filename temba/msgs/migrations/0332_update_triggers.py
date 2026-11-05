from django.db import migrations

# channel message totals are now tallied by the services that create messages, so stop writing channel counts
SQL = """
----------------------------------------------------------------------
-- Handles INSERT statements on msg table
----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION temba_msg_on_insert() RETURNS TRIGGER AS $$
BEGIN
    -- add broadcast counts for all new broadcast values
    INSERT INTO msgs_broadcastmsgcount("broadcast_id", "count", "is_squashed")
    SELECT broadcast_id, count(*), FALSE FROM newtab WHERE broadcast_id IS NOT NULL GROUP BY broadcast_id;

    -- add positive item counts for all rows which belong to a folder
    INSERT INTO orgs_itemcount("org_id", "scope", "count", "is_squashed")
    SELECT org_id, temba_msg_countscope(newtab), count(*), FALSE FROM newtab
    WHERE temba_msg_countscope(newtab) IS NOT NULL
    GROUP BY 1, 2;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION temba_msg_channel_countscope(msgs_msg);
"""


class Migration(migrations.Migration):
    dependencies = [
        ("msgs", "0331_unsquashed_count_indexes"),
    ]

    operations = [
        migrations.RunSQL(SQL, migrations.RunSQL.noop),
    ]
