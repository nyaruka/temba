from urllib.parse import quote

import requests


class HelpsitesClient:
    """
    Client for the internal endpoints of the service that serves help sites
    """

    default_headers = {"User-Agent": "Temba"}

    def __init__(self, base_url: str, preview_token: str):
        self.base_url = base_url
        self.headers = self.default_headers.copy()
        if preview_token:
            self.headers["Authorization"] = "Token " + preview_token

    def preview(self, site, path: str, query: str = "") -> requests.Response:
        """
        Fetches a page of the given site as the service renders it for previewing: the given path of the site, with
        the given query string, under the prefix the app mounts the preview at. Redirects aren't followed - where
        they go is under that prefix too, and so for the caller to pass on.
        """
        # the path comes decoded from the app's URL, so anything in it that would mean something in ours is escaped
        url = f"{self.base_url}/hi/preview/{site.uuid}/{quote(path, safe='/')}"
        if query:
            url += f"?{query}"

        return requests.get(url, headers=self.headers, allow_redirects=False, timeout=30)
