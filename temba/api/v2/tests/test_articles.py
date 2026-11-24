from unittest.mock import call, patch
from uuid import uuid4

from django.urls import reverse

from temba.api.v2.serializers import format_datetime
from temba.knowledge.models import Article, KnowledgeSource
from temba.orgs.models import Org
from temba.tests import matchers, mock_mailroom

from . import APITest


class ArticlesEndpointTest(APITest):
    def setUp(self):
        super().setUp()

        self.helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)

    def enable_agents(self, org):
        org.features = [Org.FEATURE_AGENTS]
        org.save(update_fields=("features",))

    @mock_mailroom
    def test_endpoint(self, mr_mocks):
        endpoint_url = reverse("api.v2.articles") + ".json"

        self.assertGetNotPermitted(endpoint_url, [None, self.agent])
        self.assertPostNotPermitted(endpoint_url, [None, self.agent])
        self.assertDeleteNotPermitted(endpoint_url + "?uuid=123", [None, self.agent])

        # nobody can use it if the agents feature isn't enabled
        self.assertGetNotPermitted(endpoint_url, [self.editor, self.admin])
        self.assertPostNotPermitted(endpoint_url, [self.editor, self.admin])

        self.enable_agents(self.org)
        self.enable_agents(self.org2)

        flows = Article.create(self.helpdesk, self.admin, "Flows", description="All about flows.")
        nodes = Article.create(self.helpdesk, self.admin, "Nodes", parent=flows, body="# Nodes\n\nThey connect.")
        nodes.publish(self.admin)
        contacts = Article.create(self.helpdesk, self.admin, "Contacts")

        # a deleted article
        deleted = Article.create(self.helpdesk, self.admin, "Deleted", parent=flows)
        deleted.release(self.admin)

        # an article in another workspace's helpdesk
        other = Article.create(self.org2.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK), self.admin2, "Other")

        # no filtering
        self.assertGet(
            endpoint_url,
            [self.editor, self.admin],
            results=[
                {
                    "uuid": str(contacts.uuid),
                    "title": "Contacts",
                    "slug": "contacts",
                    "section": None,
                    "description": "",
                    "body": "",
                    "language": "eng",
                    "status": "draft",
                    "created_on": matchers.ISODatetime(),
                    "modified_on": matchers.ISODatetime(),
                    "published_on": None,
                },
                {
                    "uuid": str(nodes.uuid),
                    "title": "Nodes",
                    "slug": "nodes",
                    "section": {"uuid": str(flows.uuid), "title": "Flows"},
                    "description": "",
                    "body": "# Nodes\n\nThey connect.",
                    "language": "eng",
                    "status": "published",
                    "created_on": matchers.ISODatetime(),
                    "modified_on": matchers.ISODatetime(),
                    "published_on": matchers.ISODatetime(),
                },
                {
                    "uuid": str(flows.uuid),
                    "title": "Flows",
                    "slug": "flows",
                    "section": None,
                    "description": "All about flows.",
                    "body": "",
                    "language": "eng",
                    "status": "draft",
                    "created_on": matchers.ISODatetime(),
                    "modified_on": matchers.ISODatetime(),
                    "published_on": None,
                },
            ],
            num_queries=self.BASE_SESSION_QUERIES + 2,
        )

        # filter by UUID
        self.assertGet(endpoint_url + f"?uuid={nodes.uuid}", [self.editor], results=[nodes])

        # filter by section
        self.assertGet(endpoint_url + f"?section={flows.uuid}", [self.editor], results=[nodes])
        self.assertGet(endpoint_url + f"?section={uuid4()}", [self.editor], results=[])

        # reverse the order and filter by modified_on
        self.assertGet(endpoint_url + "?reverse=true", [self.editor], results=[flows, nodes, contacts])
        self.assertGet(
            endpoint_url + f"?after={format_datetime(nodes.modified_on)}", [self.editor], results=[contacts, nodes]
        )
        self.assertGet(
            endpoint_url + f"?before={format_datetime(nodes.modified_on)}", [self.editor], results=[nodes, flows]
        )

        # an API token works too
        self.assertGet(endpoint_url, [self.admin], results=[contacts, nodes, flows], by_token=True)

        # try to create without a title
        self.assertPost(endpoint_url, self.editor, {}, errors={"title": "This field is required."})

        # try to create in a section that doesn't exist, or isn't a section
        self.assertPost(
            endpoint_url,
            self.editor,
            {"title": "Ticketing", "section": str(other.uuid)},
            errors={"section": "No such section."},
        )
        self.assertPost(
            endpoint_url,
            self.editor,
            {"title": "Ticketing", "section": str(nodes.uuid)},
            errors={"section": "No such section."},
        )

        # try to give a section a body, or an article a description
        self.assertPost(
            endpoint_url,
            self.editor,
            {"title": "Ticketing", "body": "# Hi"},
            errors={"body": "A section has a description rather than a body."},
        )
        self.assertPost(
            endpoint_url,
            self.editor,
            {"title": "Ticketing", "section": str(flows.uuid), "description": "Hi"},
            errors={"description": "An article has a body rather than a description."},
        )

        # try to create with an invalid language or status
        self.assertPost(
            endpoint_url,
            self.editor,
            {"title": "Ticketing", "language": "xyz"},
            errors={"language": "Not an allowed ISO 639-3 language code."},
        )
        self.assertPost(
            endpoint_url,
            self.editor,
            {"title": "Ticketing", "status": "live"},
            errors={"status": '"live" is not a valid choice.'},
        )

        self.helpdesk.status = KnowledgeSource.STATUS_READY
        self.helpdesk.save(update_fields=("status",))
        mr_mocks.calls["knowledge_index"].clear()

        # create a section
        response = self.assertPost(
            endpoint_url, self.editor, {"title": "Ticketing", "description": "Helping people."}, status=201
        )

        ticketing = Article.objects.get(title="Ticketing")
        self.assertEqual(
            {
                "uuid": str(ticketing.uuid),
                "title": "Ticketing",
                "slug": "ticketing",
                "section": None,
                "description": "Helping people.",
                "body": "",
                "language": "eng",
                "status": "draft",
                "created_on": matchers.ISODatetime(),
                "modified_on": matchers.ISODatetime(),
                "published_on": None,
            },
            response.json(),
        )
        self.assertIsNone(ticketing.parent)
        self.assertEqual(2, ticketing.sort_order)  # after the other sections

        # a draft isn't indexed
        self.helpdesk.refresh_from_db()
        self.assertEqual(KnowledgeSource.STATUS_READY, self.helpdesk.status)
        self.assertEqual([], mr_mocks.calls["knowledge_index"])

        # create a published article in it, with its body's whitespace kept
        response = self.assertPost(
            endpoint_url,
            self.admin,
            {
                "title": "Opening Tickets",
                "section": str(ticketing.uuid),
                "body": "# Opening\n\n    code\n",
                "language": "kin",
                "status": "published",
            },
            status=201,
        )

        opening = Article.objects.get(title="Opening Tickets")
        self.assertEqual(ticketing, opening.parent)
        self.assertEqual("# Opening\n\n    code\n", opening.body)
        self.assertEqual("kin", opening.language)
        self.assertEqual(Article.STATUS_PUBLISHED, opening.status)
        self.assertIsNotNone(opening.published_on)
        self.assertIn("<h1", opening.body_html)
        self.assertEqual("published", response.json()["status"])
        self.assertEqual({"uuid": str(ticketing.uuid), "title": "Ticketing"}, response.json()["section"])

        self.helpdesk.refresh_from_db()
        self.assertEqual(KnowledgeSource.STATUS_PENDING, self.helpdesk.status)
        self.assertEqual([call(self.org, self.helpdesk)], mr_mocks.calls["knowledge_index"])

        # update an article - its slug follows its title
        mr_mocks.calls["knowledge_index"].clear()
        response = self.assertPost(
            endpoint_url + f"?uuid={opening.uuid}", self.editor, {"title": "Opening a Ticket", "body": "# New"}
        )
        self.assertEqual(200, response.status_code)

        opening.refresh_from_db()
        self.assertEqual("Opening a Ticket", opening.title)
        self.assertEqual("opening-a-ticket", opening.slug)
        self.assertEqual("# New", opening.body)
        self.assertEqual("kin", opening.language)  # unchanged
        self.assertIn("New", opening.body_html)  # re-rendered as it's published
        self.assertEqual(self.editor, opening.modified_by)

        # it's published so its changes are indexed
        self.assertEqual([call(self.org, self.helpdesk)], mr_mocks.calls["knowledge_index"])

        # move it into another section, where it goes to the end
        self.assertPost(endpoint_url + f"?uuid={opening.uuid}", self.editor, {"section": str(flows.uuid)})

        opening.refresh_from_db()
        self.assertEqual(flows, opening.parent)
        self.assertEqual(nodes.sort_order + 1, opening.sort_order)

        # try to move a section into a section
        self.assertPost(
            endpoint_url + f"?uuid={ticketing.uuid}",
            self.editor,
            {"section": str(flows.uuid)},
            errors={"section": "A section can't be moved into another section."},
        )

        # try to give an existing article a description
        self.assertPost(
            endpoint_url + f"?uuid={opening.uuid}",
            self.editor,
            {"description": "Nope"},
            errors={"description": "An article has a body rather than a description."},
        )

        # unpublish it, which is indexed so its chunks are dropped
        mr_mocks.calls["knowledge_index"].clear()
        self.assertPost(endpoint_url + f"?uuid={opening.uuid}", self.editor, {"status": "draft"})

        opening.refresh_from_db()
        self.assertEqual(Article.STATUS_DRAFT, opening.status)
        self.assertIsNone(opening.published_on)
        self.assertEqual([call(self.org, self.helpdesk)], mr_mocks.calls["knowledge_index"])

        # publish it again along with an edit, which renders its body just the once
        mr_mocks.calls["knowledge_index"].clear()
        with patch.object(Article, "prerender", autospec=True, side_effect=Article.prerender) as mock_prerender:
            self.assertPost(
                endpoint_url + f"?uuid={opening.uuid}",
                self.editor,
                {"body": "# Again", "language": "eng", "status": "published"},
            )
        self.assertEqual(1, mock_prerender.call_count)

        opening.refresh_from_db()
        self.assertEqual(Article.STATUS_PUBLISHED, opening.status)
        self.assertIsNotNone(opening.published_on)
        self.assertEqual("eng", opening.language)
        self.assertIn("Again", opening.body_html)
        self.assertEqual([call(self.org, self.helpdesk)], mr_mocks.calls["knowledge_index"])

        # publishing an already published article leaves when it was published alone
        published_on = nodes.published_on
        self.assertPost(endpoint_url + f"?uuid={nodes.uuid}", self.editor, {"status": "published"})
        nodes.refresh_from_db()
        self.assertEqual(published_on, nodes.published_on)

        # can't update an article in another workspace
        self.assertPost(endpoint_url + f"?uuid={other.uuid}", self.admin, {"title": "Won't work"}, status=404)

        # try an empty delete request
        self.assertDelete(
            endpoint_url, self.admin, errors={None: "URL must contain one of the following parameters: uuid"}
        )

        # try to delete a section with articles in it
        self.assertDelete(
            endpoint_url + f"?uuid={flows.uuid}",
            self.admin,
            errors={None: "A section with articles in it can't be deleted."},
        )

        # delete a published article, which is indexed so its chunks are dropped
        mr_mocks.calls["knowledge_index"].clear()
        self.assertDelete(endpoint_url + f"?uuid={opening.uuid}", self.admin)
        opening.refresh_from_db()
        self.assertFalse(opening.is_active)
        self.assertEqual([call(self.org, self.helpdesk)], mr_mocks.calls["knowledge_index"])

        # delete a section that's empty
        self.assertDelete(endpoint_url + f"?uuid={ticketing.uuid}", self.admin)
        ticketing.refresh_from_db()
        self.assertFalse(ticketing.is_active)

        # try to delete an article in another workspace
        self.assertDelete(endpoint_url + f"?uuid={other.uuid}", self.admin, status=404)

        # try to create once the helpdesk is full
        with patch.object(Article, "MAX_ARTICLES", 3):
            self.assertPost(
                endpoint_url,
                self.admin,
                {"title": "One Too Many"},
                errors={"non_field_errors": "Helpdesk can't have more than 3 articles."},
            )

        # nobody can use it if the workspace has no helpdesk
        self.helpdesk.is_active = False
        self.helpdesk.save(update_fields=("is_active",))

        self.assertGetNotPermitted(endpoint_url, [self.editor, self.admin])
