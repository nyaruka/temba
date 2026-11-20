from datetime import datetime, timezone as tzone

from temba.api.models import APIToken
from temba.tests import MigrationTest


class BackfillAPITokenDeletedOnTest(MigrationTest):
    app = "api"
    migrate_from = "0054_audit_fields_cleanup"
    migrate_to = "0055_apitoken_deleted_on"

    def setUpBeforeMigration(self, apps):
        Token = apps.get_model("api", "APIToken")

        self.used_on = datetime(2026, 10, 1, 12, 0, tzinfo=tzone.utc)

        def create(key, is_active, last_used_on=None):
            Token.objects.create(
                key=key, org_id=self.org.id, user_id=self.admin.id, is_active=is_active, last_used_on=last_used_on
            )

        create("live", True, self.used_on)
        create("revoked-used", False, self.used_on)
        create("revoked-unused", False)

    def test_migration(self):
        self.assertIsNone(APIToken.objects.get(key="live").deleted_on)
        self.assertEqual(self.used_on, APIToken.objects.get(key="revoked-used").deleted_on)
        self.assertIsNotNone(APIToken.objects.get(key="revoked-unused").deleted_on)
