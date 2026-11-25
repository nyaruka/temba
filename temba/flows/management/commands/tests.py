from django.core.management import call_command

from temba.tests import TembaTest


class MigrateFlowsTest(TembaTest):
    def test_command(self):
        call_command("migrate_flows")
