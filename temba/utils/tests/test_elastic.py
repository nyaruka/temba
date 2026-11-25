from unittest.mock import patch

from temba.tests import TembaTest
from temba.utils.elastic import get_client


class ElasticTest(TembaTest):
    @patch("temba.utils.elastic.Elasticsearch")
    @patch("temba.utils.elastic.settings")
    def test_get_client(self, mock_settings, mock_es):
        mock_settings.ELASTIC_ENDPOINT_URL = "http://localhost:9200"

        get_client()

        mock_es.assert_called_once_with(
            hosts=["http://localhost:9200"],
            verify_certs=False,
        )

    @patch("temba.utils.elastic.Elasticsearch")
    @patch("temba.utils.elastic.settings")
    def test_get_client_https(self, mock_settings, mock_es):
        mock_settings.ELASTIC_ENDPOINT_URL = "https://search.example.com"

        get_client()

        mock_es.assert_called_once_with(
            hosts=["https://search.example.com:443"],
            verify_certs=True,
        )

    @patch("temba.utils.elastic.Elasticsearch")
    @patch("temba.utils.elastic.settings")
    def test_get_client_with_auth(self, mock_settings, mock_es):
        mock_settings.ELASTIC_ENDPOINT_URL = "https://user:pass@search.example.com"

        get_client()

        mock_es.assert_called_once_with(
            hosts=["https://search.example.com:443"],
            verify_certs=True,
            basic_auth=("user", "pass"),
        )
