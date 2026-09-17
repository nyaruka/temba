from temba.knowledge.layout import (
    cleanup_body,
    fit_beside,
    fit_pair,
    kind_of,
    level_headings,
    normalize,
    split_blocks,
)
from temba.tests import TembaTest

SHOT = "https://storage.example.com/shot.png"
SHOT2 = "https://storage.example.com/shot2.png"
MENU = "https://storage.example.com/menu.png"
BANNER = "https://storage.example.com/banner.png"
ICON = "https://storage.example.com/icon.png"
TALL = "https://storage.example.com/tall.png"

SIZES = {
    SHOT: (1400, 900),  # a 2x screenshot of a dialog - too much detail to shrink
    SHOT2: (1400, 900),
    MENU: (640, 590),  # a menu, legible at a third of its size
    BANNER: (1600, 300),
    ICON: (120, 40),
    TALL: (600, 1000),  # a phone screen
    "https://storage.example.com/wide.png": (1000, 500),
}


def sizer(url: str):
    return SIZES.get(url)


# an explainer long enough to sit beside a screenshot
EXPLAINER = (
    "Log in to your account and visit the workspace and click on **Accounts** from the Account Initials Icon. "
    "You will be directed to your profile. As the logged-in user, you can update your name, email, and password, "
    "or secure your login by enabling Two-Factor Authentication."
)


class LayoutTest(TembaTest):
    def test_normalize(self):
        # windows line endings, no-break spaces, zero width characters and trailing spaces all go; a hard break
        # before more text stays, and every image gets a line of its own with blank lines either side
        body = (
            "To remove a channel: \r\n\r\n"
            "1. Go to settings.​  \r\n"
            "  \r\n"
            "![](https://x/1.png)  \r\n"
            "  \r\n"
            "2. Click the menu.  \r\n"
            "and pick delete.\r\n"
            "![](https://x/2.png)\r\n"
            "We're done.\r\n\r\n\r\n\r\n"
            "Text with an image ![](https://x/3.png) in the middle.\r\n"
        )
        self.assertEqual(
            "To remove a channel:\n\n"
            "1. Go to settings.\n\n"
            "![](https://x/1.png)\n\n"
            "2. Click the menu.  \n"
            "and pick delete.\n\n"
            "![](https://x/2.png)\n\n"
            "We're done.\n\n"
            "Text with an image\n\n"
            "![](https://x/3.png)\n\n"
            "in the middle.",
            normalize(body),
        )

        # fenced code and table rows are left exactly as they are, and indentation is kept elsewhere
        body = (
            "- a list\n    - nested  \n\n```\ncode  \n\n  ![](https://x/1.png)\n```\n\n| a | ![](https://x/2.png) |\n"
        )
        self.assertEqual(body.rstrip("\n").replace("nested  ", "nested"), normalize(body))

    def test_level_headings(self):
        # headings that all sit a level down are lifted to the top, keeping their hierarchy
        self.assertEqual(
            "Intro.\n\n# Setup\n\nText.\n\n## Details\n\n### Deeper\n\n# Usage",
            level_headings("Intro.\n\n## Setup\n\nText.\n\n### Details\n\n#### Deeper\n\n## Usage"),
        )

        # by however far down they sit, indentation and closing marks kept
        self.assertEqual("# One ###\n\n  ## Two", level_headings("### One ###\n\n  #### Two"))

        # a body whose headings already start at the top is left as it is, as is one with no headings
        self.assertEqual("# One\n\n### Three", level_headings("# One\n\n### Three"))
        self.assertEqual("Just words.", level_headings("Just words."))

        # a # inside fenced code, or without a space after it, isn't a heading and doesn't count
        self.assertEqual(
            "```\n# comment\n```\n\n#hashtag\n\n# Two", level_headings("```\n# comment\n```\n\n#hashtag\n\n## Two")
        )
        self.assertEqual("```\n# comment\n```", level_headings("```\n# comment\n```"))

    def test_split_blocks(self):
        self.assertEqual(["a\nb", "c", "```\n\nd\n```", "e"], split_blocks("a\nb\n\nc\n\n```\n\nd\n```\n\ne"))

    def test_kind_of(self):
        self.assertEqual("image", kind_of("![](https://x/1.png)"))
        self.assertEqual("text", kind_of("A paragraph\nof text."))
        self.assertEqual("step", kind_of("1. One step"))
        self.assertEqual("other", kind_of("1. One step\n2. Two"))
        self.assertEqual("other", kind_of("## Heading"))
        self.assertEqual("other", kind_of("| a | b |\n| --- | --- |"))
        self.assertEqual("other", kind_of("> quoted"))
        self.assertEqual("other", kind_of("```\ncode\n```"))
        self.assertEqual("other", kind_of("text ![](https://x/1.png) more"))

    def test_fit_beside(self):
        # a legible menu beside a substantial explainer, at widths that come out about even
        self.assertEqual((60, 40), fit_beside(EXPLAINER, f"![]({MENU})", sizer))

        # a phone screen beside a longer explainer
        self.assertEqual((55, 45), fit_beside(EXPLAINER * 2, f"![]({TALL})", sizer))

        # too short or too long a text, a banner, an icon, an unknown image, or a 2x screenshot that would have to be
        # shrunk past reading all stay full width
        self.assertIsNone(fit_beside("Short text.", f"![]({MENU})", sizer))
        self.assertIsNone(fit_beside(EXPLAINER * 6, f"![]({MENU})", sizer))
        self.assertIsNone(fit_beside(EXPLAINER, f"![]({BANNER})", sizer))
        self.assertIsNone(fit_beside(EXPLAINER, f"![]({ICON})", sizer))
        self.assertIsNone(fit_beside(EXPLAINER, "![](https://x/unknown.png)", sizer))
        self.assertIsNone(fit_beside(EXPLAINER, f"![]({SHOT})", sizer))

        # a text just long enough beside a tall image comes out far shorter than it at every width, so stays above
        self.assertIsNone(fit_beside(("word " * 41).strip(), f"![]({TALL})", sizer))

        # a size fragment doesn't get in the way of sizing
        self.assertEqual((60, 40), fit_beside(EXPLAINER, f"![]({MENU}#size=medium)", sizer))

    def test_fit_pair(self):
        # two phone screens share the measure evenly
        self.assertEqual((50, 50), fit_pair(f"![]({TALL})", f"![]({TALL})", sizer))

        # a phone screen and a menu share it in the ratio of their shapes
        self.assertEqual((36, 64), fit_pair(f"![]({TALL})", f"![]({MENU})", sizer))

        # but a 2x screenshot can't be halved and read, a banner doesn't pair at all, and a wide image beside a
        # tall one would leave the tall one too narrow to read
        self.assertIsNone(fit_pair(f"![]({SHOT})", f"![]({SHOT2})", sizer))
        self.assertIsNone(fit_pair(f"![]({BANNER})", f"![]({TALL})", sizer))
        self.assertIsNone(fit_pair(f"![]({TALL})", "![](https://storage.example.com/wide.png)", sizer))

    def test_cleanup_body(self):
        body = f"""# Your account

{EXPLAINER}

![]({MENU})

Now the big picture:

![]({SHOT})

![]({TALL})

![]({TALL})

**Note:** you can't change | your username.

Note that we do not support all template components. Keep reading.

![]({MENU})
{EXPLAINER}
Questions? Ask us.
"""
        self.assertEqual(
            f"""# Your account

| width: 60% | width: 40% |
| --- | --- |
| {EXPLAINER} | ![]({MENU}) |

Now the big picture:

![]({SHOT})

| width: 50% | width: 50% |
| --- | --- |
| ![]({TALL}) | ![]({TALL}) |

| background: 1 |
| --- |
| **Note:** you can't change \\| your username. |

| background: 1 |
| --- |
| Note that we do not support all template components. Keep reading. |

| width: 45% | width: 55% |
| --- | --- |
| {EXPLAINER}<br>Questions? Ask us. | ![]({MENU}) |""",
            cleanup_body(body, sizer),
        )

        # an image's text isn't taken from the image after it, and a note beside an image is a column not a callout
        body = f"![]({MENU})\n\n{EXPLAINER}\n\n![]({MENU})"
        self.assertEqual(
            f"![]({MENU})\n\n| width: 60% | width: 40% |\n| --- | --- |\n| {EXPLAINER} | ![]({MENU}) |",
            cleanup_body(body, sizer),
        )

        # nothing to lay out leaves the body as it was, tidied
        self.assertEqual(
            "Just words.\n\n1. and\n2. a list", cleanup_body("Just words. \n\n\n1. and\n2. a list\n", sizer)
        )

        # headings are lifted so the top level ones are top level
        self.assertEqual("# Setup\n\nWords.\n\n## Details", cleanup_body("## Setup\n\nWords.\n\n### Details\n", sizer))
