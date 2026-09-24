from io import StringIO

from django.conf import settings
from django.core.management import call_command
from django.test.utils import override_settings

from temba.tests import TembaTest
from temba.utils import dynamo, s3

from .create_buckets import BUCKETS


class CreateBucketsTest(TembaTest):
    def setUp(self):
        super().setUp()

        # derived from the test prefix so that runs sharing an S3 service don't collide
        self.prefix = f"{settings.BUCKET_PREFIX}-temp"

    def tearDown(self):
        client = s3.client()

        for bucket in BUCKETS:
            client.delete_bucket(Bucket=f"{self.prefix}-{bucket}")

        return super().tearDown()

    def test_create_buckets(self):
        with override_settings(BUCKET_PREFIX=self.prefix):
            out = StringIO()
            call_command("create_buckets", stdout=out)

            self.assertIn(f"created bucket {self.prefix}-archives", out.getvalue())
            self.assertIn(f"created bucket {self.prefix}-default", out.getvalue())

            out = StringIO()
            call_command("create_buckets", stdout=out)

            self.assertIn(f"Bucket {self.prefix}-archives already exists", out.getvalue())
            self.assertIn(f"Bucket {self.prefix}-default already exists", out.getvalue())


class MigrateDynamoTest(TembaTest):
    def setUp(self):
        super().setUp()

        # derived from the test prefix so that runs sharing a DynamoDB service don't collide
        self.prefix = f"{settings.DYNAMO_TABLE_PREFIX}Temp"

    def tearDown(self):
        client = dynamo.get_client()

        for table in client.tables.all():
            if table.name.startswith(self.prefix):
                # tables may have been created with deletion protection, e.g. by a pre_create_table receiver
                client.meta.client.update_table(TableName=table.name, DeletionProtectionEnabled=False)
                table.delete()

        return super().tearDown()

    def test_migrate_dynamo(self):
        def pre_create_table(sender, spec, **kwargs):
            spec["Tags"] = [{"Key": "Foo", "Value": "Bar"}]

        dynamo.signals.pre_create_table.connect(pre_create_table)

        with override_settings(DYNAMO_TABLE_PREFIX=self.prefix):
            out = StringIO()
            call_command("migrate_dynamo", stdout=out)

            self.assertIn(f"Creating {self.prefix}Main", out.getvalue())
            self.assertIn(f"Creating {self.prefix}History", out.getvalue())
            self.assertIn(f"Creating {self.prefix}Certs", out.getvalue())

            client = dynamo.get_client()
            table = client.Table(f"{self.prefix}Main")
            self.assertEqual("ACTIVE", table.table_status)

            out = StringIO()
            call_command("migrate_dynamo", stdout=out)

            self.assertIn(f"Skipping {self.prefix}Main", out.getvalue())
            self.assertIn(f"Skipping {self.prefix}History", out.getvalue())
            self.assertIn(f"Skipping {self.prefix}Certs", out.getvalue())
