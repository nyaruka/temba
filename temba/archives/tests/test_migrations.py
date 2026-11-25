from datetime import date, datetime, timezone as tzone

from temba.archives.models import Archive
from temba.tests import MigrationTest


class DeleteRolledUpTest(MigrationTest):
    app = "archives"
    migrate_from = "0030_archive_uuid_alter_archive_hash"
    migrate_to = "0031_delete_rolled_up"

    def setUpBeforeMigration(self, apps):
        # daily that has not yet been rolled up or purged
        self.d240502 = self.create_archive(Archive.TYPE_MSG, "D", date(2024, 5, 2), needs_deletion=True)
        # daily that has been rolled up but not purged
        self.d240501 = self.create_archive(
            Archive.TYPE_MSG,
            "D",
            date(2024, 5, 1),
            needs_deletion=False,
            deleted_on=datetime(2024, 5, 2, 0, 0, 0, 0, tzone.utc),
        )
        # daily that has been rolled up but purging is failing for some reason
        self.d240430 = self.create_archive(
            Archive.TYPE_MSG,
            "D",
            date(2024, 4, 30),
            needs_deletion=True,
        )
        # two dailies that have been rolled up and purged
        self.d240429 = self.create_archive(
            Archive.TYPE_MSG,
            "D",
            date(2024, 4, 29),
            [{"id": 1}],
            needs_deletion=False,
            deleted_on=datetime(2024, 4, 30, 0, 0, 0, 0, tzone.utc),
        )
        self.d240428 = self.create_archive(
            Archive.TYPE_MSG,
            "D",
            date(2024, 4, 28),
            [{"id": 1}],
            needs_deletion=False,
            deleted_on=datetime(2024, 4, 30, 0, 0, 0, 0, tzone.utc),
        )
        # an empty daily
        self.d240427 = self.create_archive(
            Archive.TYPE_MSG, "D", date(2024, 4, 27), [], needs_deletion=False, deleted_on=None
        )
        # monthly that rolls up the two daily archives above
        self.m2404 = self.create_archive(
            Archive.TYPE_MSG,
            "M",
            date(2024, 4, 29),
            needs_deletion=False,
            rollup_of=[self.d240430, self.d240429, self.d240428, self.d240427],
        )

    def test_migration(self):
        def assert_exists(archive, should_exist):
            exists = Archive.objects.filter(id=archive.id).exists()
            if should_exist:
                self.assertTrue(exists, f"Expected archive {archive.id} to exist")
            else:
                self.assertFalse(exists, f"Expected archive {archive.id} to be deleted")

        assert_exists(self.d240502, True)  # not rolled up
        assert_exists(self.d240501, True)  # rolled up but not purged
        assert_exists(self.d240430, True)  # rolled up but purging failed
        assert_exists(self.d240429, False)  # rolled up and purged
        assert_exists(self.d240428, False)  # rolled up and purged
        assert_exists(self.d240427, False)  # empty and purged
        assert_exists(self.m2404, True)  # monthly rollup


class ClearEmptyUploadsTest(MigrationTest):
    app = "archives"
    migrate_from = "0033_alter_archive_uuid"
    migrate_to = "0034_remove_empty_uploads"

    def setUpBeforeMigration(self, apps):
        # non-empty archive with upload
        self.d240501 = self.create_archive(Archive.TYPE_MSG, "D", date(2024, 5, 1), [{"id": 1}])

        # empty archive without upload
        self.d240502 = self.create_archive(Archive.TYPE_MSG, "D", date(2024, 5, 2), [])

        # empty archive with upload
        self.d240503 = self.create_archive(Archive.TYPE_MSG, "D", date(2024, 5, 3), [])
        self.d240503.location = "test-archives:some/key/for/archive.zip"
        self.d240503.hash = "somehashvalue"
        self.d240503.save()

    def test_migration(self):
        def assert_upload(archive, exists: bool):
            archive.refresh_from_db()
            if exists:
                self.assertIsNotNone(archive.location, f"Expected archive {archive!r} to have upload")
                self.assertIsNotNone(archive.hash, f"Expected archive {archive!r} to have hash")
            else:
                self.assertIsNone(archive.location, f"Expected archive {archive!r} to have upload cleared")
                self.assertIsNone(archive.hash, f"Expected archive {archive!r} to have hash cleared")

        assert_upload(self.d240501, True)  # non-empty archive upload should remain
        assert_upload(self.d240502, False)  # empty archive upload should remain cleared
        assert_upload(self.d240503, False)  # empty archive upload should be cleared
