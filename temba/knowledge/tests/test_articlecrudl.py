from unittest.mock import patch

from django.conf import settings
from django.urls import reverse
from django.utils import timezone

from temba.knowledge.models import Article, HelpSite, KnowledgeSource
from temba.orgs.models import Org
from temba.tests import CRUDLTestMixin, TembaTest, cleanup
from temba.utils import json
from temba.utils.s3 import public_file_storage


class ArticleCRUDLTest(TembaTest, CRUDLTestMixin):
    def setUp(self):
        super().setUp()

        self.helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)

    def enable_agents(self, org):
        org.features = [Org.FEATURE_AGENTS]
        org.save(update_fields=("features",))

    def test_list(self):
        list_url = reverse("knowledge.article_list")

        # nobody can access if agents feature not enabled
        response = self.requestView(list_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(list_url, [None, self.agent])

        flows = Article.create(self.helpdesk, self.admin, "Flows")
        Article.create(self.helpdesk, self.admin, "Nodes", parent=flows)

        response = self.requestView(list_url, self.editor)

        # the tree itself is the component's to fetch and reorder - the page only points it at the endpoints
        self.assertEqual(200, response.status_code)
        self.assertEqual(self.helpdesk, response.context["object"])
        self.assertEqual(f"{reverse('api.internal.articles')}.json", response.context["articles_endpoint"])
        self.assertEqual(reverse("knowledge.article_sort"), response.context["sort_url"])
        self.assertEqual(reverse("knowledge.article_publish"), response.context["publish_url"])
        self.assertContains(response, "temba-helpdesk-cards")

        # rows open the editor dialog rather than a page of their own, so the list offers no row actions of its own
        self.assertContains(response, 'id="update-article"')
        self.assertNotContains(response, "-temba-article-delete")

        # deleting rides the editor dialog's gutter, pointed at whichever article is opened
        self.assertContains(response, 'slot="gutter"')

        # the menu makes sections; articles are added from their section's card, which the page points at the create
        # view for
        self.assertContentMenu(list_url, self.admin, ["New Section", "Site Settings"])
        self.assertEqual(reverse("knowledge.article_create"), response.context["create_url"])
        self.assertContains(response, "temba-article-add-requested")

        # the public site is the helpdesk's, so it's previewed from the card at the top of the page
        self.assertEqual(reverse("knowledge.site_home"), response.context["preview_url"])
        self.assertContains(response, "function previewHelpSite(event)")
        self.assertContains(response, 'class="domain-pill"')

        # nothing is opened for editing unless we've been sent here by the create modal
        self.assertNotIn("edit_article", response.context)

        # without a domain the card is the invitation to set one up - for those who can; the domain dialog is the
        # card's rather than the menu's
        self.assertNotIn("site", response.context)
        self.assertEqual(reverse("knowledge.helpsite_domain"), response.context["domain_url"])
        self.assertContains(response, 'id="site-domain-card"')
        self.assertContains(response, "No domain yet")
        self.assertContains(response, 'onclick="showSiteDomain()"')

        # an unverified domain heads the page as something to finish, opening the domain dialog for whoever can
        site = HelpSite.get_or_create(self.helpdesk, self.admin)
        site.set_domain(self.admin, "help.example.com")

        response = self.requestView(list_url, self.admin)
        self.assertEqual(site, response.context["site"])
        self.assertEqual(reverse("knowledge.helpsite_domain"), response.context["domain_url"])
        self.assertContains(response, 'id="site-domain-card"')
        self.assertContains(response, "help.example.com")
        self.assertContains(response, "Not verified")
        self.assertContains(response, 'onclick="showSiteDomain()"')
        self.assertContains(response, "function showSiteDomain()")
        self.assertNotContains(response, 'href="https://help.example.com/"')

        # verified and enabled, it's a link out to the live site
        site.domain_verified_on = timezone.now()
        site.is_enabled = True
        site.save(update_fields=("domain_verified_on", "is_enabled"))

        response = self.requestView(list_url, self.admin)
        self.assertContains(response, 'href="https://help.example.com/"')
        self.assertContains(response, "Verified")
        self.assertNotContains(response, "Not verified")
        self.assertNotContains(response, 'onclick="showSiteDomain()"')

        # verified but switched off, it's back to opening the dialog - but says which it is
        site.is_enabled = False
        site.save(update_fields=("is_enabled",))

        response = self.requestView(list_url, self.admin)
        self.assertContains(response, "not yet enabled")
        self.assertContains(response, 'onclick="showSiteDomain()"')
        self.assertNotContains(response, 'href="https://help.example.com/"')

        response = self.requestView(f"{list_url}?edit={flows.uuid}", self.admin)
        self.assertEqual(flows, response.context["edit_article"])

        # an article that isn't ours to edit, or isn't a uuid at all, is simply ignored
        other_org = Article.create(
            self.org2.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK), self.admin2, "Other"
        )
        for edit in (other_org.uuid, "not-a-uuid", ""):
            response = self.requestView(f"{list_url}?edit={edit}", self.admin)
            self.assertNotIn("edit_article", response.context)

        # 404 if the system source is somehow absent
        self.org.sources.filter(source_type=KnowledgeSource.TYPE_HELPDESK).update(is_active=False)
        response = self.requestView(list_url, self.admin)
        self.assertEqual(404, response.status_code)

    def test_read_is_gone(self):
        # articles are read in the editor dialog, so there's no read page and nothing at its old URL
        article = Article.create(self.helpdesk, self.admin, "Flows")

        self.enable_agents(self.org)
        self.login(self.admin)

        self.assertEqual(404, self.client.get(f"/article/read/{article.uuid}/").status_code)

    def test_create(self):
        create_url = reverse("knowledge.article_create")

        # nobody can access if agents feature not enabled
        response = self.requestView(create_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(create_url, [None, self.agent])

        # without a section named, we're making one: titled and described in plain text
        response = self.assertCreateFetch(create_url, [self.editor, self.admin], form_fields=("title", "description"))
        self.assertEqual("New Section", response.context["title"])

        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"title": "Getting Started", "description": "Setting up and finding your way around."},
            new_obj_query=Article.objects.filter(title="Getting Started", source=self.helpdesk),
        )

        section = Article.objects.get(title="Getting Started")
        self.assertEqual("getting-started", section.slug)
        self.assertEqual("Setting up and finding your way around.", section.description)
        self.assertIsNone(section.parent)
        self.assertEqual("eng", section.language)  # the workspace's primary language, never asked
        self.assertEqual(Article.STATUS_DRAFT, section.status)  # new sections are drafts

        # a section is complete as described, so we're just sent back to the helpdesk
        response = self.requestView(create_url, self.admin, post_data={"title": "Flows", "description": ""})
        self.assertEqual(302, response.status_code)
        self.assertEqual(reverse("knowledge.article_list"), response.url)

        # but not one described at length
        response = self.requestView(
            create_url, self.admin, post_data={"title": "Nope", "description": "x" * (Article.MAX_DESCRIPTION_LEN + 1)}
        )
        self.assertFormError(
            response.context["form"],
            "description",
            f"Ensure this value has at most {Article.MAX_DESCRIPTION_LEN} characters (it has "
            f"{Article.MAX_DESCRIPTION_LEN + 1}).",
        )

        # named a section, we're making an article in it - titled here and written in the editor. Even a
        # multi-language workspace isn't asked which language it's in: articles take the primary language
        self.org.set_flow_languages(self.admin, ["eng", "spa"])
        article_url = f"{create_url}?section={section.uuid}"
        response = self.assertCreateFetch(article_url, [self.editor, self.admin], form_fields=("title",))
        self.assertEqual("New Article", response.context["title"])
        self.assertNotContains(response, 'name="Spanish"')

        self.assertCreateSubmit(
            article_url,
            self.admin,
            {"title": "Installing"},
            new_obj_query=Article.objects.filter(title="Installing", source=self.helpdesk),
        )

        article = Article.objects.get(title="Installing")
        self.assertEqual("installing", article.slug)
        self.assertEqual(section, article.parent)
        self.assertEqual("eng", article.language)
        self.assertEqual(Article.STATUS_DRAFT, article.status)  # new articles are drafts

        # and we're sent back to the helpdesk, which opens the editor on what we just made
        response = self.requestView(article_url, self.admin, post_data={"title": "Configuring"})
        self.assertEqual(302, response.status_code)
        self.assertEqual(
            f"{reverse('knowledge.article_list')}?edit={Article.objects.get(title='Configuring').uuid}", response.url
        )

        # a section that isn't one of ours, isn't a section, or isn't a uuid at all is nowhere to file an article
        other_org = Article.create(
            self.org2.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK), self.admin2, "Other"
        )
        for bad in (other_org.uuid, article.uuid, "not-a-uuid"):
            response = self.requestView(f"{create_url}?section={bad}", self.admin)
            self.assertEqual(404, response.status_code)

        # can't create beyond the limit
        with patch("temba.knowledge.models.Article.MAX_ARTICLES", 4):
            response = self.requestView(create_url, self.admin)
            self.assertContains(response, "You have reached the limit")

            response = self.requestView(create_url, self.admin, post_data={"title": "Nope", "description": ""})
            self.assertEqual(200, response.status_code)
            self.assertFalse(Article.objects.filter(title="Nope").exists())

            response = self.requestView(article_url, self.admin, post_data={"title": "Nope"})
            self.assertEqual(200, response.status_code)
            self.assertFalse(Article.objects.filter(title="Nope").exists())

    def test_update(self):
        section = Article.create(self.helpdesk, self.admin, "Flows", description="All about flows.")
        article = Article.create(self.helpdesk, self.admin, "Nodes", parent=section)

        update_url = reverse("knowledge.article_update", args=[article.uuid])

        # nobody can access if agents feature not enabled
        response = self.requestView(update_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])

        response = self.assertUpdateFetch(update_url, [self.editor, self.admin], form_fields=("title", "body"))

        # the editor is pointed at this article for uploads, and fills the dialog rather than growing it
        self.assertContains(response, reverse("knowledge.article_upload", args=[article.uuid]))
        self.assertContains(response, "fill")

        # the editor is pointed at the other articles so links to them can be picked by title
        self.assertContains(response, f'articles-endpoint="{reverse("api.internal.articles")}.json"')

        # and at storage, so images referenced by their key can be shown
        self.assertContains(response, f'storage-url="{settings.STORAGE_URL}"')

        # the article is shown in the site's own colors - the default until the org has a site that chose one
        self.assertNotContains(response, "primary-color")

        site = HelpSite.get_or_create(self.helpdesk, self.admin)
        site.config[HelpSite.CONFIG_PRIMARY_COLOR] = "#b03060"
        site.save(update_fields=("config",))

        response = self.assertUpdateFetch(update_url, [self.admin], form_fields=("title", "body"))
        self.assertContains(response, 'primary-color="#b03060"')

        # the dialog has no title bar: the title field is slotted into the editor, which heads the article with it as
        # the site does - and there's no status either, since publishing is done from the row, and deleting from the
        # gutter button the list page owns
        self.assertContains(response, 'slot="title"')
        self.assertContains(response, 'name="title"')
        self.assertContains(response, ">Nodes</textarea>")
        self.assertNotContains(response, "temba-textinput")
        self.assertNotContains(response, "status-pill")
        self.assertNotContains(response, "temba-toggle")
        self.assertNotContains(response, reverse("knowledge.article_delete", args=[article.uuid]))

        # the body stands without a label of its own either
        self.assertEqual(1, response.content.decode().count("hide_label"))

        # a missing title is an error the editor shows under the title, since that's where it's edited
        response = self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"title": "", "body": "# Flows"},
            form_errors={"title": "This field is required."},
            object_unchanged=article,
        )
        self.assertContains(response, 'slot="title-errors"')
        self.assertContains(response, "This field is required.")

        self.assertUpdateSubmit(update_url, self.admin, {"title": "All About Flows", "body": "# Flows"})

        article.refresh_from_db()
        self.assertEqual("All About Flows", article.title)
        self.assertEqual("# Flows", article.body)
        self.assertEqual("all-about-flows", article.slug)  # the slug follows the title
        self.assertEqual("eng", article.language)  # never asked, so unchanged by an edit
        self.assertEqual(Article.STATUS_DRAFT, article.status)  # saving an edit doesn't publish

        # a section is described rather than written: no editor, and the dialog isn't held open to the window's
        # height for an editor it doesn't have
        section_url = reverse("knowledge.article_update", args=[section.uuid])
        response = self.assertUpdateFetch(section_url, [self.editor, self.admin], form_fields=("title", "description"))
        self.assertContains(response, "All about flows.")
        self.assertContains(response, "temba-textinput")  # a title field of its own, there being no editor to head
        self.assertNotContains(response, "status-pill")
        self.assertNotContains(response, reverse("knowledge.article_upload", args=[section.uuid]))
        self.assertNotContains(response, "88vh")

        self.assertUpdateSubmit(section_url, self.admin, {"title": "Flow Basics", "description": "The basics."})

        section.refresh_from_db()
        self.assertEqual("Flow Basics", section.title)
        self.assertEqual("The basics.", section.description)
        self.assertEqual("flow-basics", section.slug)

    def test_publish(self):
        article = Article.create(self.helpdesk, self.admin, "Flows")
        other_org = Article.create(
            self.org2.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK), self.admin2, "Other"
        )

        publish_url = reverse("knowledge.article_publish")

        # nobody can access if agents feature not enabled
        response = self.requestView(publish_url, self.admin, post_data={})
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(publish_url, [None, self.agent])

        self.login(self.admin)

        # GET isn't allowed
        self.assertEqual(405, self.client.get(publish_url).status_code)

        def publish(payload):
            return self.client.post(publish_url, json.dumps(payload), content_type="application/json")

        # publishing happens from the article's row, so it needs nothing but the article and the state wanted
        response = publish({"uuid": str(article.uuid), "status": "published"})
        self.assertEqual({"status": "ok"}, response.json())

        article.refresh_from_db()
        self.assertEqual(Article.STATUS_PUBLISHED, article.status)
        self.assertIsNotNone(article.published_on)

        modified_on = article.modified_on

        response = publish({"uuid": str(article.uuid), "status": "draft"})
        self.assertEqual({"status": "ok"}, response.json())

        article.refresh_from_db()
        self.assertEqual(Article.STATUS_DRAFT, article.status)
        self.assertIsNone(article.published_on)

        # which has to bump modified_on so that mailroom's sweep drops its chunks
        self.assertGreater(article.modified_on, modified_on)

        # a status we don't have, or a payload that isn't one at all, is refused rather than guessed at
        for payload in ({"uuid": str(article.uuid), "status": "live"}, {"uuid": str(article.uuid)}, {}, "nope"):
            self.assertEqual(400, publish(payload).status_code)

        # as is an article that isn't ours, or isn't a uuid at all
        for uuid in (str(other_org.uuid), "not-a-uuid"):
            self.assertEqual(404, publish({"uuid": uuid, "status": "published"}).status_code)

        article.refresh_from_db()
        self.assertEqual(Article.STATUS_DRAFT, article.status)

    def test_sort(self):
        flows = Article.create(self.helpdesk, self.admin, "Flows")
        contacts = Article.create(self.helpdesk, self.admin, "Contacts")
        nodes = Article.create(self.helpdesk, self.admin, "Nodes", parent=flows)

        sort_url = reverse("knowledge.article_sort")

        # nobody can access if agents feature not enabled
        response = self.requestView(sort_url, self.admin, post_data={})
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(sort_url, [None, self.agent])

        self.login(self.admin)

        # GET isn't allowed
        self.assertEqual(405, self.client.get(sort_url).status_code)

        response = self.client.post(
            sort_url,
            json.dumps(
                [
                    {"uuid": str(contacts.uuid), "parent": None, "sort_order": 0},
                    {"uuid": str(flows.uuid), "parent": None, "sort_order": 1},
                    {"uuid": str(nodes.uuid), "parent": str(contacts.uuid), "sort_order": 0},
                ]
            ),
            content_type="application/json",
        )
        self.assertEqual({"status": "ok"}, response.json())

        nodes.refresh_from_db()
        self.assertEqual(contacts, nodes.parent)

        # the tree the client sends is checked, not trusted - a section can't be dropped into another section
        response = self.client.post(
            sort_url,
            json.dumps([{"uuid": str(flows.uuid), "parent": str(contacts.uuid), "sort_order": 1}]),
            content_type="application/json",
        )
        self.assertEqual({"error": "a section can't become an article, nor an article a section"}, response.json())

        flows.refresh_from_db()
        self.assertIsNone(flows.parent)

        # a malformed payload is rejected without touching anything, as is one whose sort orders aren't finite or
        # which names more articles than a helpdesk can hold
        for payload in (
            '{"nope": 1}',
            "[{}]",
            '[{"uuid": "x", "parent": null, "sort_order": "y"}]',
            "not json",
            '[{"uuid": "x", "parent": null, "sort_order": Infinity}]',
        ):
            response = self.client.post(sort_url, payload, content_type="application/json")
            self.assertEqual(400, response.status_code)
            self.assertEqual({"error": "Invalid ordering."}, response.json())

        with patch("temba.knowledge.models.Article.MAX_ARTICLES", 1):
            response = self.client.post(
                sort_url,
                json.dumps([{"uuid": str(u), "parent": None, "sort_order": 0} for u in (flows.uuid, nodes.uuid)]),
                content_type="application/json",
            )
            self.assertEqual(400, response.status_code)
            self.assertEqual({"error": "Invalid ordering."}, response.json())

        # as is a tree the model won't accept - the client is never trusted
        response = self.client.post(
            sort_url,
            json.dumps([{"uuid": str(nodes.uuid), "parent": str(nodes.uuid), "sort_order": 0}]),
            content_type="application/json",
        )
        self.assertEqual(400, response.status_code)
        self.assertEqual({"error": "articles can't be their own ancestor"}, response.json())

        # or one that would nest an article below the two level cap - nodes already sits under contacts
        child = Article.create(self.helpdesk, self.admin, "Child", parent=contacts)
        response = self.client.post(
            sort_url,
            json.dumps([{"uuid": str(child.uuid), "parent": str(nodes.uuid), "sort_order": 0}]),
            content_type="application/json",
        )
        self.assertEqual(400, response.status_code)
        self.assertEqual({"error": "articles can't be nested more than 2 deep"}, response.json())

        child.refresh_from_db()
        self.assertEqual(contacts, child.parent)

        # a sort order too big for the column is clamped rather than handed to the database
        response = self.client.post(
            sort_url,
            json.dumps([{"uuid": str(flows.uuid), "parent": None, "sort_order": 2**40}]),
            content_type="application/json",
        )
        self.assertEqual({"status": "ok"}, response.json())

        flows.refresh_from_db()
        self.assertEqual(Article.MAX_ARTICLES, flows.sort_order)

    def test_colors(self):
        colors_url = reverse("knowledge.article_colors")

        # nobody can access if agents feature not enabled
        response = self.requestView(colors_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(colors_url, [None, self.agent])

        self.login(self.admin)

        # a helpdesk starts with no palette at all
        self.assertEqual({"colors": {}}, self.client.get(colors_url).json())

        # the palette is the bubble colors chosen in the site's settings, and is what every author's editor reads
        self.helpdesk.set_colors({"1": "#ffe8a3", "3": "#123456"})
        self.assertEqual({"colors": {"1": "#ffe8a3", "3": "#123456"}}, self.client.get(colors_url).json())

        # it's read here, never written
        self.assertEqual(405, self.client.post(colors_url, {"colors": {}}).status_code)

    def test_upload(self):
        article = Article.create(self.helpdesk, self.admin, "Flows")

        upload_url = reverse("knowledge.article_upload", args=[article.uuid])

        # nobody can access if agents feature not enabled
        response = self.requestView(upload_url, self.admin, post_data={})
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(upload_url, [None, self.agent, self.admin2])

        self.login(self.admin)

        # GET isn't allowed
        self.assertEqual(405, self.client.get(upload_url).status_code)

        # can't upload a file type we don't support (sniffed, not the browser supplied type)
        response = self.client.post(
            upload_url, {"file": self.upload(f"{settings.MEDIA_ROOT}/test_media/simple.pdf", "image/png")}
        )
        self.assertEqual({"error": "Unsupported file type"}, response.json())

        # can't upload a file that's too big
        with patch("temba.knowledge.models.ArticleImage.MAX_UPLOAD_SIZE", 10):
            response = self.client.post(
                upload_url, {"file": self.upload(f"{settings.MEDIA_ROOT}/test_media/klab.png", "image/png")}
            )
            self.assertEqual({"error": "Limit for file uploads is 9.5367431640625e-06 MB"}, response.json())

        # can't exceed the per article limit
        with patch("temba.knowledge.models.ArticleImage.MAX_IMAGES", 0):
            response = self.client.post(
                upload_url, {"file": self.upload(f"{settings.MEDIA_ROOT}/test_media/klab.png", "image/png")}
            )
            self.assertEqual({"error": "Limit of 0 images reached."}, response.json())

        response = self.client.post(
            upload_url, {"file": self.upload(f"{settings.MEDIA_ROOT}/test_media/klab.png", "image/png")}
        )

        image = article.images.get()
        self.assertEqual(
            {"uuid": str(image.uuid), "name": "klab.png", "path": image.path, "url": image.url}, response.json()
        )
        self.assertTrue(image.path.startswith(f"orgs/{self.org.id}/knowledge/"))  # the key, not an address
        self.assertEqual("image/png", image.content_type)
        self.assertTrue(public_file_storage.exists(image.path))

    @cleanup(s3=True)
    def test_delete(self):
        section = Article.create(self.helpdesk, self.admin, "Flows")
        article = Article.create(self.helpdesk, self.admin, "Nodes", parent=section)

        delete_url = reverse("knowledge.article_delete", args=[article.uuid])

        # nobody can access if agents feature not enabled
        response = self.requestView(delete_url, self.admin)
        self.assertRedirect(response, reverse("orgs.org_workspace"))

        self.enable_agents(self.org)

        self.assertRequestDisallowed(delete_url, [None, self.agent, self.admin2])

        response = self.assertDeleteFetch(delete_url, [self.editor, self.admin])
        self.assertContains(response, "You are about to delete the article")

        # a section holding articles can't go - they'd be left as sections themselves
        section_url = reverse("knowledge.article_delete", args=[section.uuid])
        response = self.assertDeleteFetch(section_url, [self.admin])
        self.assertContains(response, "still holds articles")
        self.assertNotContains(response, 'type="submit"')

        response = self.requestView(section_url, self.admin, post_data={})
        self.assertEqual(200, response.status_code)
        self.assertContains(response, "still holds articles")
        section.refresh_from_db()
        self.assertTrue(section.is_active)

        response = self.assertDeleteSubmit(delete_url, self.admin, object_deactivated=article, success_status=302)
        self.assertEqual(reverse("knowledge.article_list"), response.url)

        # emptied, the section can
        response = self.assertDeleteFetch(section_url, [self.admin])
        self.assertContains(response, "You are about to delete the section")
        self.assertContains(response, 'type="submit"')

        self.assertDeleteSubmit(section_url, self.admin, object_deactivated=section, success_status=302)
