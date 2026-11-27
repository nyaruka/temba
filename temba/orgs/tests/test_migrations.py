from datetime import datetime, timezone as tzone

from temba.orgs.models import Org
from temba.tests import MigrationTest


class BackfillOrgDeletedOnTest(MigrationTest):
    app = "orgs"
    migrate_from = "0220_drop_org_deleted_on"
    migrate_to = "0221_org_deleted_on"

    def setUpBeforeMigration(self, apps):
        OldOrg = apps.get_model("orgs", "Org")

        self.released_on = datetime(2026, 10, 1, 12, 0, tzinfo=tzone.utc)
        self.modified_on = datetime(2026, 9, 1, 12, 0, tzinfo=tzone.utc)

        OldOrg.objects.filter(id=self.org2.id).update(is_active=False, released_on=self.released_on)
        self.org3 = OldOrg.objects.create(
            name="Old Released",
            timezone="UTC",
            flow_languages=["eng"],
            is_active=False,
            created_by_id=self.admin.id,
            modified_by_id=self.admin.id,
        )
        OldOrg.objects.filter(id=self.org3.id).update(modified_on=self.modified_on)

    def test_migration(self):
        self.assertIsNone(Org.objects.get(id=self.org.id).deleted_on)
        self.assertEqual(self.released_on, Org.objects.get(id=self.org2.id).deleted_on)
        self.assertEqual(self.modified_on, Org.objects.get(id=self.org3.id).deleted_on)
