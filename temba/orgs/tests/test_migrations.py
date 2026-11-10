from temba.orgs.models import Org
from temba.tests import MigrationTest


class GrantSharedEmailTest(MigrationTest):
    app = "orgs"
    migrate_from = "0201_drop_tally"
    migrate_to = "0202_grant_shared_email"

    def setUpBeforeMigration(self, apps):
        # org with its own SMTP settings
        self.org.flow_smtp = "smtp://bob%40acme.com:secret@example.com/?from=bob%40acme.com&tls=true"
        self.org.save(update_fields=("flow_smtp",))

        # child of that org which uses its parent's SMTP settings
        self.child1 = Org.objects.create(
            name="Child 1", timezone="UTC", parent=self.org, created_by=self.admin, modified_by=self.admin
        )

        # child of an org without SMTP settings, which already has the feature
        self.child2 = Org.objects.create(
            name="Child 2",
            timezone="UTC",
            parent=self.org2,
            features=["shared_email"],
            created_by=self.admin,
            modified_by=self.admin,
        )

        # child of an org without SMTP settings
        self.child3 = Org.objects.create(
            name="Child 3", timezone="UTC", parent=self.org2, created_by=self.admin, modified_by=self.admin
        )

        # inactive org
        self.inactive = Org.objects.create(
            name="Inactive", timezone="UTC", is_active=False, created_by=self.admin, modified_by=self.admin
        )

    def test_migration(self):
        def assert_features(org, expected):
            org.refresh_from_db()
            self.assertEqual(expected, org.features)

        assert_features(self.org, [])
        assert_features(self.child1, [])
        assert_features(self.org2, ["shared_email"])
        assert_features(self.child2, ["shared_email"])
        assert_features(self.child3, ["shared_email"])
        assert_features(self.inactive, [])
