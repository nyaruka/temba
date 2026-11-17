from temba.orgs.models import OrgRole
from temba.tests import TembaTest
from temba.tickets.models import Team, Topic


class TeamTest(TembaTest):
    def test_create(self):
        sales = Topic.create(self.org, self.admin, "Sales")
        support = Topic.create(self.org, self.admin, "Support")
        team1 = Team.create(self.org, self.admin, "Sales & Support", topics=[sales, support])
        agent2 = self.create_user("tickets@textit.com")
        self.org.add_user(self.agent, OrgRole.AGENT, team=team1)
        self.org.add_user(agent2, OrgRole.AGENT, team=team1)

        self.assertEqual("Sales & Support", team1.name)
        self.assertEqual("Sales & Support", str(team1))
        self.assertEqual(f'<Team: id={team1.id} name="Sales & Support">', repr(team1))
        self.assertEqual({self.agent, agent2}, set(team1.get_users()))
        self.assertEqual({sales, support}, set(team1.topics.all()))
        self.assertFalse(team1.all_topics)

        # create an unrestricted team
        team2 = Team.create(self.org, self.admin, "Any Topic", all_topics=True)
        self.assertEqual(set(), set(team2.topics.all()))
        self.assertTrue(team2.all_topics)

        # try to create with invalid name
        with self.assertRaises(AssertionError):
            Team.create(self.org, self.admin, '"Support"')

        # try to create with name that already exists
        with self.assertRaises(AssertionError):
            Team.create(self.org, self.admin, "Sales & Support")

    def test_release(self):
        team1 = Team.create(self.org, self.admin, "Sales")
        self.org.add_user(self.agent, OrgRole.AGENT, team=team1)

        team1.release(self.admin)
        team1.refresh_from_db()

        self.assertIsNotNone(team1.deleted_on)
        self.assertTrue(team1.name.startswith("deleted-"))
        self.assertEqual(0, team1.get_users().count())

        # check agent was re-assigned to default team
        self.assertEqual({self.agent}, set(self.org.default_team.get_users()))

        # can't release system team
        with self.assertRaises(AssertionError):
            self.org.default_team.release(self.admin)
