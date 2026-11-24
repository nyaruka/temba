from django.test.utils import override_settings
from django.urls import reverse

from temba.tests import CRUDLTestMixin, TembaTest
from temba.tickets.models import Topic


class TopicCRUDLTest(TembaTest, CRUDLTestMixin):
    @override_settings(ORG_LIMIT_DEFAULTS={"topics": 2})
    def test_create(self):
        create_url = reverse("tickets.topic_create")

        self.assertRequestDisallowed(create_url, [None, self.agent])

        self.assertCreateFetch(create_url, [self.editor, self.admin], form_fields=("name",))

        # try to create with empty name
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": ""},
            form_errors={"name": "This field is required."},
        )

        # try to create with name that is too long
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "X" * 65},
            form_errors={"name": "Ensure this value has at most 64 characters (it has 65)."},
        )

        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Sales"},
            new_obj_query=Topic.objects.filter(name="Sales", is_system=False),
            success_status=302,
        )

        # try again with same name
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "sales"},
            form_errors={"name": "Must be unique."},
        )

        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Support"},
            new_obj_query=Topic.objects.filter(name="Support", is_system=False),
            success_status=302,
        )

        # check we get the limit warning when we've reached the limit
        response = self.requestView(create_url, self.admin)
        self.assertContains(response, "You have reached the per-workspace limit")

    def test_update(self):
        topic = Topic.create(self.org, self.admin, "Hot Topic")

        update_url = reverse("tickets.topic_update", args=[topic.uuid])

        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])

        response = self.assertUpdateFetch(update_url, [self.editor, self.admin], form_fields=["name"])

        # the edit dialog is where the topic is deleted from
        self.assertEqual(reverse("tickets.topic_delete", args=[topic.uuid]), response.context["delete_url"])
        self.assertContains(response, "Delete topic")

        # names must be unique (case-insensitive)
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "general"},
            form_errors={"name": "Must be unique."},
            object_unchanged=topic,
        )

        self.assertUpdateSubmit(update_url, self.admin, {"name": "Boring"}, success_status=302)

        topic.refresh_from_db()
        self.assertEqual(topic.name, "Boring")

        # can't edit a system topic
        self.assertRequestDisallowed(reverse("tickets.topic_update", args=[self.org.default_topic.uuid]), [self.admin])

    def test_delete(self):
        topic1 = Topic.create(self.org, self.admin, "Planes")
        topic2 = Topic.create(self.org, self.admin, "Trains")
        ticket = self.create_ticket(self.create_contact("Bob", urns=["twitter:bobby"]), topic=topic1)

        delete_url = reverse("tickets.topic_delete", args=[topic1.uuid])

        self.assertRequestDisallowed(delete_url, [None, self.agent, self.admin2])

        # deleting blocked for topic with tickets
        response = self.assertDeleteFetch(delete_url, [self.editor, self.admin])
        self.assertContains(response, "Sorry, the <b>Planes</b> topic can't be deleted")

        ticket.topic = topic2
        ticket.save(update_fields=("topic",))

        # try again...
        response = self.assertDeleteFetch(delete_url, [self.editor, self.admin])
        self.assertContains(response, "You are about to delete the <b>Planes</b> topic")

        response = self.assertDeleteSubmit(delete_url, self.admin, object_deactivated=topic1, success_status=302)

        # other topic unafected
        topic2.refresh_from_db()
        self.assertTrue(topic2.is_active)

        # we should have been redirected to the default topic
        self.assertEqual(f"/ticket/{self.org.default_topic.uuid}/", response.url)
