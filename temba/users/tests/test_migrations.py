from temba.tests import MigrationTest
from temba.users.models import User


class ResetDroppedLanguagesTest(MigrationTest):
    app = "users"
    migrate_from = "0021_user_settings"
    migrate_to = "0023_reset_dropped_languages"

    def setUpBeforeMigration(self, apps):
        # self.admin keeps a still supported language and should be untouched
        User.objects.filter(id=self.admin.id).update(language="pt-br")
        User.objects.filter(id=self.editor.id).update(language="ru")
        User.objects.filter(id=self.agent.id).update(language="mn")

    def test_migration(self):
        self.admin.refresh_from_db()
        self.editor.refresh_from_db()
        self.agent.refresh_from_db()

        self.assertEqual("pt-br", self.admin.language)
        self.assertEqual("en-us", self.editor.language)
        self.assertEqual("en-us", self.agent.language)


class LowercaseEmailsTest(MigrationTest):
    app = "users"
    migrate_from = "0023_reset_dropped_languages"
    migrate_to = "0024_lowercase_emails"

    def setUpBeforeMigration(self, apps):
        User.objects.filter(id=self.editor.id).update(email="Editor@NYARUKA.com")

    def test_migration(self):
        self.admin.refresh_from_db()
        self.editor.refresh_from_db()

        self.assertEqual("admin@textit.com", self.admin.email)
        self.assertEqual("editor@nyaruka.com", self.editor.email)
