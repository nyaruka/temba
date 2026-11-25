import io
from contextlib import redirect_stdout

from django.db import DatabaseError, connection, transaction
from django.db.models import F, Value

from temba.contacts.models import Contact
from temba.orgs.models import Org
from temba.tests import TembaTest

from .functions import SplitPart
from .operations import drop_column_index


class FunctionsTest(TembaTest):
    def test_split_part(self):
        self.org.counts.create(scope="foo:bar:baz", count=2)

        count1 = self.org.counts.annotate(
            part1=SplitPart(F("scope"), Value(":"), Value(1)), part2=SplitPart(F("scope"), Value(":"), Value(2))
        ).get()

        self.assertEqual(count1.part1, "foo")
        self.assertEqual(count1.part2, "bar")


class OperationsTest(TembaTest):
    def test_drop_column_index(self):
        def indexes() -> set[str]:
            with connection.cursor() as cursor:
                cursor.execute("SELECT indexname FROM pg_indexes WHERE tablename = 'ivr_call'")
                return {r[0] for r in cursor.fetchall()}

        # an index named as older migrations named them, and a partial one on the same column which should be kept
        with connection.cursor() as cursor:
            cursor.execute('CREATE INDEX "ivr_call_org_id" ON ivr_call (org_id)')
            cursor.execute("""CREATE INDEX "calls_queued" ON ivr_call (org_id) WHERE status = 'Q'""")

        before = indexes()
        op = drop_column_index("ivr_call", "org_id", "ivr_call_org_id_f05ab39d")

        with connection.schema_editor() as editor:
            op.code(None, editor)

        self.assertEqual(before - {"ivr_call_org_id"}, indexes())

        # running it again finds nothing to drop, which it says
        out = io.StringIO()
        with connection.schema_editor() as editor, redirect_stdout(out):
            op.code(None, editor)

        self.assertEqual("No index found on ivr_call.org_id to drop\n", out.getvalue())

        with connection.schema_editor() as editor:
            op.reverse_code(None, editor)

        self.assertEqual(before - {"ivr_call_org_id"} | {"ivr_call_org_id_f05ab39d"}, indexes())


class SchemaTest(TembaTest):
    # foreign keys knowingly left without an index, as they reference users or orgs, which are rarely hard deleted
    UNINDEXED_FKS = {
        "contacts_contact.created_by_id",
        "contacts_contact.modified_by_id",
        "contacts_contactfire.org_id",
        "msgs_msg.created_by_id",
    }

    def test_foreign_keys_indexed(self):
        """
        Deleting a referenced row looks up the rows referencing it, which is a table scan unless a valid, non-partial
        btree index leads with the foreign key column. One where it's a later column doesn't count, as a skip scan of it
        does one descent per distinct leading value.
        """
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT c.conrelid::regclass::text, a.attname
                  FROM pg_constraint c
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
                 WHERE c.contype = 'f' AND cardinality(c.conkey) = 1
                   AND NOT EXISTS (
                       SELECT 1 FROM pg_index i
                         JOIN pg_class ic ON ic.oid = i.indexrelid
                         JOIN pg_am am ON am.oid = ic.relam
                        WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1] AND i.indpred IS NULL
                          AND i.indisvalid AND am.amname = 'btree'
                   )
                """
            )
            unindexed = {f"{table}.{column}" for table, column in cursor.fetchall()}

        self.assertEqual(self.UNINDEXED_FKS, unindexed)


class ReadonlyRouterTest(TembaTest):
    def test_relations_and_writes(self):
        # the readonly connection is outside the test's transaction so can't see its rows, hence faking where this
        # contact was read from
        contact = Contact.objects.get(id=self.create_contact("Bob", phone="+16055741111").id)
        contact._state.db = "readonly"

        # instances from readonly and default can be related
        contact.org = Org.objects.get(id=self.org.id)

        # but writing through readonly, including saving an instance read from it, fails as it would on a replica
        contact.name = "Robert"
        with self.assertRaisesRegex(DatabaseError, "read-only transaction"):
            with transaction.atomic(using="readonly"):
                contact.save(update_fields=("name",))

        with self.assertRaisesRegex(DatabaseError, "read-only transaction"):
            with transaction.atomic(using="readonly"):
                Contact.objects.using("readonly").filter(id=contact.id).update(name="Bobby")

        self.assertEqual("Bob", Contact.objects.get(id=contact.id).name)
