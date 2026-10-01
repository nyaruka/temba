from django.test.utils import override_settings

from temba.orgs.models import Org, OrgRole
from temba.tests import TembaTest, matchers
from temba.tickets.models import Team, Topic


class TopicTest(TembaTest):
    def test_create(self):
        topic1 = Topic.create(self.org, self.admin, "Sales")

        self.assertEqual("Sales", topic1.name)
        self.assertEqual("Sales", str(topic1))
        self.assertEqual(f'<Topic: id={topic1.id} name="Sales">', repr(topic1))
        self.assertEqual({"uuid": matchers.UUIDString(version=4), "name": "Sales"}, topic1.as_engine_ref())

        # try to create with invalid name
        with self.assertRaises(AssertionError):
            Topic.create(self.org, self.admin, '"Support"')

        # try to create with name that already exists
        with self.assertRaises(AssertionError):
            Topic.create(self.org, self.admin, "Sales")

    @override_settings(ORG_LIMIT_DEFAULTS={"topics": 3})
    def test_import(self):
        def _import(definition, preview=False):
            return Topic.import_def(self.org, self.admin, definition, preview=preview)

        # preview import as dependency ref from flow inspection
        topic1, result = _import({"uuid": "0c81be38-8481-4a20-92ca-67e9a5617e77", "name": "Sales"}, preview=True)
        self.assertIsNone(topic1)
        self.assertEqual(Topic.ImportResult.CREATED, result)
        self.assertEqual(0, Topic.objects.filter(name="Sales").count())

        # import as dependency ref from flow inspection
        topic1, result = _import({"uuid": "0c81be38-8481-4a20-92ca-67e9a5617e77", "name": "Sales"})
        self.assertNotEqual("0c81be38-8481-4a20-92ca-67e9a5617e77", str(topic1.uuid))  # UUIDs never trusted
        self.assertEqual("Sales", topic1.name)
        self.assertEqual(Topic.ImportResult.CREATED, result)

        # preview import same definition again
        topic2, result = _import({"uuid": "0c81be38-8481-4a20-92ca-67e9a5617e77", "name": "Sales"}, preview=True)
        self.assertEqual(topic1, topic2)
        self.assertEqual(Topic.ImportResult.MATCHED, result)

        # import same definition again
        topic2, result = _import({"uuid": "0c81be38-8481-4a20-92ca-67e9a5617e77", "name": "Sales"})
        self.assertEqual(topic1, topic2)
        self.assertEqual("Sales", topic2.name)
        self.assertEqual(Topic.ImportResult.MATCHED, result)

        # import different UUID but same name
        topic3, result = _import({"uuid": "89a2265b-0caf-478f-837c-187fc8c32b46", "name": "Sales"})
        self.assertEqual(topic2, topic3)
        self.assertEqual(Topic.ImportResult.MATCHED, result)

        topic4 = Topic.create(self.org, self.admin, "Support")

        # import with UUID of existing thing (i.e. importing an export from this workspace)
        topic5, result = _import({"uuid": str(topic4.uuid), "name": "Support"})
        self.assertEqual(topic4, topic5)
        self.assertEqual(Topic.ImportResult.MATCHED, result)

        # preview import with UUID of existing thing with different name
        topic6, result = _import({"uuid": str(topic4.uuid), "name": "Help"}, preview=True)
        self.assertEqual(topic5, topic6)
        self.assertEqual("Support", topic6.name)  # not actually updated
        self.assertEqual(Topic.ImportResult.UPDATED, result)

        # import with UUID of existing thing with different name
        topic6, result = _import({"uuid": str(topic4.uuid), "name": "Help"})
        self.assertEqual(topic5, topic6)
        self.assertEqual("Help", topic6.name)  # updated
        self.assertEqual(Topic.ImportResult.UPDATED, result)

        # import with UUID of existing thing and name that conflicts with another existing thing
        topic7, result = _import({"uuid": str(topic4.uuid), "name": "Sales"})
        self.assertEqual(topic6, topic7)
        self.assertEqual("Sales 2", topic7.name)  # updated with suffix to make it unique
        self.assertEqual(Topic.ImportResult.UPDATED, result)

        # import definition of default topic from other workspace
        topic8, result = _import({"uuid": "bfacf01f-50d5-4236-9faa-7673bb4a9520", "name": "General"})
        self.assertEqual(self.org.default_topic, topic8)
        self.assertEqual(Topic.ImportResult.MATCHED, result)

        # import definition of default topic from this workspace
        topic9, result = _import({"uuid": str(self.org.default_topic.uuid), "name": "General"})
        self.assertEqual(self.org.default_topic, topic9)
        self.assertEqual(Topic.ImportResult.MATCHED, result)

        # import definition of default topic from this workspace... but with different name
        topic10, result = _import({"uuid": str(self.org.default_topic.uuid), "name": "Default"})
        self.assertEqual(self.org.default_topic, topic10)
        self.assertEqual("General", topic10.name)  # unchanged
        self.assertEqual(Topic.ImportResult.MATCHED, result)

        # import definition with name that can be cleaned and then matches existing
        topic11, result = _import({"uuid": "e694bad8-9cca-4efd-9f07-cb13248ed5e8", "name": " Sales\0 "})
        self.assertEqual("Sales", topic11.name)
        self.assertEqual(Topic.ImportResult.MATCHED, result)

        # import definition with name that can be cleaned and created new
        topic12, result = _import({"uuid": "c537ad58-ab2e-4b3a-8677-2766a2d14efe", "name": ' "Testing" '})
        self.assertEqual("'Testing'", topic12.name)
        self.assertEqual(Topic.ImportResult.CREATED, result)

        # try to import with name that can't be cleaned to something valid
        topic13, result = _import({"uuid": "c537ad58-ab2e-4b3a-8677-2766a2d14efe", "name": "  "})
        self.assertIsNone(topic13)
        self.assertEqual(Topic.ImportResult.IGNORED_INVALID, result)

        # import with UUID of existing thing and invalid name which will be ignored
        topic14, result = _import({"uuid": str(topic4.uuid), "name": "  "})
        self.assertEqual(topic4, topic14)
        self.assertEqual(Topic.ImportResult.MATCHED, result)

        # try to import new now that we've reached org limit
        topic15, result = _import({"uuid": "bef5f64c-0ad5-4ee0-9c9f-b3f471ec3b0c", "name": "Yet More"})
        self.assertIsNone(topic15)
        self.assertEqual(Topic.ImportResult.IGNORED_LIMIT_REACHED, result)

    def test_get_accessible(self):
        topic1 = Topic.create(self.org, self.admin, "Sales")
        topic2 = Topic.create(self.org, self.admin, "Support")
        team1 = Team.create(self.org, self.admin, "Sales & Support", topics=[topic1, topic2])
        team2 = Team.create(self.org, self.admin, "Nothing", topics=[])
        agent2 = self.create_user("agent2@textit.com")
        self.org.add_user(agent2, OrgRole.AGENT, team=team1)
        agent3 = self.create_user("agent3@textit.com")
        self.org.add_user(agent3, OrgRole.AGENT, team=team2)

        self.assertEqual({self.org.default_topic, topic1, topic2}, set(Topic.get_accessible(self.org, self.admin)))
        self.assertEqual({self.org.default_topic, topic1, topic2}, set(Topic.get_accessible(self.org, self.agent)))
        self.assertEqual({topic1, topic2}, set(Topic.get_accessible(self.org, agent2)))
        self.assertEqual(set(), set(Topic.get_accessible(self.org, agent3)))
        self.assertEqual(
            {self.org.default_topic, topic1, topic2}, set(Topic.get_accessible(self.org, self.customer_support))
        )

        # members of the org's admin groups can access all topics without a membership
        group_admin = self.create_user("groupadmin@textit.com")
        self.assertEqual(set(), set(Topic.get_accessible(self.org, group_admin)))

        self.create_admin_group("Global Admins", orgs=[self.org], users=[group_admin])
        org = Org.objects.get(id=self.org.id)  # fresh instance without cached memberships
        self.assertEqual({self.org.default_topic, topic1, topic2}, set(Topic.get_accessible(org, group_admin)))

    def test_release(self):
        topic1 = Topic.create(self.org, self.admin, "Sales")
        topic2 = Topic.create(self.org, self.admin, "Support")
        flow = self.create_flow("Test")
        flow.topic_dependencies.add(topic1)
        team = Team.create(self.org, self.admin, "Sales & Support", topics=[topic1, topic2])
        ticket = self.create_ticket(self.create_contact("Ann"), topic=topic1)
        self.create_ticket(self.create_contact("Bob"), topic=topic2)

        # can't release a topic with tickets
        with self.assertRaises(AssertionError):
            topic1.release(self.admin)

        ticket.delete()

        topic1.release(self.admin)

        self.assertFalse(topic1.is_active)
        self.assertTrue(topic1.name.startswith("deleted-"))

        # topic should be removed from team
        self.assertEqual({topic2}, set(team.topics.all()))

        # counts should be deleted
        self.assertEqual(0, self.org.counts.filter(scope__startswith=f"tickets:O:{topic1.id}:").count())
        self.assertEqual(1, self.org.counts.filter(scope__startswith=f"tickets:O:{topic2.id}:").count())

        # flow should be flagged as having issues
        flow.refresh_from_db()
        self.assertTrue(flow.has_issues)

        # can't release system topic
        with self.assertRaises(AssertionError):
            self.org.default_topic.release(self.admin)

        # can't release a topic with tickets
        ticket = self.create_ticket(self.create_contact("Bob"), topic=topic1)
        with self.assertRaises(AssertionError):
            topic1.release(self.admin)
