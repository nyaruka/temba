from django.db import migrations

COLUMN_INDEXES_SQL = """
SELECT ic.relname
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_am am ON am.oid = ic.relam
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
 WHERE t.relname = %s AND pg_table_is_visible(t.oid) AND a.attname = %s
   AND i.indnatts = 1 AND NOT i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname = 'btree'
"""


def drop_column_index(table: str, column: str, name: str) -> migrations.RunPython:
    """
    Drops the plain btree index on just the given column. It's found by its definition rather than by name, as older
    migrations named such indexes differently, so databases created before and after them disagree. The drop is
    concurrent so as not to block writes while waiting for its lock, unless it's run in a transaction, as it is in
    tests. The reverse recreates the index with the given name, and isn't concurrent.
    """

    def forwards(apps, schema_editor):
        conn = schema_editor.connection
        concurrently = "" if conn.in_atomic_block else " CONCURRENTLY"

        with conn.cursor() as cursor:
            cursor.execute(COLUMN_INDEXES_SQL, [table, column])
            indexes = [r[0] for r in cursor.fetchall()]

            for index in indexes:
                cursor.execute(f"DROP INDEX{concurrently} IF EXISTS {schema_editor.quote_name(index)}")

        if not indexes:
            print(f"No index found on {table}.{column} to drop")

    def reverse(apps, schema_editor):
        q = schema_editor.quote_name
        schema_editor.execute(f"CREATE INDEX IF NOT EXISTS {q(name)} ON {q(table)} ({q(column)})")

    return migrations.RunPython(forwards, reverse, atomic=False)
