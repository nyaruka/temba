import copy
import json

from temba.msgs.models import Attachment, Media, Q


def compose_serialize(translations, *, json_encode=False, base_language=None) -> dict:
    """
    Serializes translations to format for compose widget
    """

    if not translations:
        return {}

    translations = copy.deepcopy(translations)

    for translation in translations.values():
        if "attachments" in translation:
            translation["attachments"] = compose_serialize_attachments(translation["attachments"])

        # for now compose widget only supports simple text quick replies
        if "quick_replies" in translation:
            translation["quick_replies"] = [qr["text"] for qr in translation["quick_replies"]]

    return json.dumps(translations) if json_encode else translations


def compose_serialize_attachments(attachments: list) -> list:
    serialized = []

    for parsed in Attachment.parse_all(attachments):
        media = Media.objects.filter(Q(content_type=parsed.content_type) and Q(url=parsed.url)).first()
        serialized.append(
            {
                "uuid": str(media.uuid),
                "content_type": media.content_type,
                "url": media.url,
                "filename": media.filename,
                "size": str(media.size),
            }
        )
    return serialized


def compose_deserialize(compose: dict) -> dict:
    """
    Deserializes attachments from compose widget to db for saving final db values
    """
    for translation in compose.values():
        translation["attachments"] = compose_deserialize_attachments(translation.get("attachments", []))

        # for now compose widget only supports simple text quick replies
        if "quick_replies" in translation:
            translation["quick_replies"] = [{"text": qr} for qr in translation["quick_replies"]]
    return compose


def compose_deserialize_attachments(attachments: list) -> list:
    if not attachments:
        return []

    return [str(Attachment(a["content_type"], a["url"])) for a in attachments]
