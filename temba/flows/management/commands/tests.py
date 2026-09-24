from io import StringIO
from unittest.mock import patch

from django.core.management import call_command

from temba.flows.models import Flow
from temba.tests import TembaTest


class MigrateFlowsTest(TembaTest):
    def test_command(self):
        def call(*args) -> str:
            out = StringIO()
            call_command("migrate_flows", "--delay=0", *args, stdout=out)
            return out.getvalue()

        def rewind(flow):
            flow.version_number = "13.0.0"
            flow.save(update_fields=("version_number",))
            rev = flow.get_current_revision()
            rev.definition["spec_version"] = "13.0.0"
            rev.spec_version = "13.0.0"
            rev.save()

        self.assertIn("All flows up to date", call())

        flow = self.get_flow("favorites_v13")
        rewind(flow)

        # declining the prompt migrates nothing
        with patch("builtins.input", return_value="n") as mock_input:
            out = call()

        mock_input.assert_called_once_with("Continue? [y/N]: ")
        self.assertIn("Found 1 flows to migrate", out)
        self.assertNotIn("Flows migrated", out)
        flow.refresh_from_db()
        self.assertEqual("13.0.0", flow.version_number)

        # accepting it migrates the flow
        with patch("builtins.input", return_value="y"):
            out = call()

        self.assertIn("Flows migrated: 1 of 1 (0 errored)", out)
        flow.refresh_from_db()
        self.assertEqual(Flow.CURRENT_SPEC_VERSION, flow.version_number)

        rewind(flow)

        # with --noinput it migrates without prompting
        with patch("builtins.input") as mock_input:
            out = call("--noinput")

        mock_input.assert_not_called()
        self.assertIn("Found 1 flows to migrate", out)
        self.assertIn("Flows migrated: 1 of 1 (0 errored)", out)
        flow.refresh_from_db()
        self.assertEqual(Flow.CURRENT_SPEC_VERSION, flow.version_number)
