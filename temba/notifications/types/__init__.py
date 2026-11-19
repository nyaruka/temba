from .builtin import (
    ExportFinishedNotificationType,
    ImportFinishedNotificationType,
    IncidentStartedNotificationType,
    InvitationAcceptedNotificationType,
    TicketActivityNotificationType,
    TicketsOpenedNotificationType,
)

TYPES = {}  # thread-safe: populated once at import


def register_notification_type(typ):
    """
    Registers a notification type
    """
    assert typ.slug not in TYPES, f"type {typ.slug} is already registered"

    TYPES[typ.slug] = typ


register_notification_type(ExportFinishedNotificationType())
register_notification_type(ImportFinishedNotificationType())
register_notification_type(IncidentStartedNotificationType())
register_notification_type(InvitationAcceptedNotificationType())
register_notification_type(TicketsOpenedNotificationType())
register_notification_type(TicketActivityNotificationType())
