import json
import subprocess
import time
from zoneinfo import ZoneInfo

from django_valkey import get_valkey_connection

from django.apps import apps
from django.conf import settings
from django.core.management import BaseCommand, CommandError, call_command
from django.db import connection
from django.utils import timezone

from temba.ai.models import LLM
from temba.campaigns.models import Campaign, CampaignEvent
from temba.channels.models import Channel
from temba.contacts.models import Contact, ContactField, ContactGroup, ContactURN
from temba.flows.models import Flow
from temba.globals.models import Global
from temba.locations.models import AdminBoundary
from temba.msgs.models import Label
from temba.orgs.models import Org, OrgRole
from temba.templates.models import Template, TemplateTranslation
from temba.tickets.models import Team, Topic
from temba.users.models import User

SPECS_FILE = "temba/utils/management/commands/data/mailroom_db.json"

# by default every user will have this password including the superuser
USER_PASSWORD = "Qwerty123"

# database dump containing admin boundary records
LOCATIONS_FILE = "test-data/nigeria.bin"

MAILROOM_PORT = 8092
MAILROOM_DB_NAME = "mailroom_test"
MAILROOM_DB_USER = "mailroom_test"
MAILROOM_DB_PASS = "temba"
POSTGRES_PASS = "tembatemba"
DUMP_FILE = "postgres.dump"

# stable UUIDs for the root and system users which are created before our seeded UUID generator is patched in
ROOT_USER_UUID = "00b8e9a3-7c41-4a52-9d83-6e1f5c8b2a47"
SYSTEM_USER_UUID = "01a7d4f2-8c63-4b91-a5e8-3f9d7c2b1e58"


class Command(BaseCommand):
    help = "Generates a database suitable for mailroom testing"

    def handle(self, *args, **kwargs):
        self.generate_and_dump(SPECS_FILE, LOCATIONS_FILE, MAILROOM_PORT, MAILROOM_DB_NAME, MAILROOM_DB_USER, DUMP_FILE)

    def generate_and_dump(self, specs_file, locs_file, mr_port: int, db_name, db_user, dump_file):
        with open(specs_file, "r") as orgs_file:
            orgs_spec = json.load(orgs_file)

        self._log(f"Initializing {db_name} database...\n")

        # drop and recreate the test db and user
        self._sql(f"DROP DATABASE IF EXISTS {db_name}")
        self._sql(f"CREATE DATABASE {db_name}")
        self._sql(f"DROP USER IF EXISTS {db_user}")
        self._sql(f"CREATE USER {db_user} PASSWORD '{MAILROOM_DB_PASS}'")
        self._sql(f"ALTER ROLE {db_user} WITH SUPERUSER")

        # always use test db as our db and override mailroom location
        settings.DATABASES["default"]["NAME"] = db_name
        settings.DATABASES["default"]["USER"] = db_user
        settings.MAILROOM_URL = f"http://host.docker.internal:{mr_port}"

        self._log("Running migrations...\n")

        # run our migrations to put our database in the right state
        call_command("migrate")

        # the system user is auto-created during migrate (post_migrate signal) before our seeded UUID generator
        # is in play, so force a stable UUID on it
        User.objects.filter(is_system=True).update(uuid=SYSTEM_USER_UUID)

        # this is a new database so clear out valkey
        self._log("Clearing out Valkey cache... ")
        r = get_valkey_connection()
        r.flushdb()
        self._log(self.style.SUCCESS("OK") + "\n")

        self._log("Creating superuser... ")
        superuser = User.objects.create_user("root", USER_PASSWORD, is_superuser=True, uuid=ROOT_USER_UUID)
        self._log(self.style.SUCCESS("OK") + "\n")

        mr_cmd = f'go run ./cmd/mailroom --port={mr_port} -db="postgres://{db_user}:temba@localhost/{db_name}?sslmode=disable" --valkey="valkey://localhost:6379/15" --workers-realtime=0 --workers-batch=0 --workers-throttled=0 -uuid-seed=123'
        input(f"\nPlease start mailroom:\n   % {mr_cmd}\n\nPress enter when ready.\n")

        root_location = self.load_locations(locs_file)

        # patch UUID generation so it's deterministic
        from temba.utils import uuid

        uuid.default_generator = uuid.seeded_generator(1234)

        # create each of our orgs
        for spec in orgs_spec["orgs"]:
            self.create_org(spec, superuser, root_location)

        # leave id sequences starting at a known number so it's easier to identity newly created data in mailroom tests
        self.reset_id_sequences(30000)

        # dump our file
        result = subprocess.run(
            ["pg_dump", "-h", "postgres", "-U", "postgres", "-Fc", db_name],
            stdout=subprocess.PIPE,
            env={"PGPASSWORD": POSTGRES_PASS},
            check=True,
        )

        with open(dump_file, "wb") as f:
            f.write(result.stdout)

        self._log("\n" + self.style.SUCCESS("Success!") + f" Dump file: {dump_file}\n\n")

    def load_locations(self, path):
        """
        Loads admin boundary records from the given dump of that table
        """
        self._log("Loading locations from %s... " % path)

        with open(path, "rb") as f:
            try:
                subprocess.run(
                    [
                        "pg_restore",
                        "-h",
                        "postgres",
                        "-d",
                        MAILROOM_DB_NAME,
                        "-U",
                        MAILROOM_DB_USER,
                    ],
                    input=f.read(),
                    env={"PGPASSWORD": MAILROOM_DB_PASS},
                    check=True,
                )
            except subprocess.CalledProcessError:
                raise CommandError("Error occurred whilst calling pg_restore to load locations dump")

        self._log(self.style.SUCCESS("OK") + "\n")

        # TODO figure out why this is needed
        time.sleep(1)

        return AdminBoundary.objects.filter(level=0).get()

    def reset_id_sequences(self, start: int):
        with connection.cursor() as cursor:
            for mod in apps.get_models():
                if hasattr(mod, "id") and (
                    hasattr(mod, "org_id") or hasattr(mod, "flow_id") or hasattr(mod, "campaign_id")
                ):
                    seq_name = f"{mod._meta.db_table}_id_seq"
                    cursor.execute(f"ALTER SEQUENCE {seq_name} RESTART WITH {start}")

            cursor.execute(f"ALTER SEQUENCE contacts_contactgroup_contacts_id_seq RESTART WITH {start}")

    def create_org(self, spec, superuser, root_location):
        self._log(f"\nCreating org {spec['name']}...\n")

        org = Org.objects.create(
            uuid=spec["uuid"],
            name=spec["name"],
            timezone=ZoneInfo("America/Los_Angeles"),
            flow_languages=spec["languages"],
            root_location=root_location,
            created_on=timezone.now(),
            created_by=superuser,
            modified_by=superuser,
        )

        # set our sequences to make ids stable across orgs
        self.reset_id_sequences(spec["sequence_start"])

        org.initialize(sample_flows=False)

        self.create_channels(spec, org, superuser)
        self.create_fields(spec, org, superuser)
        self.create_globals(spec, org, superuser)
        self.create_labels(spec, org, superuser)
        self.create_groups(spec, org, superuser)
        self.create_flows(spec, org, superuser)
        self.create_contacts(spec, org, superuser)
        self.create_group_contacts(spec, org, superuser)
        self.create_campaigns(spec, org, superuser)
        self.create_templates(spec, org, superuser)
        self.create_topics(spec, org, superuser)
        self.create_teams(spec, org, superuser)
        self.create_llms(spec, org, superuser)
        self.create_users(spec, org)

        return org

    def create_channels(self, spec, org, user):
        self._log(f"Creating {len(spec['channels'])} channels... ")

        for c in spec["channels"]:
            Channel.objects.create(
                org=org,
                name=c["name"],
                channel_type=c["channel_type"],
                address=c["address"],
                schemes=[c["scheme"]],
                uuid=c["uuid"],
                role=c["role"],
                config=c["config"],
                created_by=user,
                modified_by=user,
            )

        self._log(self.style.SUCCESS("OK") + "\n")

    def create_topics(self, spec, org, user):
        self._log(f"Creating {len(spec['topics'])} topics... ")

        for t in spec["topics"]:
            Topic.objects.create(
                uuid=t["uuid"],
                org=org,
                name=t["name"],
                created_by=user,
                modified_by=user,
            )

        self._log(self.style.SUCCESS("OK") + "\n")

    def create_teams(self, spec, org, user):
        self._log(f"Creating {len(spec['teams'])} teams... ")

        for t in spec["teams"]:
            team = Team.objects.create(
                uuid=t["uuid"],
                org=org,
                name=t["name"],
                created_by=user,
                modified_by=user,
            )
            for topic in t["topics"]:
                team.topics.add(Topic.objects.get(name=topic))

        self._log(self.style.SUCCESS("OK") + "\n")

    def create_llms(self, spec, org, user):
        self._log(f"Creating {len(spec['llms'])} LLMs... ")

        for t in spec["llms"]:
            LLM.objects.create(
                uuid=t["uuid"],
                org=org,
                name=t["name"],
                llm_type=t["type"],
                model=t["model"],
                config=t["config"],
                created_by=user,
                modified_by=user,
            )

        self._log(self.style.SUCCESS("OK") + "\n")

    def create_users(self, spec, org):
        self._log(f"Creating {len(spec['users'])} users... ")

        for u in spec["users"]:
            user = User.objects.create_user(
                u["email"],
                USER_PASSWORD,
                uuid=u["uuid"],
                first_name=u["first_name"],
                last_name=u["last_name"],
            )
            team = org.teams.get(name=u["team"]) if u.get("team") else None
            org.add_user(user, OrgRole.from_code(u["role"]), team=team)

        self._log(self.style.SUCCESS("OK") + "\n")

    def create_fields(self, spec, org, user):
        self._log(f"Creating {len(spec['fields'])} fields... ")

        for f in spec["fields"]:
            ContactField.objects.create(
                uuid=f["uuid"],
                org=org,
                key=f["key"],
                name=f["name"],
                is_system=False,
                value_type=f["value_type"],
                show_in_table=True,
                created_by=user,
                modified_by=user,
            )

        self._log(self.style.SUCCESS("OK") + "\n")

    def create_globals(self, spec, org, user):
        self._log(f"Creating {len(spec['globals'])} globals... ")

        for g in spec["globals"]:
            Global.objects.create(
                uuid=g["uuid"],
                org=org,
                key=g["key"],
                name=g["name"],
                value=g["value"],
                created_by=user,
                modified_by=user,
            )

        self._log(self.style.SUCCESS("OK") + "\n")

    def create_groups(self, spec, org, user):
        self._log(f"Creating {len(spec['groups'])} groups... ")

        for g in spec["groups"]:
            if g.get("query"):
                group = ContactGroup.create_smart(org, user, g["name"], g["query"], evaluate=False)
            else:
                group = ContactGroup.create_manual(org, user, g["name"])
            group.uuid = g["uuid"]
            group.save(update_fields=["uuid"])

        self._log(self.style.SUCCESS("OK") + "\n")

    def create_labels(self, spec, org, user):
        self._log(f"Creating {len(spec['labels'])} labels... ")

        for lb in spec["labels"]:
            Label.objects.create(org=org, name=lb["name"], uuid=lb["uuid"], created_by=user, modified_by=user)

        self._log(self.style.SUCCESS("OK") + "\n")

    def create_flows(self, spec, org, user):
        self._log(f"Creating {len(spec['flows'])} flows... ")

        for f in spec["flows"]:
            with open("media/test_flows/mailroom/" + f["file"], "r") as flow_file:
                org.import_app(json.load(flow_file), user)

                # set the uuid on this flow
                Flow.objects.filter(org=org, name=f["name"]).update(uuid=f["uuid"])

        self._log(self.style.SUCCESS("OK") + "\n")

    def create_campaigns(self, spec, org, user):
        self._log(f"Creating {len(spec['campaigns'])} campaigns... ")

        for c in spec["campaigns"]:
            group = ContactGroup.objects.get(org=org, name=c["group"])
            campaign = Campaign.objects.create(
                name=c["name"],
                group=group,
                is_archived=False,
                org=org,
                created_by=user,
                modified_by=user,
                uuid=c["uuid"],
            )

            for e in c.get("events", []):
                field = ContactField.objects.get(org=org, key=e["offset_field"])

                if "flow" in e:
                    flow = Flow.objects.get(org=org, name=e["flow"])
                    event = CampaignEvent.create_flow_event(
                        org,
                        user,
                        campaign,
                        field,
                        e["offset"],
                        e["offset_unit"],
                        flow,
                        delivery_hour=e.get("delivery_hour", -1),
                        start_mode=e["start_mode"],
                    )
                else:
                    event = CampaignEvent.create_message_event(
                        org,
                        user,
                        campaign,
                        field,
                        e["offset"],
                        e["offset_unit"],
                        e["translations"],
                        base_language=e["base_language"],
                        delivery_hour=e.get("delivery_hour", -1),
                        start_mode=e["start_mode"],
                    )
                event.uuid = e["uuid"]
                event.save(update_fields=("uuid",))

        # make events look like they've been scheduled
        CampaignEvent.objects.all().update(status=CampaignEvent.STATUS_READY, fire_version=1)

        self._log(self.style.SUCCESS("OK") + "\n")

    def create_templates(self, spec, org, templates):
        self._log(f"Creating {len(spec['templates'])} templates... ")

        for t in spec["templates"]:
            template = Template.objects.create(
                org=org, uuid=t["uuid"], name=t["name"], created_by=org.created_by, modified_by=org.modified_by
            )
            for tt in t["translations"]:
                channel = Channel.objects.get(uuid=tt["channel_uuid"])
                TemplateTranslation.objects.create(
                    template=template,
                    channel=channel,
                    locale=tt["locale"],
                    status=tt["status"],
                    external_id=tt["external_id"],
                    external_locale=tt["external_locale"],
                    namespace=tt["namespace"],
                    components=tt["components"],
                    variables=tt["variables"],
                )
            template.update_base()

        self._log(self.style.SUCCESS("OK") + "\n")

    def create_contacts(self, spec, org, user):
        self._log(f"Creating {len(spec['contacts'])} contacts... ")

        fields_by_key = {f.key: f for f in ContactField.user_fields.all()}

        for c in spec["contacts"]:
            values = {fields_by_key[key]: val for key, val in c.get("fields", {}).items()}
            groups = list(ContactGroup.objects.filter(org=org, name__in=c.get("groups", [])))

            contact = Contact.create(
                org,
                user,
                name=c["name"],
                language="",
                status=Contact.STATUS_ACTIVE,
                urns=c["urns"],
                fields=values,
                groups=groups,
            )
            contact.uuid = c["uuid"]
            contact.created_on = c["created_on"]
            contact.save(update_fields=("uuid", "created_on"))

        self._log(self.style.SUCCESS("OK") + "\n")

    def create_group_contacts(self, spec, org, user):
        from temba.utils import uuid

        self._log("Generating group contacts...")

        # use a local generator seeded by the org id so bulk contacts have stable UUIDs
        # across regens and don't collide between orgs
        gen = uuid.seeded_generator(org.id)

        for g in spec["groups"]:
            size = int(g.get("size", 0))
            if size > 0:
                group = ContactGroup.objects.get(org=org, name=g["name"])

                contacts = []
                for i in range(size):
                    urn = f"tel:+250788{i:06}"
                    urn_obj = ContactURN.objects.filter(org=org, identity=urn).first()
                    if urn_obj and urn_obj.contact:
                        contact = urn_obj.contact
                    else:
                        contact = Contact.create(
                            org,
                            user,
                            name="",
                            language="",
                            status=Contact.STATUS_ACTIVE,
                            urns=[urn],
                            fields={},
                            groups=[],
                        )
                        contact.uuid = str(gen())
                        contact.save(update_fields=("uuid",))

                    contacts.append(contact)

                Contact.bulk_change_group(user, contacts, group, add=True)

        self._log(self.style.SUCCESS("OK") + "\n")

    def _sql(self, sql: str):
        try:
            result = subprocess.run(
                ["psql", "-h", "postgres", "-U", "postgres"],
                input=sql.encode(),
                env={"PGPASSWORD": POSTGRES_PASS},
                stdout=subprocess.PIPE,
                check=True,
            )
        except subprocess.CalledProcessError as e:
            raise CommandError(str(e))

        self._log(result.stdout.decode())

    def _log(self, text):
        self.stdout.write(text, ending="")
        self.stdout.flush()
