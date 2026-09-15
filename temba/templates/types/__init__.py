from .twilio import TwilioType
from .whatsapp import WhatsAppType

TYPES = {}  # thread-safe: populated once at import


def register_template_type(typ):
    """
    Registers a template translation type
    """
    assert typ.slug not in TYPES, f"type {typ.slug} is already registered"

    TYPES[typ.slug] = typ


register_template_type(WhatsAppType())
register_template_type(TwilioType())
