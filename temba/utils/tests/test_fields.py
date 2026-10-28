import re

from django import forms
from django.contrib.auth.models import Group
from django.db.models.fields import BLANK_CHOICE_DASH
from django.forms import ValidationError
from django.test import TestCase

from temba.utils.fields import ExternalURLField, NameValidator, SelectWidget


class TestFields(TestCase):
    def test_name_validator(self):
        cases = (
            (" ", "Cannot begin or end with whitespace."),
            (" hello", "Cannot begin or end with whitespace."),
            ("hello\t", "Cannot begin or end with whitespace."),
            ('hello "', 'Cannot contain the character: "'),
            ("hello \\", "Cannot contain the character: \\"),
            ("hello \0 world", "Cannot contain null characters."),
            ("x" * 65, "Cannot be longer than 64 characters."),
            ("hello world", None),
            ("x" * 64, None),
        )

        validator = NameValidator(64)

        for tc in cases:
            if tc[1]:
                with self.assertRaises(ValidationError) as cm:
                    validator(tc[0])

                self.assertEqual(tc[1], cm.exception.messages[0])
            else:
                try:
                    validator(tc[0])
                except Exception:
                    self.fail(f"unexpected validation error for '{tc[0]}'")

        self.assertEqual(NameValidator(64), validator)
        self.assertNotEqual(NameValidator(32), validator)

    def test_external_url_field(self):
        class Form(forms.Form):
            url = ExternalURLField()

        cases = (
            ("//[", ["Enter a valid URL."]),
            ("ftp://google.com", ["Must use HTTP or HTTPS."]),
            ("google.com", ["Enter a valid URL."]),
            ("http://localhost/foo", ["Cannot be a local or private host."]),
            ("http://localhost:80/foo", ["Cannot be a local or private host."]),
            ("http://127.0.00.1/foo", ["Cannot be a local or private host."]),  # loop back
            ("http://192.168.0.0/foo", ["Cannot be a local or private host."]),  # private
            ("http://255.255.255.255", ["Cannot be a local or private host."]),  # multicast
            ("http://169.254.169.254/latest", ["Cannot be a local or private host."]),  # link local
            ("http://::1:80/foo", ["Unable to resolve host."]),  # no ipv6 addresses for now
            ("http://google.com/foo", []),
            ("http://google.com:8000/foo", []),
            ("HTTP://google.com:8000/foo", []),
            ("HTTP://8.8.8.8/foo", []),
        )

        for tc in cases:
            form = Form({"url": tc[0]})
            is_valid = form.is_valid()

            if tc[1]:
                self.assertFalse(is_valid, f"form.is_valid() unexpectedly true for '{tc[0]}'")
                self.assertEqual({"url": tc[1]}, form.errors, f"validation errors mismatch for '{tc[0]}'")

            else:
                self.assertTrue(is_valid, f"form.is_valid() unexpectedly false for '{tc[0]}'")
                self.assertEqual({}, form.errors)

    def test_select_widget_blank_choice(self):
        groups = Group.objects.filter(name="Testers")

        class Form(forms.Form):
            model_optional = forms.ModelChoiceField(groups, required=False, widget=SelectWidget())
            model_named = forms.ModelChoiceField(
                groups, required=False, empty_label="Unassigned", widget=SelectWidget()
            )
            choice_dash = forms.ChoiceField(choices=BLANK_CHOICE_DASH + [("a", "A")], widget=SelectWidget())
            choice_named = forms.ChoiceField(choices=[("", "None"), ("a", "A")], widget=SelectWidget())

        Group.objects.create(name="Testers")
        form = Form()

        def option_names(field):
            return re.findall(r'name="([^"]*)"', str(form[field]))[1:]  # first is the select's own name

        self.assertEqual(["Testers"], option_names("model_optional"))
        self.assertEqual(["Unassigned", "Testers"], option_names("model_named"))
        self.assertEqual(["A"], option_names("choice_dash"))
        self.assertEqual(["None", "A"], option_names("choice_named"))
