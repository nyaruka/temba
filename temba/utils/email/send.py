from django.conf import settings
from django.core.mail import DEFAULT_MAILER_ALIAS, EmailMultiAlternatives
from django.template import loader
from django.utils import timezone

from .backend import CUSTOM_SMTP_MAILER_ALIAS
from .conf import parse_smtp_url


class EmailSender:
    """
    Sends template based branded emails.
    """

    def __init__(self, branding: dict, from_email: str = None, smtp_url: str = None):
        self.branding = branding
        self.from_email = from_email if from_email else getattr(settings, "DEFAULT_FROM_EMAIL", "website@rapidpro.io")
        self.smtp_url = smtp_url  # optional SMTP configuration URL to send with instead of the default mailer

    @classmethod
    def from_email_type(cls, branding: dict, email_type: str):
        """
        Creates a sender from the given email type setting in the given branding - which can be a from address, or a
        complete SMTP configuration URL for sending via the custom SMTP mailer.
        """
        email_cfg = branding.get("emails", {}).get(email_type)
        if email_cfg and email_cfg.startswith("smtp://"):
            return cls.from_smtp_url(branding, email_cfg)

        return cls(branding, from_email=email_cfg)

    @classmethod
    def from_smtp_url(cls, branding: dict, smtp_url: str):
        """
        Creates a sender from the given SMTP configuration URL.
        """
        return cls(branding, from_email=parse_smtp_url(smtp_url)[4], smtp_url=smtp_url)

    def render_template(self, template_path: str, postfixes, context: dict):
        for postfix in postfixes:
            try:
                template = loader.get_template(f"{template_path}{postfix}")
                return template.render(context)
            except loader.TemplateDoesNotExist:
                pass
        return None

    def send(self, recipients: list, template: str, context: dict, subject: str = None, headers: dict = None):
        """
        Sends a multi-part email rendered from templates for the text and html parts. `template` should be the name of
        the template, without .html or .txt (e.g. 'channels/email/power_charging'). If this sender has its own SMTP
        configuration, the message carries it and is sent by the custom SMTP mailer, otherwise by the default mailer.
        """
        context["branding"] = self.branding
        context["now"] = timezone.now()

        if not subject:
            subject = self.render_template(template, ["_subject.txt"], context)
            if not subject:  # pragma: no cover
                raise ValueError("No subject provided and subject template doesn't exist")

        # make sure our subject is a single line
        subject = " ".join(subject.splitlines()).strip()

        text = self.render_template(template, [".txt"], context)
        html = self.render_template(template, [".html", "_message.html"], context)

        if not html:  # pragma: no cover
            raise ValueError("Could not render message template for %s" % template)

        message = EmailMultiAlternatives(subject, text, self.from_email, recipients, headers=headers)
        message.attach_alternative(html, "text/html")

        if self.smtp_url:
            message.smtp_url = self.smtp_url
            message.send(using=CUSTOM_SMTP_MAILER_ALIAS)
        else:
            message.send(using=DEFAULT_MAILER_ALIAS)
