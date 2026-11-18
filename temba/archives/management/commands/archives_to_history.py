import gzip
import json
from datetime import date, datetime, timezone as tzone

import iso8601

from django.core.management.base import BaseCommand, CommandError

from temba.archives.models import Archive
from temba.orgs.models import Org
from temba.utils import dynamo
from temba.utils.uuid import uuid7

tag_statuses = {"wired", "sent", "delivered", "read", "errored", "failed"}


class Command(BaseCommand):
    help = "Imports chat history events from message archives into DynamoDB"

    def add_arguments(self, parser):
        parser.add_argument("step", type=str, action="store", choices=("update", "import"))
        parser.add_argument("--org", type=int, dest="org_id")
        parser.add_argument("--suspended", action="store_true", dest="suspended", help="Include suspended orgs")
        parser.add_argument("--since", type=date.fromisoformat)
        parser.add_argument("--until", type=date.fromisoformat)

    def handle(self, step: str, org_id: int, suspended: bool, since: date, until: date, *args, **kwargs):
        orgs = Org.objects.filter(is_active=True).exclude(archives=None).only("id", "name").order_by("id")
        if org_id:
            orgs = orgs.filter(id=org_id)
        if not suspended:
            orgs = orgs.exclude(status=Org.STATUS_SUSPENDED)

        since = datetime.combine(since, datetime.min.time(), tzinfo=tzone.utc) if since else None
        until = datetime.combine(until, datetime.max.time(), tzinfo=tzone.utc) if until else None

        self.stdout.write(f"Starting message archive {step} for {orgs.count()} orgs...")
        num_records = 0

        for org in orgs:
            if step == "update":
                self.stdout.write(f" 👤 updating archives for '{org.name}' (#{org.id})... ")
                num_records += self.update_for_org(org, since, until)
            else:
                self.stdout.write(f" 👤 importing archives for '{org.name}' (#{org.id})... ")
                num_records += self.import_for_org(org, since, until)

        self.stdout.write(f"Done 🎉 {num_records:,} records {'updated' if step == 'update' else 'imported'}.")

    def update_for_org(self, org, since, until) -> int:
        total = 0
        archives = Archive._get_covering_period(org, Archive.TYPE_MSG, after=since, before=until)
        for archive in archives:
            self.stdout.write(f"    🗂️ rewriting {archive.period}:{archive.start_date.isoformat()}...", ending="")
            self.stdout.flush()

            progress = {"records": 0, "updated": 0}

            def rewrite_msg(record) -> dict:
                if "uuid" not in record:
                    record["uuid"] = str(uuid7(when=iso8601.parse_date(record["created_on"])))
                    progress["updated"] += 1

                progress["records"] += 1

                if progress["records"] % 10_000 == 0:
                    self.stdout.write(".", ending="")
                    self.stdout.flush()

                return record

            archive.rewrite(rewrite_msg, delete_old=True)

            self.stdout.write(f" ✅ ({progress['records']:,} records, {progress['updated']:,} updated)")
            total += progress["updated"]

        return total

    def import_for_org(self, org, since, until) -> int:
        total = 0

        with dynamo.HISTORY.batch_writer() as writer:
            archives = Archive._get_covering_period(org, Archive.TYPE_MSG, after=since, before=until)
            for archive in archives:
                self.stdout.write(f"    🗂️ importing {archive.period}:{archive.start_date.isoformat()}...", ending="")
                self.stdout.flush()

                num_imported = 0

                for record in archive.iter_records():
                    if "uuid" not in record:
                        raise CommandError(f"Record in archive #{archive.id} has no UUID, cannot import")

                    contact_uuid = record["contact"]["uuid"]
                    event_uuid = record["uuid"]
                    event_time = record["created_on"]

                    if record["direction"] == "in":
                        writer.put_item(
                            self._item(
                                org,
                                contact_uuid,
                                event_uuid,
                                {"type": "msg_received", "created_on": event_time, "msg": self._msg(record)},
                            )
                        )

                        if record["visibility"] == "deleted":
                            writer.put_item(
                                self._item(org, contact_uuid, event_uuid, {"created_on": event_time}, "del")
                            )
                    else:
                        if record["type"] in ("ivr", "voice"):
                            writer.put_item(
                                self._item(
                                    org,
                                    contact_uuid,
                                    event_uuid,
                                    {"type": "ivr_created", "created_on": event_time, "msg": self._msg(record)},
                                )
                            )
                        else:
                            msg = self._msg(record)
                            writer.put_item(
                                self._item(
                                    org,
                                    contact_uuid,
                                    event_uuid,
                                    {"type": "msg_created", "created_on": event_time, "msg": msg},
                                )
                            )

                            if record["status"] in tag_statuses and "unsendable_reason" not in msg:
                                writer.put_item(
                                    self._item(
                                        org,
                                        contact_uuid,
                                        event_uuid,
                                        {"created_on": event_time, "status": record["status"]},
                                        "sts",
                                    )
                                )

                    num_imported += 1
                    if num_imported % 10_000 == 0:
                        self.stdout.write(".", ending="")
                        self.stdout.flush()

                self.stdout.write(f" ✅ ({num_imported:,} imported)")
                total += num_imported

        return total

    def _item(self, org, contact_uuid: str, event_uuid: str, data: dict, tag: str = None) -> dict:
        """
        Constructs a DynamoDB item in our standard format from an event or tag.
        """

        data_gz = None
        if not tag:
            marshaled = json.dumps(data).encode("utf-8")
            if len(marshaled) >= 900:
                data_gz = gzip.compress(marshaled, mtime=0)
                data = {"type": data["type"]}

        item = {
            "PK": f"con#{contact_uuid}",
            "SK": f"evt#{event_uuid}#{tag}" if tag else f"evt#{event_uuid}",
            "OrgID": org.id,
            "Data": data,
            "Src": "archives",
        }
        if data_gz:
            item["DataGZ"] = data_gz
        return item

    def _msg(self, record: dict) -> dict:
        """
        Converts an archive record into the msg part of an engine event.
        """

        e = {"text": record.get("text", "")}

        if urn := record.get("urn"):
            e["urn"] = urn
        if channel_ref := record.get("channel"):
            e["channel"] = channel_ref
        if attachments := record.get("attachments"):
            e["attachments"] = attachments
        if record.get("broadcast"):
            # note that broadcasts are gone at this point, so we fabricate a UUID based on creation time
            e["broadcast_uuid"] = str(uuid7(when=iso8601.parse_date(record["created_on"])))

        if record["direction"] == "out" and record["status"] == "failed" and "urn" not in e and "channel" not in e:
            e["unsendable_reason"] = "no_route"

        return e
