from unittest.mock import call

from django.urls import reverse

from temba.knowledge.models import KnowledgeSource
from temba.orgs.models import Org
from temba.tests import CRUDLTestMixin, TembaTest, mock_mailroom
from temba.tickets.models import Shortcut


class ShortcutCRUDLTest(TembaTest, CRUDLTestMixin):
    def enable_agents(self, org):
        org.features = [Org.FEATURE_AGENTS]
        org.save(update_fields=("features",))

    @mock_mailroom
    def test_create(self, mr_mocks):
        source = KnowledgeSource.get_system(self.org, KnowledgeSource.TYPE_SHORTCUTS)
        create_url = reverse("tickets.shortcut_create")

        self.assertRequestDisallowed(create_url, [None, self.agent])

        self.assertCreateFetch(create_url, [self.editor, self.admin], form_fields=("name", "text"))

        # try to create with empty values
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "", "text": ""},
            form_errors={"name": "This field is required.", "text": "This field is required."},
        )

        # try to create with name that is already taken
        Shortcut.create(self.org, self.admin, "Reboot", "Try switching it off and on again")

        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "reboot", "text": "Have you tried..."},
            form_errors={"name": "Must be unique."},
        )

        # try to create with name that has invalid characters
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "\\reboot", "text": "x"},
            form_errors={"name": "Cannot contain the character: \\"},
        )

        # try to create with name that is too long
        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "X" * 65, "text": "x"},
            form_errors={"name": "Ensure this value has at most 64 characters (it has 65)."},
        )

        response = self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Not Interested", "text": "We're not interested"},
            new_obj_query=Shortcut.objects.filter(name="Not Interested", text="We're not interested", is_system=False),
            success_status=302,
        )
        self.assertEqual(reverse("tickets.shortcut_list"), response.url)

        # mailroom asked to index the org's shortcuts, once for the one created above and once for this one
        self.assertEqual([call(self.org, source)] * 2, mr_mocks.calls["knowledge_index"])

        # for orgs with the agents feature we redirect to the fixed shortcuts page
        self.enable_agents(self.org)

        response = self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Old Reliable", "text": "Works every time"},
            new_obj_query=Shortcut.objects.filter(name="Old Reliable"),
            success_status=302,
        )
        self.assertEqual(reverse("knowledge.knowledgesource_shortcuts"), response.url)

    @mock_mailroom
    def test_update(self, mr_mocks):
        source = KnowledgeSource.get_system(self.org, KnowledgeSource.TYPE_SHORTCUTS)
        shortcut = Shortcut.create(self.org, self.admin, "Planes", "Planes are...")
        Shortcut.create(self.org, self.admin, "Trains", "Trains are...")
        mr_mocks.calls["knowledge_index"].clear()

        update_url = reverse("tickets.shortcut_update", args=[shortcut.uuid])

        self.assertRequestDisallowed(update_url, [None, self.agent, self.admin2])

        self.assertUpdateFetch(update_url, [self.editor, self.admin], form_fields=["name", "text"])

        # names must be unique (case-insensitive)
        self.assertUpdateSubmit(
            update_url,
            self.admin,
            {"name": "trains", "text": "Trains are..."},
            form_errors={"name": "Must be unique."},
            object_unchanged=shortcut,
        )

        response = self.assertUpdateSubmit(
            update_url, self.admin, {"name": "Cars", "text": "Cars are..."}, success_status=302
        )
        self.assertEqual(reverse("tickets.shortcut_list"), response.url)

        shortcut.refresh_from_db()
        self.assertEqual(shortcut.name, "Cars")
        self.assertEqual(shortcut.text, "Cars are...")

        # only the successful edit asks mailroom to index
        self.assertEqual([call(self.org, source)], mr_mocks.calls["knowledge_index"])

        # for orgs with the agents feature we redirect to the fixed shortcuts page
        self.enable_agents(self.org)

        response = self.assertUpdateSubmit(
            update_url, self.admin, {"name": "Boats", "text": "Boats are..."}, success_status=302
        )
        self.assertEqual(reverse("knowledge.knowledgesource_shortcuts"), response.url)

    @mock_mailroom
    def test_delete(self, mr_mocks):
        source = KnowledgeSource.get_system(self.org, KnowledgeSource.TYPE_SHORTCUTS)
        shortcut1 = Shortcut.create(self.org, self.admin, "Planes", "Planes are...")
        shortcut2 = Shortcut.create(self.org, self.admin, "Trains", "Trains are...")
        mr_mocks.calls["knowledge_index"].clear()

        delete_url = reverse("tickets.shortcut_delete", args=[shortcut1.uuid])

        self.assertRequestDisallowed(delete_url, [None, self.agent, self.admin2])

        response = self.assertDeleteFetch(delete_url, [self.editor, self.admin])
        self.assertContains(response, "You are about to delete")

        response = self.assertDeleteSubmit(delete_url, self.admin2, object_unchanged=shortcut1)
        self.assertEqual(404, response.status_code)

        # submit to delete it
        response = self.assertDeleteSubmit(delete_url, self.admin, object_deactivated=shortcut1, success_status=302)
        self.assertEqual(reverse("tickets.shortcut_list"), response.url)

        # other shortcut unaffected
        shortcut2.refresh_from_db()
        self.assertTrue(shortcut2.is_active)

        self.assertEqual([call(self.org, source)], mr_mocks.calls["knowledge_index"])

        # for orgs with the agents feature we redirect to the fixed shortcuts page
        self.enable_agents(self.org)

        response = self.assertDeleteSubmit(
            reverse("tickets.shortcut_delete", args=[shortcut2.uuid]),
            self.admin,
            object_deactivated=shortcut2,
            success_status=302,
        )
        self.assertEqual(reverse("knowledge.knowledgesource_shortcuts"), response.url)

    def test_list(self):
        shortcut1 = Shortcut.create(self.org, self.admin, "Planes", "Planes are...")
        shortcut2 = Shortcut.create(self.org, self.admin, "Trains", "Trains are...")
        Shortcut.create(self.org2, self.admin, "Cars", "Other org")

        list_url = reverse("tickets.shortcut_list")

        self.assertRequestDisallowed(list_url, [None, self.agent])

        response = self.assertListFetch(list_url, [self.editor, self.admin], context_objects=[shortcut1, shortcut2])

        # the search button is part of the tickets section menu so search has to be mounted here too
        self.assertContains(response, "<temba-ticket-search")
