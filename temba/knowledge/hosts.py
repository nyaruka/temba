class AllowedHosts(list):
    """
    An ALLOWED_HOSTS that admits every verified help site domain as well as the hosts it's given. A site's domain is
    whatever the org set, so a deployment can't list it up front - and Django checks the host of every request
    against this, so it's a list of the deployment's own hosts first, and only for a host they don't settle, the
    domains the sites have at that moment - a cache lookup, the same one the help site middleware makes.

    Use it in the settings of a deployment that serves help sites on their own domains:

        ALLOWED_HOSTS = AllowedHosts(["textit.com", ".textit.com"])
    """

    def __iter__(self):
        yield from list.__iter__(self)

        from .models import HelpSite

        for domain in HelpSite.get_domains():
            yield domain
            yield f"www.{domain}"
