from decimal import Decimal

from temba.tests import TembaTest, cleanup
from temba.utils import dynamo


class DynamoTest(TembaTest):
    @cleanup(dynamodb=True)
    def test_number_deserialization_monkey_patch(self):
        dynamo.MAIN.put_item(
            Item={"PK": "foo#3", "SK": "bar#100", "BigNum": Decimal("1234567891234560000000000000000000000000")}
        )

        item = dynamo.MAIN.get_item(Key={"PK": "foo#3", "SK": "bar#100"})
        self.assertEqual(Decimal("1234567891234560000000000000000000000000"), item["Item"]["BigNum"])

    def test_get_client(self):
        client1 = dynamo.get_client()
        client2 = dynamo.get_client()
        self.assertIs(client1, client2)

        self.assertEqual("TestMain", dynamo.MAIN.name)
        self.assertEqual("TestHistory", dynamo.HISTORY.name)

    def test_jsongz(self):
        data = dynamo.dump_jsongz({"foo": "barbarbarbarbarbarbarbarbarbarbarbarbarbarbarbar"})
        self.assertEqual(36, len(data))
        self.assertEqual({"foo": "barbarbarbarbarbarbarbarbarbarbarbarbarbarbarbar"}, dynamo.load_jsongz(data))

    @cleanup(dynamodb=True)
    def test_batch_get(self):
        dynamo.MAIN.put_item(Item={"PK": "foo#3", "SK": "bar#100", "OrgID": Decimal(1), "Data": {}})
        dynamo.MAIN.put_item(Item={"PK": "foo#1", "SK": "bar#101", "OrgID": Decimal(1), "Data": {}})
        dynamo.MAIN.put_item(Item={"PK": "foo#2", "SK": "bar#102", "OrgID": Decimal(1), "Data": {}})

        self.assertEqual([], dynamo.batch_get(dynamo.MAIN, []))

        items = dynamo.batch_get(dynamo.MAIN, [("foo#1", "bar#101"), ("foo#3", "bar#100")])
        self.assertEqual(
            [
                {"PK": "foo#1", "SK": "bar#101", "OrgID": Decimal(1), "Data": {}},
                {"PK": "foo#3", "SK": "bar#100", "OrgID": Decimal(1), "Data": {}},
            ],
            items,
        )

    @cleanup(dynamodb=True)
    def test_delete_partition(self):
        self.assertEqual(0, dynamo.delete_partition(dynamo.HISTORY, "foo#1"))

        with dynamo.HISTORY.batch_writer() as batch:
            for x in range(100):
                batch.put_item(Item={"PK": "foo#1", "SK": f"bar#{x:03}", "OrgID": Decimal(1), "Data": {}})
                batch.put_item(Item={"PK": "foo#2", "SK": f"bar#{x:03}", "OrgID": Decimal(1), "Data": {}})
                batch.put_item(Item={"PK": "foo#3", "SK": f"bar#{x:03}", "OrgID": Decimal(1), "Data": {}})

        self.assertEqual(100, dynamo.delete_partition(dynamo.HISTORY, "foo#2"))

        items = dynamo.batch_get(dynamo.HISTORY, [("foo#1", "bar#050"), ("foo#2", "bar#050"), ("foo#3", "bar#050")])
        self.assertEqual(
            [
                {"PK": "foo#1", "SK": "bar#050", "OrgID": Decimal(1), "Data": {}},
                {"PK": "foo#3", "SK": "bar#050", "OrgID": Decimal(1), "Data": {}},
            ],
            items,
        )

        self.assertEqual(100, dynamo.delete_partition(dynamo.HISTORY, "foo#3"))

        items = dynamo.batch_get(dynamo.HISTORY, [("foo#1", "bar#050"), ("foo#2", "bar#050"), ("foo#3", "bar#050")])
        self.assertEqual(
            [
                {"PK": "foo#1", "SK": "bar#050", "OrgID": Decimal(1), "Data": {}},
            ],
            items,
        )

    @cleanup(dynamodb=True)
    def test_merged_page_query(self):
        # insert 10 items across 3 partition keys
        items = [
            {"PK": "foo#3", "SK": "bar#100", "OrgID": Decimal(1), "Data": {}},
            {"PK": "foo#1", "SK": "bar#101", "OrgID": Decimal(1), "Data": {}},
            {"PK": "foo#2", "SK": "bar#102", "OrgID": Decimal(1), "Data": {}},
            {"PK": "foo#2", "SK": "bar#103", "OrgID": Decimal(1), "Data": {}},
            {"PK": "foo#1", "SK": "bar#104", "OrgID": Decimal(1), "Data": {}},
            {"PK": "foo#1", "SK": "bar#105", "OrgID": Decimal(1), "Data": {}},
            {"PK": "foo#2", "SK": "bar#106", "OrgID": Decimal(1), "Data": {}},
            {"PK": "foo#2", "SK": "bar#107", "OrgID": Decimal(1), "Data": {}},
            {"PK": "foo#3", "SK": "bar#108", "OrgID": Decimal(1), "Data": {}},
            {"PK": "foo#3", "SK": "bar#109", "OrgID": Decimal(1), "Data": {}},
        ]
        with dynamo.MAIN.batch_writer() as batch:
            for item in items:
                batch.put_item(Item=item)

        pks = ["foo#1", "foo#2", "foo#3", "foo#4"]

        page, prev_after_sk, next_after_sk = dynamo.merged_page_query(dynamo.MAIN, pks, limit=4)
        self.assertEqual([items[0], items[1], items[2], items[3]], page)
        self.assertIsNone(prev_after_sk)  # no prev page
        self.assertEqual("bar#103", next_after_sk)

        page, prev_after_sk, next_after_sk = dynamo.merged_page_query(dynamo.MAIN, pks, limit=4, after_sk=next_after_sk)
        self.assertEqual([items[4], items[5], items[6], items[7]], page)
        self.assertIsNone(prev_after_sk)  # prev page has no after
        self.assertEqual("bar#107", next_after_sk)

        page, prev_after_sk, next_after_sk = dynamo.merged_page_query(dynamo.MAIN, pks, limit=4, after_sk=next_after_sk)
        self.assertEqual([items[8], items[9]], page)
        self.assertEqual("bar#103", prev_after_sk)
        self.assertIsNone(next_after_sk)  # no next page

        # now do the same queries in reverse order
        page, prev_after_sk, next_after_sk = dynamo.merged_page_query(dynamo.MAIN, pks, desc=True, limit=4)
        self.assertEqual([items[9], items[8], items[7], items[6]], page)
        self.assertIsNone(prev_after_sk)  # no prev page
        self.assertEqual("bar#106", next_after_sk)

        page, prev_after_sk, next_after_sk = dynamo.merged_page_query(
            dynamo.MAIN, pks, desc=True, limit=4, after_sk=next_after_sk
        )
        self.assertEqual([items[5], items[4], items[3], items[2]], page)
        self.assertIsNone(prev_after_sk)  # prev page has no after
        self.assertEqual("bar#102", next_after_sk)

        page, prev_after_sk, next_after_sk = dynamo.merged_page_query(
            dynamo.MAIN, pks, desc=True, limit=4, after_sk=next_after_sk
        )
        self.assertEqual([items[1], items[0]], page)
        self.assertEqual("bar#106", prev_after_sk)
        self.assertIsNone(next_after_sk)  # no next page
