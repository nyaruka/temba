from django.urls import reverse

from temba.tests import CRUDLTestMixin, TembaTest


class CallCRUDLTest(CRUDLTestMixin, TembaTest):
    def test_list(self):
        list_url = reverse("ivr.call_list")

        self.assertRequestDisallowed(list_url, [None, self.agent])
        response = self.assertListFetch(list_url, [self.editor, self.admin])

        # the temba-call-list component fetches the calls itself from the internal calls API
        self.assertContains(response, "temba-call-list")
        self.assertEqual(f"{reverse('api.internal.calls')}.json", response.context["list_url"])
        self.assertEqual([], list(response.context["object_list"]))
