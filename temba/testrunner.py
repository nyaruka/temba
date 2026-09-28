# parallel test workers import this module before django.setup() runs, so it can't import (or live in a package
# that imports) anything requiring the app registry, e.g. models or temba.tests

import io
import os
import re
import time

import psycopg

from django.conf import settings
from django.core.cache import caches
from django.core.files.storage import storages
from django.core.management import call_command
from django.test.runner import DiscoverRunner, ParallelTestSuite, _init_worker

# Each test process - a serial run, or each worker of a parallel one - claims a slot: one of the valkey databases in
# settings.TEST_VALKEY_DBS, after which its DynamoDB tables and S3 buckets are also named, so that concurrent runs
# sharing one set of services, e.g. from different checkouts, can't see or clear each other's state. The claim is an
# advisory lock in Postgres held for the life of the process, so it evaporates if the process dies, and the slot's
# valkey database is flushed on claim to clear anything a dead run left behind. If every slot is taken, claiming
# waits for one to free up rather than failing.
SLOT_LOCK_CLASS = 0x74656D62  # the first key of each slot's advisory lock ("temb"), the second being the slot
SLOT_CLAIM_TIMEOUT = 180  # seconds

# the (connection, slot) of each claim, by the pid of the process holding it
_claims = {}  # thread-safe: only test processes use it, each from its main thread


def claim_slot() -> int:
    """
    Claims a slot for this process if it doesn't already hold one, and returns it (its valkey database)
    """

    # a forked worker inherits its parent's claim, which isn't its own (and psycopg won't close the inherited
    # connection, so the parent keeps its lock)
    if claim := _claims.get(os.getpid()):
        return claim[1]

    # advisory locks are scoped to a database, so every run must lock in the same one, whatever its test database
    db = settings.DATABASES["default"]
    conn = psycopg.connect(
        host=db["HOST"],
        port=db["PORT"] or None,
        user=db["USER"],
        password=db["PASSWORD"],
        dbname="postgres",
        autocommit=True,
    )

    deadline = time.monotonic() + SLOT_CLAIM_TIMEOUT
    while True:
        for slot in settings.TEST_VALKEY_DBS:
            if conn.execute("SELECT pg_try_advisory_lock(%s, %s)", (SLOT_LOCK_CLASS, slot)).fetchone()[0]:
                _claims[os.getpid()] = (conn, slot)
                return slot

        if time.monotonic() > deadline:
            conn.close()
            raise RuntimeError(f"timed out waiting for an unclaimed test slot ({settings.TEST_VALKEY_DBS})")

        time.sleep(0.25)


def use_slot(slot: int):
    """
    Switches this process to its slot's valkey database, DynamoDB tables and S3 buckets (see create_slot_storage)
    """

    location = settings.CACHES["default"]["LOCATION"]
    new_location = re.sub(r"/\d+$", f"/{slot}", location)
    if new_location == location and not location.endswith(f"/{slot}"):
        raise RuntimeError(f"couldn't derive the slot's valkey database from {location}")

    settings.CACHES["default"]["LOCATION"] = new_location

    # anything which has already used the cache (e.g. system checks) will have instantiated its connection, so reset
    # the cache handler to ensure connections are recreated with this slot's settings
    caches.__dict__.pop("settings", None)
    for alias in settings.CACHES:
        try:
            delattr(caches._connections, alias)
        except AttributeError:
            pass

    caches["default"].clear()  # in case a previous run left anything behind in this slot's valkey database

    # bucket names are renamed from whatever prefix they have now - not always the settings' own "test", as a forked
    # worker inherits the names its parent already renamed to its own slot
    old_bucket_prefix = settings.BUCKET_PREFIX
    settings.DYNAMO_TABLE_PREFIX = f"Test{slot}"
    settings.BUCKET_PREFIX = f"test{slot}"

    for alias, config in settings.STORAGES.items():
        bucket_name = config.get("OPTIONS", {}).get("bucket_name")
        if bucket_name:
            new_name = bucket_name.replace(f"{old_bucket_prefix}-", f"{settings.BUCKET_PREFIX}-", 1)
            config["OPTIONS"]["bucket_name"] = new_name

            # some storage backends are instantiated during django.setup() (e.g. model field storages) so existing
            # instances need to be updated as well
            storage = storages[alias]
            storage.bucket_name = new_name
            storage.__dict__.pop("bucket", None)

    settings.STORAGE_URL = f"{settings.AWS_S3_ENDPOINT_URL}/{settings.BUCKET_PREFIX}-default"


def create_slot_storage():
    """
    Creates the tables and buckets of this process's slot if they don't already exist. Only a process which runs tests
    does this, as the AWS clients it creates can't be used by processes forked from it.
    """

    call_command("migrate_dynamo", stdout=io.StringIO())
    call_command("create_buckets", stdout=io.StringIO())


def _temba_init_worker(counter, *args, **kwargs):
    """
    Django's own worker init gives each parallel test worker its own clone of the test database. This extends that
    with the worker's own slot.
    """

    _init_worker(counter, *args, **kwargs)

    use_slot(claim_slot())
    create_slot_storage()


class TembaParallelTestSuite(ParallelTestSuite):
    init_worker = _temba_init_worker


class TembaTestRunner(DiscoverRunner):
    parallel_test_suite = TembaParallelTestSuite

    def setup_test_environment(self, **kwargs):
        super().setup_test_environment(**kwargs)

        # the main process runs the tests of a serial run, and prepares the test database for a parallel one
        use_slot(claim_slot())

    def run_suite(self, suite, **kwargs):
        if not isinstance(suite, ParallelTestSuite):
            create_slot_storage()

        return super().run_suite(suite, **kwargs)
