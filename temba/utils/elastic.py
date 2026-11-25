from urllib.parse import urlparse

from elasticsearch import Elasticsearch

from django.conf import settings


def get_client() -> Elasticsearch:
    parsed = urlparse(settings.ELASTIC_ENDPOINT_URL)
    use_ssl = parsed.scheme == "https"

    host = parsed.hostname
    port = parsed.port or (443 if use_ssl else 9200)
    scheme = "https" if use_ssl else "http"

    kwargs = {}
    if parsed.username and parsed.password:
        kwargs["basic_auth"] = (parsed.username, parsed.password)

    return Elasticsearch(
        hosts=[f"{scheme}://{host}:{port}"],
        verify_certs=use_ssl,
        **kwargs,
    )
