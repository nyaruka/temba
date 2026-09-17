from django.db.utils import IntegrityError

from temba.contacts.models import URN, ContactURN
from temba.tests import TembaTest


class ContactURNTest(TembaTest):
    def setUp(self):
        super().setUp()

    def test_get_display(self):
        urn = ContactURN.objects.create(
            org=self.org, scheme="tel", path="+250788383383", identity="tel:+250788383383", priority=50
        )
        self.assertEqual(urn.get_display(self.org), "0788 383 383")
        self.assertEqual(urn.get_display(self.org, formatted=False), "+250788383383")
        self.assertEqual(urn.get_display(self.org, international=True), "+250 788 383 383")
        self.assertEqual(urn.get_display(self.org, formatted=False, international=True), "+250788383383")

        # legacy all-digit whatsapp URNs still get friendly phone formatting
        urn = ContactURN.objects.create(
            org=self.org, scheme="whatsapp", path="12065551212", identity="whatsapp:12065551212", priority=50
        )
        self.assertEqual(urn.get_display(self.org), "(206) 555-1212")

        # a business-scoped whatsapp id (not all digits) is shown as-is (no phone formatting, no leading +)
        urn = ContactURN.objects.create(
            org=self.org, scheme="whatsapp", path="US.abcDEF123", identity="whatsapp:US.abcDEF123", priority=50
        )
        self.assertEqual(urn.get_display(self.org), "US.abcDEF123")
        self.assertEqual(urn.get_display(self.org, international=True), "US.abcDEF123")

        # use path for other schemes
        urn = ContactURN.objects.create(
            org=self.org, scheme="twitter", path="billy_bob", identity="twitter:billy_bob", priority=50
        )
        self.assertEqual(urn.get_display(self.org), "billy_bob")

        # unless there's a display property
        urn = ContactURN.objects.create(
            org=self.org,
            scheme="twitter",
            path="jimmy_john",
            identity="twitter:jimmy_john",
            priority=50,
            display="JIM",
        )
        self.assertEqual(urn.get_display(self.org), "JIM")

        urn = ContactURN.objects.create(
            org=self.org,
            scheme="telegram",
            path="100200300",
            identity="telegram:100200300",
            priority=50,
            display="JIM",
        )
        self.assertEqual(urn.get_display(self.org, formatted=False), "100200300")
        self.assertEqual(urn.get_display(self.org, formatted=True), "JIM")

    def test_empty_scheme_disallowed(self):
        with self.assertRaises(IntegrityError):
            ContactURN.objects.create(org=self.org, scheme="", path="1234", identity=":1234")

    def test_empty_path_disallowed(self):
        with self.assertRaises(IntegrityError):
            ContactURN.objects.create(org=self.org, scheme="ext", path="", identity="ext:")

    def test_identity_mismatch_disallowed(self):
        with self.assertRaises(IntegrityError):
            ContactURN.objects.create(org=self.org, scheme="ext", path="1234", identity="ext:5678")


class URNTest(TembaTest):
    def test_facebook_urn(self):
        self.assertTrue(URN.validate("facebook:ref:asdf"))

    def test_instagram_urn(self):
        self.assertTrue(URN.validate("instagram:12345678901234567"))

    def test_whatsapp_urn(self):
        # whatsapp holds either a phone number (all digits, legacy) or a business-scoped id (CC.alphanumeric)
        self.assertTrue(URN.validate("whatsapp:12065551212"))
        self.assertTrue(URN.validate("whatsapp:BR.1A2B3C4D5E6F7G8H9I0J"))
        self.assertTrue(URN.validate("whatsapp:US.abcDEF123"))

        # malformed values are still invalid
        self.assertFalse(URN.validate("whatsapp:+12065551212"))
        self.assertFalse(URN.validate("whatsapp:br.1A2B3C4D"))
        self.assertFalse(URN.validate("whatsapp:BR.abc-123"))

    def test_bsuid_urn(self):
        # valid BSUIDs: two-letter country code, dot, 1-128 alphanumerics
        self.assertTrue(URN.validate("bsuid:BR.1A2B3C4D5E6F7G8H9I0J"))
        self.assertTrue(URN.validate("bsuid:US.abcDEF123"))

        # invalid: lowercase country code, missing dot, non-alphanumeric, too long
        self.assertFalse(URN.validate("bsuid:br.1A2B3C4D"))
        self.assertFalse(URN.validate("bsuid:BRA.12345"))
        self.assertFalse(URN.validate("bsuid:BR12345"))
        self.assertFalse(URN.validate("bsuid:BR.abc-123"))
        self.assertFalse(URN.validate("bsuid:BR." + "a" * 129))

    def test_freshchat_urn(self):
        self.assertTrue(
            URN.validate("freshchat:c0534f78-b6e9-4f79-8853-11cedfc1f35b/c0534f78-b6e9-4f79-8853-11cedfc1f35b")
        )
        self.assertFalse(URN.validate("freshchat:+12065551212"))

    def test_from_parts(self):
        self.assertEqual(URN.from_parts("deleted", "12345"), "deleted:12345")
        self.assertEqual(URN.from_parts("tel", "12345"), "tel:12345")
        self.assertEqual(URN.from_parts("tel", "+12345"), "tel:+12345")
        self.assertEqual(URN.from_parts("tel", "(917) 992-5253"), "tel:(917) 992-5253")
        self.assertEqual(URN.from_parts("mailto", "a_b+c@d.com"), "mailto:a_b+c@d.com")
        self.assertEqual(URN.from_parts("twitterid", "2352362611", display="bobby"), "twitterid:2352362611#bobby")
        self.assertEqual(
            URN.from_parts("twitterid", "2352362611", query="foo=ba?r", display="bobby"),
            "twitterid:2352362611?foo=ba%3Fr#bobby",
        )

        self.assertEqual(URN.from_tel("+12345"), "tel:+12345")

        self.assertRaises(ValueError, URN.from_parts, "", "12345")
        self.assertRaises(ValueError, URN.from_parts, "tel", "")
        self.assertRaises(ValueError, URN.from_parts, "xxx", "12345")

    def test_to_parts(self):
        self.assertEqual(URN.to_parts("deleted:12345"), ("deleted", "12345", None, None))
        self.assertEqual(URN.to_parts("tel:12345"), ("tel", "12345", None, None))
        self.assertEqual(URN.to_parts("tel:+12345"), ("tel", "+12345", None, None))
        self.assertEqual(URN.to_parts("twitter:abc_123"), ("twitter", "abc_123", None, None))
        self.assertEqual(URN.to_parts("mailto:a_b+c@d.com"), ("mailto", "a_b+c@d.com", None, None))
        self.assertEqual(URN.to_parts("facebook:12345"), ("facebook", "12345", None, None))
        self.assertEqual(URN.to_parts("vk:12345"), ("vk", "12345", None, None))
        self.assertEqual(URN.to_parts("telegram:12345"), ("telegram", "12345", None, None))
        self.assertEqual(URN.to_parts("telegram:12345#foobar"), ("telegram", "12345", None, "foobar"))
        self.assertEqual(URN.to_parts("ext:Aa0()+,-.:=@;$_!*'"), ("ext", "Aa0()+,-.:=@;$_!*'", None, None))
        self.assertEqual(URN.to_parts("instagram:12345"), ("instagram", "12345", None, None))

        self.assertRaises(ValueError, URN.to_parts, "tel")
        self.assertRaises(ValueError, URN.to_parts, "tel:")  # missing scheme
        self.assertRaises(ValueError, URN.to_parts, ":12345")  # missing path
        self.assertRaises(ValueError, URN.to_parts, "x_y:123")  # invalid scheme
        self.assertRaises(ValueError, URN.to_parts, "xyz:{abc}")  # invalid path

    def test_normalize(self):
        # valid tel numbers
        self.assertEqual(URN.normalize("tel:0788383383", "RW"), "tel:+250788383383")
        self.assertEqual(URN.normalize("tel: +250788383383 ", "KE"), "tel:+250788383383")
        self.assertEqual(URN.normalize("tel:+250788383383", None), "tel:+250788383383")
        self.assertEqual(URN.normalize("tel:250788383383", None), "tel:+250788383383")
        self.assertEqual(URN.normalize("tel:2.50788383383E+11", None), "tel:+250788383383")
        self.assertEqual(URN.normalize("tel:2.50788383383E+12", None), "tel:+250788383383")
        self.assertEqual(URN.normalize("tel:(917)992-5253", "US"), "tel:+19179925253")
        self.assertEqual(URN.normalize("tel:19179925253", None), "tel:+19179925253")
        self.assertEqual(URN.normalize("tel:+62877747666", None), "tel:+62877747666")
        self.assertEqual(URN.normalize("tel:62877747666", "ID"), "tel:+62877747666")
        self.assertEqual(URN.normalize("tel:0877747666", "ID"), "tel:+62877747666")
        self.assertEqual(URN.normalize("tel:07531669965", "GB"), "tel:+447531669965")
        self.assertEqual(URN.normalize("tel:22658125926", ""), "tel:+22658125926")
        self.assertEqual(URN.normalize("tel:263780821000", "ZW"), "tel:+263780821000")
        self.assertEqual(URN.normalize("tel:+2203693333", ""), "tel:+2203693333")

        # un-normalizable tel numbers
        self.assertEqual(URN.normalize("tel:12345", "RW"), "tel:12345")
        self.assertEqual(URN.normalize("tel:0788383383", None), "tel:0788383383")
        self.assertEqual(URN.normalize("tel:0788383383", "ZZ"), "tel:0788383383")
        self.assertEqual(URN.normalize("tel:MTN", "RW"), "tel:mtn")

        # twitter handles remove @
        self.assertEqual(URN.normalize("twitter: @jimmyJO"), "twitter:jimmyjo")
        self.assertEqual(URN.normalize("twitterid:12345#@jimmyJO"), "twitterid:12345#jimmyjo")

        # email addresses
        self.assertEqual(URN.normalize("mailto: nAme@domAIN.cOm "), "mailto:name@domain.com")

        # external ids are case sensitive
        self.assertEqual(URN.normalize("ext: eXterNAL123 "), "ext:eXterNAL123")

        # whatsapp/bsuid - uppercase the two-letter country code prefix
        self.assertEqual(URN.normalize("bsuid:br.1A2B3C4D"), "bsuid:BR.1A2B3C4D")
        self.assertEqual(URN.normalize("bsuid:BR.1A2B3C4D"), "bsuid:BR.1A2B3C4D")
        self.assertEqual(URN.normalize("whatsapp:br.1A2B3C4D"), "whatsapp:BR.1A2B3C4D")
        self.assertEqual(URN.normalize("whatsapp:BR.1A2B3C4D"), "whatsapp:BR.1A2B3C4D")

    def test_validate(self):
        self.assertFalse(URN.validate("xxxx", None))  # un-parseable URNs don't validate

        # valid tel numbers
        self.assertTrue(URN.validate("tel:0788383383", "RW"))
        self.assertTrue(URN.validate("tel:+250788383383", "KE"))
        self.assertTrue(URN.validate("tel:+23761234567", "CM"))  # old Cameroon format
        self.assertTrue(URN.validate("tel:+237661234567", "CM"))  # new Cameroon format
        self.assertTrue(URN.validate("tel:+250788383383", None))

        # invalid tel numbers
        self.assertFalse(URN.validate("tel:0788383383", "ZZ"))  # invalid country
        self.assertFalse(URN.validate("tel:0788383383", None))  # no country
        self.assertFalse(URN.validate("tel:MTN", "RW"))
        self.assertFalse(URN.validate("tel:5912705", "US"))

        # twitter handles
        self.assertTrue(URN.validate("twitter:jimmyjo"))
        self.assertTrue(URN.validate("twitter:billy_bob"))
        self.assertFalse(URN.validate("twitter:jimmyjo!@"))
        self.assertFalse(URN.validate("twitter:billy bob"))

        # twitterid urns
        self.assertTrue(URN.validate("twitterid:12345#jimmyjo"))
        self.assertTrue(URN.validate("twitterid:12345#1234567"))
        self.assertFalse(URN.validate("twitterid:jimmyjo#1234567"))
        self.assertFalse(URN.validate("twitterid:123#a.!f"))

        # email addresses
        self.assertTrue(URN.validate("mailto:abcd+label@x.y.z.com"))
        self.assertFalse(URN.validate("mailto:@@@"))

        # viber urn
        self.assertTrue(URN.validate("viber:dKPvqVrLerGrZw15qTuVBQ=="))

        # facebook, telegram, vk and instagram URN paths must be integers
        self.assertTrue(URN.validate("telegram:12345678901234567"))
        self.assertFalse(URN.validate("telegram:abcdef"))
        self.assertTrue(URN.validate("facebook:12345678901234567"))
        self.assertFalse(URN.validate("facebook:abcdef"))
        self.assertTrue(URN.validate("vk:12345678901234567"))
        self.assertTrue(URN.validate("instagram:12345678901234567"))
        self.assertFalse(URN.validate("instagram:abcdef"))
