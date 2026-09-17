from unittest.mock import patch

from django.test.utils import override_settings
from django.urls import reverse
from django.utils import timezone

from temba.knowledge.models import HelpSite, KnowledgeSource
from temba.orgs.models import Org
from temba.tests import CRUDLTestMixin, TembaTest


class HelpSiteCRUDLTest(TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        self.helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)

    def enable_agents(self, org):
        org.features = [Org.FEATURE_AGENTS]
        org.save(update_fields=("features",))

    def test_update(self):
        update_url = reverse("knowledge.helpsite_update")
        self.assertEqual("/helpsite/update/", update_url)

        # the site is made the first time anyone comes here
        self.assertFalse(HelpSite.objects.filter(source=self.helpdesk).exists())

        # nobody can access if agents feature not enabled
        response = self.requestView(update_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(update_url, [None, self.agent])

        self.assertUpdateFetch(
            update_url,
            [self.editor, self.admin],
            form_fields={
                "title": "Nyaruka",
                "tagline": "",
                "footer": "",
                "chat_channel": "",
                "primary_color": HelpSite.DEFAULT_PRIMARY_COLOR,
                "header_color": HelpSite.DEFAULT_HEADER_COLOR,
                "bubble_1": None,
                "bubble_2": None,
                "bubble_3": None,
            },
        )

        site = HelpSite.objects.get(source=self.helpdesk)
        self.assertEqual(1, HelpSite.objects.filter(source=self.helpdesk).count())

        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"title": "", "primary_color": "red", "header_color": "", "bubble_1": "#12345"},
            form_errors={
                "title": "This field is required.",
                "primary_color": "Not a valid color.",
                "header_color": "This field is required.",
                "bubble_1": "Not a valid color.",
            },
            object_unchanged=site,
        )

        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "title": "Nyaruka Help",
                "tagline": "How can we help?",
                "footer": "© Nyaruka",
                "primary_color": " #FF6600 ",
                "header_color": "#1F2937",
                "bubble_1": "#FFE8A3",
                "bubble_2": "",
                "bubble_3": "#123456",
            },
        )

        site.refresh_from_db()
        self.assertEqual("Nyaruka Help", site.title)
        self.assertEqual("How can we help?", site.tagline)
        self.assertEqual("© Nyaruka", site.footer)
        self.assertEqual("#ff6600", site.primary_color)
        self.assertEqual("#1f2937", site.header_color)
        self.assertEqual(self.admin, site.modified_by)

        # the bubbles are the helpdesk's palette, which is what the editor offers and articles resolve against
        self.helpdesk.refresh_from_db()
        self.assertEqual({"1": "#ffe8a3", "3": "#123456"}, self.helpdesk.colors)
        self.assertEqual({"1": "#ffe8a3", "3": "#123456"}, site.bubbles)

        response = self.requestView(update_url, self.admin)
        self.assertEqual("#ffe8a3", response.context["form"].initial["bubble_1"])
        self.assertNotIn("bubble_2", response.context["form"].initial)

        # clearing a bubble drops it from the palette
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "title": "Nyaruka Help",
                "primary_color": "#ff6600",
                "header_color": "#ffffff",
                "bubble_1": "",
                "bubble_3": "#123456",
            },
        )
        self.helpdesk.refresh_from_db()
        self.assertEqual({"3": "#123456"}, self.helpdesk.colors)

        # the site can embed the chat widget of one of the org's WebChat channels
        webchat = self.create_channel("WCH", "Site Chat", None)
        other_webchat = self.create_channel("WCH", "Other Chat", None, org=self.org2)
        self.create_channel("TG", "Telegram", "1234")

        response = self.requestView(update_url, self.admin)
        self.assertEqual(
            [("", "None"), (str(webchat.uuid), "Site Chat")], response.context["form"].fields["chat_channel"].choices
        )
        site.refresh_from_db()

        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "title": "Nyaruka Help",
                "primary_color": "#ff6600",
                "header_color": "#ffffff",
                "chat_channel": str(other_webchat.uuid),
            },
            form_errors={
                "chat_channel": "Select a valid choice. %s is not one of the available choices." % other_webchat.uuid
            },
            object_unchanged=site,
        )

        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {
                "title": "Nyaruka Help",
                "primary_color": "#ff6600",
                "header_color": "#ffffff",
                "chat_channel": str(webchat.uuid),
            },
        )

        site.refresh_from_db()
        self.assertEqual(str(webchat.uuid), site.config[HelpSite.CONFIG_CHAT_CHANNEL])
        self.assertEqual(webchat, site.chat_channel)

        response = self.requestView(update_url, self.admin)
        self.assertEqual(str(webchat.uuid), response.context["form"].initial["chat_channel"])

        # a channel that's since been removed leaves the site without chat
        webchat.release(self.admin)
        self.assertIsNone(site.chat_channel)

    def test_domain(self):
        domain_url = reverse("knowledge.helpsite_domain")
        self.assertEqual("/helpsite/domain/", domain_url)

        # nobody can access if agents feature not enabled
        response = self.requestView(domain_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(domain_url, [None, self.agent])
        self.assertUpdateFetch(domain_url, [self.editor, self.admin], form_fields={"is_enabled": False, "domain": None})

        site = HelpSite.objects.get(source=self.helpdesk)

        # the records panel is there from the start, hidden until a domain is typed - so it's ready to follow one
        response = self.requestView(domain_url, self.admin)
        self.assertRegex(response.content.decode(), r'data-saved=""\s+hidden')
        self.assertContains(response, f"<code>{site.domain_token}</code>")

        # the CNAME points at the service that serves the sites, or at the app itself where none is configured
        with override_settings(HELPSITE_CNAME_TARGET=None):
            response = self.requestView(domain_url, self.admin)
            self.assertContains(response, "<code>app.rapidpro.io</code>")
        with override_settings(HELPSITE_CNAME_TARGET="helpsites.rapidpro.io"):
            response = self.requestView(domain_url, self.admin)
            self.assertContains(response, "<code>helpsites.rapidpro.io</code>")
            self.assertNotContains(response, "<code>app.rapidpro.io</code>")

        # a domain has to be a domain, and not the app's own
        for bad, error in (
            ("not a domain", "Not a valid domain name."),
            ("help", "Not a valid domain name."),
            ("-bad.example.com", "Not a valid domain name."),
            ("app.rapidpro.io", "Can't use the default domain."),
        ):
            self.assertUpdateSubmit(
                domain_url, self.admin, {"domain": bad}, form_errors={"domain": error}, object_unchanged=site
            )

        # saving a domain closes the dialog - it's verified later, whenever the org comes back to check
        self.assertUpdateSubmit(domain_url, self.admin, {"domain": " Help.Nyaruka.com ", "is_enabled": True})
        site.refresh_from_db()
        self.assertEqual("help.nyaruka.com", site.domain)
        self.assertIsNone(site.domain_verified_on)  # verified only once its record is found
        self.assertTrue(site.is_enabled)  # though that alone doesn't make it available, see is_available
        self.assertEqual(self.admin, site.modified_by)

        # and the dialog then shows the records to add for it, and the way to check them
        response = self.requestView(domain_url, self.admin)
        self.assertContains(response, 'data-saved="help.nyaruka.com"')
        self.assertNotRegex(response.content.decode(), r'data-saved="help.nyaruka.com"\s+hidden')
        self.assertContains(response, '<b class="domain-name">help.nyaruka.com</b>')
        self.assertContains(response, '<code class="record-name">_helpsite-verification.help.nyaruka.com</code>')
        self.assertContains(response, 'id="domain-status"')
        self.assertContains(response, reverse("knowledge.helpsite_verify"))

        # a domain another site has verified can't be claimed, though an unverified claim on it can
        other = HelpSite.get_or_create(self.org2.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK), self.admin2)
        other.set_domain(self.admin2, "help.example.com")
        self.assertUpdateSubmit(domain_url, self.admin, {"domain": "help.example.com"})
        site.refresh_from_db()
        self.assertEqual("help.example.com", site.domain)

        other.domain_verified_on = timezone.now()
        other.save(update_fields=("domain_verified_on",))
        self.assertUpdateSubmit(
            domain_url,
            self.admin,
            {"domain": "help.example.com"},
            form_errors={"domain": "This domain is already in use by another help site."},
            object_unchanged=site,
        )

        # a verified domain stays verified while it's saved again unchanged, and a change starts over
        site.set_domain(self.admin, "help.nyaruka.com")
        site.domain_verified_on = timezone.now()
        site.save(update_fields=("domain_verified_on",))
        response = self.requestView(domain_url, self.admin)
        self.assertContains(response, "Verified. Your help site is served on this domain.")
        self.assertNotContains(response, 'id="domain-status"')

        self.assertUpdateSubmit(domain_url, self.admin, {"domain": "help.nyaruka.com"})
        site.refresh_from_db()
        self.assertIsNotNone(site.domain_verified_on)

        self.assertUpdateSubmit(domain_url, self.admin, {"domain": "docs.example.com"})
        site.refresh_from_db()
        self.assertEqual("docs.example.com", site.domain)
        self.assertIsNone(site.domain_verified_on)

        # a subdomain of the app's own domain is allowed - it's how we'll serve our own helpdesk
        self.assertUpdateSubmit(domain_url, self.admin, {"domain": "help.app.rapidpro.io"})
        site.refresh_from_db()
        self.assertEqual("help.app.rapidpro.io", site.domain)

        # and can be taken away again
        self.assertUpdateSubmit(domain_url, self.admin, {"domain": ""})
        site.refresh_from_db()
        self.assertIsNone(site.domain)
        response = self.requestView(domain_url, self.admin)
        self.assertRegex(response.content.decode(), r'data-saved=""\s+hidden')

    @patch("temba.knowledge.models.lookup_txt")
    def test_verify(self, mock_lookup):
        verify_url = reverse("knowledge.helpsite_verify")
        self.assertEqual("/helpsite/verify/", verify_url)

        # nobody can access if agents feature not enabled
        response = self.requestView(verify_url, self.admin, post_data={})
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(verify_url, [None, self.agent])

        self.login(self.editor)

        # GET isn't allowed
        self.assertEqual(405, self.client.get(verify_url).status_code)

        # nothing to check until there's a domain
        response = self.client.post(verify_url)
        self.assertEqual(400, response.status_code)
        self.assertEqual({"error": "No domain has been set."}, response.json())

        site = HelpSite.objects.get(source=self.helpdesk)
        site.set_domain(self.editor, "help.nyaruka.com")

        mock_lookup.return_value = ["nope"]
        response = self.client.post(verify_url)
        self.assertEqual({"domain": "help.nyaruka.com", "verified": False}, response.json())
        site.refresh_from_db()
        self.assertFalse(site.is_domain_verified)

        mock_lookup.return_value = [site.domain_token]
        response = self.client.post(verify_url)
        self.assertEqual({"domain": "help.nyaruka.com", "verified": True}, response.json())
        site.refresh_from_db()
        self.assertTrue(site.is_domain_verified)
