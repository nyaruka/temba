from django.urls import reverse

from temba.tests import CRUDLTestMixin, TembaTest
from temba.tickets.models import Shortcut


class ShortcutCRUDLTest(TembaTest, CRUDLTestMixin):
    def test_create(self):
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

        self.assertCreateSubmit(
            create_url,
            self.admin,
            {"name": "Not Interested", "text": "We're not interested"},
            new_obj_query=Shortcut.objects.filter(name="Not Interested", text="We're not interested", is_system=False),
            success_status=302,
        )

    def test_update(self):
        shortcut = Shortcut.create(self.org, self.admin, "Planes", "Planes are...")
        Shortcut.create(self.org, self.admin, "Trains", "Trains are...")

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

        self.assertUpdateSubmit(update_url, self.admin, {"name": "Cars", "text": "Cars are..."}, success_status=302)

        shortcut.refresh_from_db()
        self.assertEqual(shortcut.name, "Cars")
        self.assertEqual(shortcut.text, "Cars are...")

    def test_delete(self):
        shortcut1 = Shortcut.create(self.org, self.admin, "Planes", "Planes are...")
        shortcut2 = Shortcut.create(self.org, self.admin, "Trains", "Trains are...")

        delete_url = reverse("tickets.shortcut_delete", args=[shortcut1.uuid])

        self.assertRequestDisallowed(delete_url, [None, self.agent, self.admin2])

        response = self.assertDeleteFetch(delete_url, [self.editor, self.admin])
        self.assertContains(response, "You are about to delete")

        response = self.assertDeleteSubmit(delete_url, self.admin2, object_unchanged=shortcut1)
        self.assertEqual(404, response.status_code)

        # submit to delete it
        response = self.assertDeleteSubmit(delete_url, self.admin, object_deactivated=shortcut1, success_status=302)

        # other shortcut unaffected
        shortcut2.refresh_from_db()
        self.assertTrue(shortcut2.is_active)

    def test_list(self):
        shortcut1 = Shortcut.create(self.org, self.admin, "Planes", "Planes are...")
        shortcut2 = Shortcut.create(self.org, self.admin, "Trains", "Trains are...")
        Shortcut.create(self.org2, self.admin, "Cars", "Other org")

        list_url = reverse("tickets.shortcut_list")

        self.assertRequestDisallowed(list_url, [None, self.agent])

        self.assertListFetch(list_url, [self.editor, self.admin], context_objects=[shortcut1, shortcut2])
