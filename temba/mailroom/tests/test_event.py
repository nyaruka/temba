import base64
from datetime import timedelta
from uuid import UUID

from boto3.dynamodb.types import Binary

from django.test import override_settings

from temba.mailroom.events import Event
from temba.tests import TembaTest, cleanup
from temba.utils import dynamo


class EventTest(TembaTest):
    @override_settings(RETENTION_PERIODS={"channellog": timedelta(days=3650)})
    @cleanup(dynamodb=True)
    def test_get_by_contact(self):
        contact = self.create_contact("Jim", phone="+593979111111", uuid="7e8ff9aa-4b60-49e2-81a6-e79c92635c1e")

        items = [
            {
                "PK": "con#b3ceb401-c9ce-4f4b-b1e7-ed87d77750ad",  # different contact
                "SK": "evt#019880eb-e422-7d67-8967-adec64636000",
                "OrgID": self.org.id,
                "Data": {
                    "type": "contact_language_changed",
                    "created_on": "2025-08-06T19:46:39.778889794Z",
                    "language": "spa",
                },
            },
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019880eb-e422-7d67-993f-cdec64636001",  # 1: (last char is 1...5)
                "OrgID": self.org.id,
                "Data": {
                    "type": "contact_language_changed",
                    "created_on": "2025-08-06T19:46:39.778889794Z",
                    "language": "spa",
                    "_user": {"uuid": str(self.admin.uuid), "name": "Andrew"},  # name wrong
                },
            },
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019880eb-e488-7652-beb6-0051d9cd6002",  # 2
                "OrgID": self.org.id,
                "Data": {
                    "type": "contact_field_changed",
                    "created_on": "2025-08-06T19:46:39.880430294Z",
                    "field": {"key": "age", "name": "Age"},
                    "value": {"text": "44"},
                    "_user": {"uuid": "e99c9705-8cc3-4063-8c54-fa702cbac867", "name": "Jimmy"},  # user no longer exists
                },
            },
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019880eb-e488-76d2-a8c4-872e95772003",  # 3
                "OrgID": self.org.id,
                "Data": {
                    "type": "contact_groups_changed",
                    "created_on": "2025-08-06T19:46:39.880448169Z",  # less than 1ms after previous event
                    "groups_added": [{"uuid": "fac9a1bd-6db5-4efb-8899-097acda87f96", "name": "Youth"}],
                    "_user": None,  # in theory shouldn't happen but who knows
                },
            },
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019880eb-e4f1-761b-bc99-750003cf8004",  # 4
                "OrgID": self.org.id,
                "Data": {
                    "type": "msg_received",
                    "created_on": "2025-08-06T19:46:39.985439836Z",
                    "msg": {
                        "text": "Hello?",
                        "attachments": [
                            {"content_type": "image/jpeg", "url": "https://example.com/004.jpg"}  # old format
                        ],
                    },
                },
            },
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019880eb-e4f1-761b-bc99-750003cf8004#del",  # delete tag for event 4
                "OrgID": self.org.id,
                "Data": {
                    "created_on": "2025-09-08T19:46:39.985439836Z",
                    "by_contact": True,
                },
            },
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019880eb-e555-7ce9-9ea3-95bf693ee005",  # 5
                "OrgID": self.org.id,
                "Data": {
                    "type": "contact_name_changed",
                    "created_on": "2025-08-06T19:46:40.085871336Z",
                    "name": "Robert",
                },
            },
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#01988abd-1dad-7309-b8b4-adb8380ef006",  # 6
                "OrgID": self.org.id,
                "Data": {
                    "type": "contact_status_changed",
                    "created_on": "2025-08-06T19:47:40.085871336Z",
                    "status": "blocked",
                },
            },
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019a9336-9228-71f0-becb-a56435927007",  # 7
                "OrgID": self.org.id,
                "Data": {
                    "type": "msg_created",
                    "created_on": "2025-11-17T19:06:58.472135Z",
                    "msg": {  # no channel or URN
                        "text": "Oops",
                        "attachments": ["image/jpeg:https://example.com/007.jpg"],  # new format
                    },
                    "unsendable_reason": "no_route",
                },
            },
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019a9336-9228-73e8-b4f5-3a2b42593008",  # 8
                "OrgID": self.org.id,
                "Data": {
                    "type": "msg_created",
                    "created_on": "2025-11-17T19:06:58.472259Z",
                    "msg": {
                        "text": "Trying again",
                        "channel": {"uuid": str(self.channel.uuid), "name": self.channel.name},
                    },
                },
            },
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019a9336-9228-73e8-b4f5-3a2b42593008#sts",  # status tag for event 8
                "OrgID": self.org.id,
                "Data": {
                    "created_on": "2025-11-17T19:07:58.472259Z",
                    "status": "wired",
                },
            },
        ]

        with dynamo.HISTORY.batch_writer() as writer:
            for item in items:
                writer.put_item(item)

        self.assert_get_by_contact(
            contact,
            self.admin,
            before=UUID("019880eb-e555-7ce9-9ea3-95bf693ee005"),  # event 5 (exclusive)
            limit=5,
            expected=[
                {
                    "uuid": "019880eb-e4f1-761b-bc99-750003cf8004",
                    "type": "msg_received",
                    "created_on": "2025-08-06T19:46:39.985439836Z",
                    "msg": {
                        "text": "Hello?",
                        "attachments": ["image/jpeg:https://example.com/004.jpg"],  # converted
                    },
                    "_deleted": {"created_on": "2025-09-08T19:46:39.985439836Z", "by_contact": True},  # injected
                },
                {
                    "uuid": "019880eb-e488-76d2-a8c4-872e95772003",
                    "type": "contact_groups_changed",
                    "created_on": "2025-08-06T19:46:39.880448169Z",
                    "groups_added": [{"uuid": "fac9a1bd-6db5-4efb-8899-097acda87f96", "name": "Youth"}],
                    "_user": None,
                },
                {
                    "uuid": "019880eb-e488-7652-beb6-0051d9cd6002",
                    "type": "contact_field_changed",
                    "created_on": "2025-08-06T19:46:39.880430294Z",
                    "field": {"key": "age", "name": "Age"},
                    "value": {"text": "44"},
                    "_user": None,  # cleared
                },
                {
                    "uuid": "019880eb-e422-7d67-993f-cdec64636001",
                    "type": "contact_language_changed",
                    "created_on": "2025-08-06T19:46:39.778889794Z",
                    "language": "spa",
                    "_user": {"uuid": str(self.admin.uuid), "name": "Andy", "avatar": None},  # refreshed
                },
            ],
        )

        # limit to 3 items
        self.assert_get_by_contact(
            contact,
            self.admin,
            before=UUID("019880eb-e555-7ce9-9ea3-95bf693ee005"),  # event 5 (exclusive)
            limit=3,
            expected=[
                "019880eb-e4f1-761b-bc99-750003cf8004",
                "019880eb-e488-76d2-a8c4-872e95772003",
                "019880eb-e488-7652-beb6-0051d9cd6002",
            ],
        )

        # get events after event 6 (returned order is now ascending)
        self.assert_get_by_contact(
            contact,
            self.admin,
            after=UUID("01988abd-1dad-7309-b8b4-adb8380ef006"),  # event 6 (exclusive)
            limit=5,
            expected=[
                {
                    "uuid": "019a9336-9228-71f0-becb-a56435927007",
                    "type": "msg_created",
                    "created_on": "2025-11-17T19:06:58.472135Z",
                    "msg": {"text": "Oops", "attachments": ["image/jpeg:https://example.com/007.jpg"]},
                    "unsendable_reason": "no_route",
                },
                {
                    "uuid": "019a9336-9228-73e8-b4f5-3a2b42593008",
                    "type": "msg_created",
                    "created_on": "2025-11-17T19:06:58.472259Z",
                    "msg": {
                        "text": "Trying again",
                        "channel": {"uuid": str(self.channel.uuid), "name": "Test Channel"},
                    },
                    "_status": {"created_on": "2025-11-17T19:07:58.472259Z", "status": "wired"},
                },
            ],
        )

        # try with user that can't view channel logs
        self.assert_get_by_contact(
            contact,
            self.editor,
            after=UUID("01988abd-1dad-7309-b8b4-adb8380ef006"),  # event 6 (exclusive)
            limit=5,
            expected=[
                {
                    "uuid": "019a9336-9228-71f0-becb-a56435927007",
                    "type": "msg_created",
                    "created_on": "2025-11-17T19:06:58.472135Z",
                    "msg": {"text": "Oops", "attachments": ["image/jpeg:https://example.com/007.jpg"]},
                    "unsendable_reason": "no_route",
                },
                {
                    "uuid": "019a9336-9228-73e8-b4f5-3a2b42593008",
                    "type": "msg_created",
                    "created_on": "2025-11-17T19:06:58.472259Z",
                    "msg": {
                        "text": "Trying again",
                        "channel": {"uuid": str(self.channel.uuid), "name": "Test Channel"},
                    },
                    "_status": {"created_on": "2025-11-17T19:07:58.472259Z", "status": "wired"},
                },
            ],
        )

    @cleanup(dynamodb=True)
    def test_get_by_contact_ticket_filtering(self):
        contact = self.create_contact(
            name="Joe Blow", urns=["twitter:blow80", "tel:+250781111111"], uuid="7e8ff9aa-4b60-49e2-81a6-e79c92635c1e"
        )

        items = [
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019a9336-9228-71f0-becb-a56435927677",
                "OrgID": self.org.id,
                "Data": {
                    "type": "contact_urns_changed",
                    "created_on": "2025-11-17T19:06:58.472135Z",
                    "urns": ["twitter:blow80", "tel:+250781111111", "twitter:joey"],
                },
            },
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019a9336-9228-73e8-b4f5-3a2b42593bb0",
                "OrgID": self.org.id,
                "Data": {
                    "type": "contact_field_changed",
                    "created_on": "2025-11-17T19:06:58.472259Z",
                    "field": {"key": "age", "name": "Age"},
                    "value": None,
                },
            },
            {  # open ticket #1
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019a9336-9228-75c8-8824-0dd4f9484be9",
                "OrgID": self.org.id,
                "Data": {
                    "type": "ticket_opened",
                    "created_on": "2025-11-17T19:06:58.472386Z",
                    "ticket": {
                        "uuid": "01994f4f-45ba-7f25-a785-b52e19b16c6b",
                        "status": "open",
                        "topic": {"uuid": "0d261518-d7d6-410d-bbae-0ef822d8f865", "name": "General"},
                    },
                },
            },
            {  # assign ticket #1
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019a9336-9228-77b8-805c-facb06b1af7c",
                "OrgID": self.org.id,
                "Data": {
                    "type": "ticket_assignee_changed",
                    "created_on": "2025-11-17T19:06:58.472509Z",
                    "ticket_uuid": "01994f4f-45ba-7f25-a785-b52e19b16c6b",
                    "assignee": None,
                },
            },
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019a9336-9228-79a0-9f72-232125ced67d",
                "OrgID": self.org.id,
                "Data": {
                    "type": "contact_language_changed",
                    "created_on": "2025-11-17T19:06:58.472633Z",
                    "language": "spa",
                },
            },
            {  # close ticket #1
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019a9336-9228-7b7d-b068-89df0c04df2f",
                "OrgID": self.org.id,
                "Data": {
                    "type": "ticket_closed",
                    "created_on": "2025-11-17T19:06:58.472755Z",
                    "ticket_uuid": "01994f4f-45ba-7f25-a785-b52e19b16c6b",
                },
            },
            {
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019a9336-9228-7d59-b7c2-25c3d7091357",
                "OrgID": self.org.id,
                "Data": {
                    "type": "contact_field_changed",
                    "created_on": "2025-11-17T19:06:58.472876Z",
                    "field": {"key": "gender", "name": "Gender"},
                    "value": {"text": "M"},
                },
            },
            {  # open ticket #2
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019a9336-9228-7f2e-bb18-26c5f392fec5",
                "OrgID": self.org.id,
                "Data": {
                    "type": "ticket_opened",
                    "created_on": "2025-11-17T19:06:58.472996Z",
                    "ticket": {
                        "uuid": "01994f50-ecb1-7b96-944e-64bcbe0cbdd2",
                        "status": "open",
                        "topic": {"uuid": "472a7a73-96cb-4736-b567-056d987cc5b4", "name": "Weather"},
                    },
                },
            },
            {  # note added to ticket #2
                "PK": "con#7e8ff9aa-4b60-49e2-81a6-e79c92635c1e",
                "SK": "evt#019a9336-9229-71c1-a6f9-695b374c13a3",
                "OrgID": self.org.id,
                "Data": {
                    "type": "ticket_note_added",
                    "created_on": "2025-11-17T19:06:58.473117Z",
                    "ticket_uuid": "01994f50-ecb1-7b96-944e-64bcbe0cbdd2",
                    "note": "This looks important!",
                },
            },
        ]
        with dynamo.HISTORY.batch_writer() as writer:
            for item in items:
                writer.put_item(item)

        # by default we only include basic ticket event types
        self.assert_get_by_contact(
            contact,
            self.admin,
            before=UUID("019a9dc5-b384-7b2d-a1e1-a315a2ebe926"),  # in the future
            expected=[
                "019a9336-9228-7f2e-bb18-26c5f392fec5",  # ticket_opened for ticket 2
                "019a9336-9228-7d59-b7c2-25c3d7091357",
                "019a9336-9228-7b7d-b068-89df0c04df2f",  # ticket_closed for ticket 1
                "019a9336-9228-79a0-9f72-232125ced67d",
                "019a9336-9228-75c8-8824-0dd4f9484be9",  # ticket_opened for ticket 1
                "019a9336-9228-73e8-b4f5-3a2b42593bb0",
                "019a9336-9228-71f0-becb-a56435927677",
            ],
        )

        # if we specify ticket 1 then we get only events for that ticket
        self.assert_get_by_contact(
            contact,
            self.admin,
            before=UUID("019a9dc5-b384-7b2d-a1e1-a315a2ebe926"),  # in the future
            ticket=UUID("01994f4f-45ba-7f25-a785-b52e19b16c6b"),
            expected=[
                "019a9336-9228-7d59-b7c2-25c3d7091357",
                "019a9336-9228-7b7d-b068-89df0c04df2f",  # ticket_closed for ticket 1
                "019a9336-9228-79a0-9f72-232125ced67d",
                "019a9336-9228-77b8-805c-facb06b1af7c",  # ticket_assignee_changed for ticket 1
                "019a9336-9228-75c8-8824-0dd4f9484be9",  # ticket_opened for ticket 1
                "019a9336-9228-73e8-b4f5-3a2b42593bb0",
                "019a9336-9228-71f0-becb-a56435927677",
            ],
        )

        # likewise for ticket 2
        self.assert_get_by_contact(
            contact,
            self.admin,
            before=UUID("019a9dc5-b384-7b2d-a1e1-a315a2ebe926"),  # in the future
            ticket=UUID("01994f50-ecb1-7b96-944e-64bcbe0cbdd2"),
            expected=[
                "019a9336-9229-71c1-a6f9-695b374c13a3",  # ticket_note_added for ticket 2
                "019a9336-9228-7f2e-bb18-26c5f392fec5",  # ticket_opened for ticket 2
                "019a9336-9228-7d59-b7c2-25c3d7091357",
                "019a9336-9228-79a0-9f72-232125ced67d",
                "019a9336-9228-73e8-b4f5-3a2b42593bb0",
                "019a9336-9228-71f0-becb-a56435927677",
            ],
        )

    def test_from_item(self):
        contact = self.create_contact("Jim", phone="+593979111111")
        event = Event._from_item(
            contact,
            {
                "PK": "con#6393abc0-283d-4c9b-a1b3-641a035c34bf",
                "SK": "evt#01969b47-2c93-76f8-8f41-6b2d9f33d623",
                "OrgID": self.org.id,
                "TTL": 1747571456,
                "Data": {
                    "type": "contact_field_changed",
                    "created_on": "2025-05-04T12:30:56.123456789Z",
                    "field": {"key": "age", "name": "Age"},
                    "value": {"text": "44"},
                },
            },
        )
        self.assertEqual(
            {
                "uuid": "01969b47-2c93-76f8-8f41-6b2d9f33d623",
                "type": "contact_field_changed",
                "created_on": "2025-05-04T12:30:56.123456789Z",
                "field": {"key": "age", "name": "Age"},
                "value": {"text": "44"},
            },
            event,
        )

        event = Event._from_item(
            contact,
            {
                "PK": "con#6393abc0-283d-4c9b-a1b3-641a035c34bf",
                "SK": "evt#01969b47-672b-76f8-bebe-b4a1f677cf4c",
                "OrgID": self.org.id,
                "TTL": 1747571471,
                "Data": {"type": "session_triggered"},
                "DataGZ": Binary(
                    base64.b64decode(
                        "H4sIAAAAAAAA/6RVTW/cNhD9KwKvFVt+U9KpToC0RdGLm0PiNBCG5HBDRCu5EmXHCfa/F9TKGzdNiwAFdJBI4s17bx5Hn8i6pkA6wnhrWqcsNVY4ak1sqEOH1Cng0Vjro/KkJvnhFklHFlyWNI19ntPhgDMGUhM/I2QM/TSSjggmNGWaMvWSi07yjvPvuZBKG9u0N6QmS8bbfq/tpXLG20AjMEOVNpK2AiQNRjXgjHLeO1KTOEz3pLswdtZHFhpJI/ctVZx72poYqNecg/IRGlNojXAsjK/xkJY8Q07TWL0oSKea+GnM4PNCujcX2EawqFshqZSmwHpDnfSBQtTWeuaCcs1n2GeTI6e3NcEPfliLJQvpPp1qMq9jv6zHI8wPhfJeaHv9u02MUcYp4y8Z67anmBMTDqEgEfA53W2k+zy9x7GsZfyQSUdevXpFX79+TW9uboqWmOYl92dalzPPcCx7M9z3ochPZw777i/VkO6wSmN1gAXcVI4uGfKGsL+Q63sYA1R/rIxJrH5NBxhS9Tzlh5KGM86/HzmdanKYp/X2bPFu2u/rfIcP1dUaEo4eSf3ovQAIgkdDJXOWKuE1dcFGyp0VzHOtGm7Jqb4APSlV/YZHh/PyGSzYGFVjBW2FbKjSItI2yIaKqHUTEZoW2da7cnrPZk0GGA8rHAo6jgdSFpbcL4jjpWNm65h4yXXHVMf0zZM44Fj9DOVKbP4UD9eFdOc2FqE5HfHjNJazV0eck4cfflrhAf5c01CozyVAb0jGofuOC2a01lxwUTIBHt00ve84F0JKpbQ2xtqmhPEIachT53D88Qj+/YDHad6q3aeccS4b/btHWm8vDjlojYs2UucFUNVYScF6S4VWgbfCeoVyi9Z+8XaRV8NQXfm8hf2C1XhQyrOW2pYHqrQE2tq2pWBZCFIyKZnZoojLOuQt2yKCz9O8XQrIeJjKXSFlkuxf/TB5GNJHDPv6f04YYfcJU/qBH/IMpBvXYahJGm/XfIbYJYgX59I1GaeAj3MoaudaZ4Fap5Eq7SVtIkNquFPYagyRSVKTOxjWAiKVkcoIpYzUQm9Gwd00p4y9n4Z/CLs+T8mvabv+hgEqxLfLe7HzqJ5vPP6XyjLcT6evZfnLPwfncv9ztJ45KhhXIXhrWauKOe/SkqfzOLyFGcfcfwnAdCPPAIA20tg4oaRXbYya1ARGjwVhIR1/8tUvafTY7yaw0+mvAAAA//+R/as+0wYAAA=="
                    )
                ),
            },
        )
        self.assertEqual("01969b47-672b-76f8-bebe-b4a1f677cf4c", event["uuid"])
        self.assertEqual("session_triggered", event["type"])
        self.assertEqual({"uuid": "b7cf0d83-f1c9-411c-96fd-c511a4cfa86d", "name": "Registration Flow"}, event["flow"])

    def test_redact_for_org(self):
        from temba.contacts.models import URN, ContactURN

        event = {
            "type": Event.TYPE_CONTACT_URNS_CHANGED,
            "urns": ["tel:+123456789", "whatsapp:JM.2335234000556455"],
        }
        masked = [
            URN.from_parts(URN.TEL_SCHEME, ContactURN.ANON_MASK),
            URN.from_parts(URN.WHATSAPP_SCHEME, ContactURN.ANON_MASK),
        ]

        with self.anonymous(self.org):
            redacted = Event.redact_for_org(self.org, event)
            self.assertEqual(masked, redacted["urns"])
            # temba-contact-chat renders URNs via urn.split(':')[1]
            for urn in redacted["urns"]:
                self.assertIn(":", urn)
                self.assertEqual(ContactURN.ANON_MASK, urn.split(":")[1])

            malformed = Event.redact_for_org(self.org, {"type": Event.TYPE_CONTACT_URNS_CHANGED, "urns": ["********"]})
            self.assertEqual([URN.from_parts(URN.EXTERNAL_SCHEME, ContactURN.ANON_MASK)], malformed["urns"])

        self.assertEqual(
            ["tel:+123456789", "whatsapp:JM.2335234000556455"],
            Event.redact_for_org(self.org, event)["urns"],
        )

    def assert_get_by_contact(self, contact, user, *, after=None, before=None, limit=50, ticket=None, expected: list):
        fetched = Event.get_by_contact(contact, user, after=after, before=before, ticket=ticket, limit=limit)

        if expected and isinstance(expected[0], str):
            self.assertEqual(expected, [e["uuid"] for e in fetched])
        else:
            self.assertEqual(expected, [e for e in fetched])
