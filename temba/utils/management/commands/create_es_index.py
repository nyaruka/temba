import json

from django.conf import settings
from django.core.management import BaseCommand, CommandError

from temba.utils.elastic import get_client

MESSAGES_TEMPLATE_FILE = "temba/utils/management/commands/data/es_messages.json"
MESSAGES_TEMPLATE_NAME = "messages-v1"

CONTACTS_INDEX_FILE = "temba/utils/management/commands/data/es_contacts.json"
CONTACTS_INDEX_NAME = "contacts-v1"


class Command(BaseCommand):
    help = "Creates Elasticsearch indices or templates."

    def add_arguments(self, parser):
        parser.add_argument("index", choices=["messages", "contacts"], help="Index to create")
        parser.add_argument(
            "--shards", type=int, choices=range(1, 11), help="Override number of shards (1-10)", default=None
        )
        parser.add_argument(
            "--replicas", type=int, choices=range(0, 3), help="Override number of replicas (0-2)", default=None
        )
        parser.add_argument("--no-alias", action="store_true", help="Don't create the alias for the index")

    def handle(self, index: str, shards: int, replicas: int, no_alias: bool, *args, **options):
        if not settings.ELASTIC_ENDPOINT_URL:
            raise CommandError("ELASTIC_ENDPOINT_URL must be configured")

        client = get_client()

        if index == "messages":
            with open(MESSAGES_TEMPLATE_FILE, "r") as f:
                schema = json.load(f)

            if shards is not None:
                schema["template"]["settings"]["index"]["number_of_shards"] = shards
            if replicas is not None:
                schema["template"]["settings"]["index"]["number_of_replicas"] = replicas

            self._create_template(client, MESSAGES_TEMPLATE_NAME, schema)

        elif index == "contacts":
            with open(CONTACTS_INDEX_FILE, "r") as f:
                schema = json.load(f)

            if shards is not None:
                schema["settings"]["index"]["number_of_shards"] = shards
            if replicas is not None:
                schema["settings"]["index"]["number_of_replicas"] = replicas

            self._create_index(client, CONTACTS_INDEX_NAME, schema)

    def _create_template(self, client, name: str, schema: dict):
        """Creates an index template using the Elasticsearch API."""

        client.indices.put_index_template(name=name, **schema)

        opts = schema["template"]["settings"]["index"]
        self.stdout.write(
            f"Put {name} index template (shards={opts['number_of_shards']}, replicas={opts['number_of_replicas']})"
        )

    def _create_index(self, client, name: str, schema: dict, alias: str = None):
        """Creates a regular index using the Elasticsearch API."""

        client.indices.create(index=name, **schema)

        opts = schema["settings"]["index"]
        self.stdout.write(
            f"Created {name} index (shards={opts['number_of_shards']}, replicas={opts['number_of_replicas']})"
        )

        if alias:
            # remove alias from any existing indices first to avoid multiple indices with same alias
            actions = [{"add": {"index": name, "alias": alias}}]
            try:
                existing = client.indices.get_alias(name=alias)
                for old_index in existing:
                    if old_index != name:
                        actions.insert(0, {"remove": {"index": old_index, "alias": alias}})
                        self.stdout.write(f" > removing alias {alias} from {old_index}")
            except Exception:
                pass  # alias doesn't exist yet

            client.indices.update_aliases(actions=actions)
            self.stdout.write(f" > added alias {alias} -> {name}")
