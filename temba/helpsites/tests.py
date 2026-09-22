from unittest.mock import patch

from django.test.utils import override_settings

from temba.knowledge.models import HelpSite, KnowledgeSource
from temba.tests import TembaTest
from temba.tests.requests import MockResponse

from . import get_client


class HelpsitesClientTest(TembaTest):
    @override_settings(HELPSITES_URL="http://helpsites:8031", HELPSITES_PREVIEW_TOKEN="sesame")
    @patch("requests.get")
    def test_preview(self, mock_get):
        helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)
        site = HelpSite.get_or_create(helpdesk, self.admin)

        mock_get.return_value = MockResponse(200, "<html>home</html>", headers={"Content-Type": "text/html"})
        response = get_client().preview(site, "")

        self.assertEqual(200, response.status_code)
        self.assertEqual("<html>home</html>", response.text)
        mock_get.assert_called_once_with(
            f"http://helpsites:8031/hi/preview/{site.uuid}/",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            allow_redirects=False,
            timeout=30,
        )

        # the path and query string go through as they are
        mock_get.reset_mock()
        get_client().preview(site, "search/", "q=flows+nodes")
        mock_get.assert_called_once_with(
            f"http://helpsites:8031/hi/preview/{site.uuid}/search/?q=flows+nodes",
            headers={"User-Agent": "Temba", "Authorization": "Token sesame"},
            allow_redirects=False,
            timeout=30,
        )

        # the path is escaped, since it arrives decoded and could otherwise carry a query or fragment of its own
        mock_get.reset_mock()
        get_client().preview(site, "flows/?x=1#y ../z/")
        self.assertEqual(
            f"http://helpsites:8031/hi/preview/{site.uuid}/flows/%3Fx%3D1%23y%20../z/", mock_get.call_args.args[0]
        )

        # with no token configured, none is sent
        mock_get.reset_mock()
        with override_settings(HELPSITES_PREVIEW_TOKEN=None):
            get_client().preview(site, "flows/")
        self.assertEqual({"User-Agent": "Temba"}, mock_get.call_args.kwargs["headers"])
