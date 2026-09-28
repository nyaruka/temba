# parallel test workers import this module before django.setup() runs, so it can't import (or live in a package
# that imports) anything requiring the app registry, e.g. models or temba.tests

import io
import multiprocessing
import multiprocessing.util
import os
import re
import signal
import socket
import sys
import threading
import time

import valkey

from django.conf import settings
from django.core.cache import caches
from django.core.files.storage import storages
from django.core.management import call_command
from django.test.runner import DiscoverRunner, ParallelTestSuite, _init_worker

# Each test process - a serial run, or each worker of a parallel one - claims a slot: one of the valkey databases in
# settings.TEST_VALKEY_POOL, after which its DynamoDB tables and S3 buckets are also named, so that concurrent runs
# sharing one set of services, e.g. from different checkouts, can't see or clear each other's state. Claims follow
# the protocol of vkutil's assertvk package, so they're also safe from the tests of other projects sharing the pool:
# they live in the coordination database settings.TEST_VALKEY_COORD_DB and expire unless renewed, so a dead run's
# evaporate. If every slot is taken, claiming waits for one to free up rather than failing.
SLOT_CLAIM_TIMEOUT = 180  # seconds
SLOT_CLAIM_TTL = 30_000  # milliseconds
SLOT_RENEW_INTERVAL = 10  # seconds

CLAIMS_KEY = "testdbs:claims"
OWNERS_KEY = "testdbs:owners"

# the Lua scripts of assertvk's claim protocol, which every client sharing the pool must use as-is
CLAIM_SCRIPT = """
local t = redis.call("TIME")
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
for _, db in ipairs(redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", now)) do
	redis.call("ZREM", KEYS[1], db)
	redis.call("HDEL", KEYS[2], db)
end
for db = tonumber(ARGV[1]), tonumber(ARGV[2]) do
	if not redis.call("ZSCORE", KEYS[1], db) then
		redis.call("ZADD", KEYS[1], now + tonumber(ARGV[4]), db)
		redis.call("HSET", KEYS[2], db, ARGV[3])
		return db
	end
end
return -1
"""

RENEW_SCRIPT = """
if redis.call("HGET", KEYS[2], ARGV[1]) ~= ARGV[2] then
	return 0
end
local t = redis.call("TIME")
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call("ZADD", KEYS[1], "XX", now + tonumber(ARGV[3]), ARGV[1])
return 1
"""

RELEASE_SCRIPT = """
if redis.call("HGET", KEYS[2], ARGV[1]) ~= ARGV[2] then
	return 0
end
redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("HDEL", KEYS[2], ARGV[1])
return 1
"""

# the (slot, owner, renewer stop event, renewer) of each claim, by the pid of the process holding it
_claims = {}  # thread-safe: only test processes use it, each from its main thread

# the configured test table and bucket prefixes, from before any slot's were derived from them
_base_prefixes = {}  # thread-safe: only test processes use it, each from its main thread


def _valkey(db: int) -> valkey.Valkey:
    return valkey.Valkey.from_url(re.sub(r"/\d+$", f"/{db}", settings.CACHES["default"]["LOCATION"]))


def claim_slot() -> int:
    """
    Claims a slot for this process if it doesn't already hold one, and returns it (its valkey database)
    """

    # a forked worker inherits its parent's claim, which isn't its own
    if claim := _claims.get(os.getpid()):
        return claim[0]

    coord_db, (first, last) = settings.TEST_VALKEY_COORD_DB, settings.TEST_VALKEY_POOL
    owner = f"{socket.gethostname()}:{os.getpid()}"

    with _valkey(coord_db) as conn:
        num_dbs = int(conn.config_get("databases")["databases"])
        if num_dbs <= max(coord_db, first):
            raise RuntimeError(f"valkey has too few databases ({num_dbs}) for test slots, e.g. use --databases 64")
        last = min(last, num_dbs - 1)

        deadline = time.monotonic() + SLOT_CLAIM_TIMEOUT
        while (slot := conn.eval(CLAIM_SCRIPT, 2, CLAIMS_KEY, OWNERS_KEY, first, last, owner, SLOT_CLAIM_TTL)) < 0:
            if time.monotonic() > deadline:
                raise RuntimeError(f"timed out waiting for an unclaimed test slot ({first}-{last})")

            time.sleep(0.25)

    with _valkey(slot) as conn:
        conn.flushdb()  # in case a previous run left anything behind in this slot's valkey database

    stop = threading.Event()
    renewer = threading.Thread(target=_renew_slot, args=(slot, owner, stop), daemon=True)
    renewer.start()
    _claims[os.getpid()] = (slot, owner, stop, renewer)

    # atexit handlers don't run in parallel workers, but multiprocessing's finalizers run in them and at exit
    multiprocessing.util.Finalize(None, release_slot, exitpriority=10)

    return slot


def _renew_slot(slot: int, owner: str, stop: threading.Event):
    while not stop.wait(SLOT_RENEW_INTERVAL):
        try:
            with _valkey(settings.TEST_VALKEY_COORD_DB) as conn:
                held = conn.eval(RENEW_SCRIPT, 2, CLAIMS_KEY, OWNERS_KEY, slot, owner, SLOT_CLAIM_TTL)
        except valkey.ValkeyError:
            continue  # the claim can survive a missed renewal

        if not held:
            # another process may now be using our slot, so nothing this run asserts can be trusted
            sys.stderr.write(f"lost claim on test slot {slot}\n")
            # a parallel worker, so don't leave the run waiting on it forever - its parent is the run's main process
            # whatever the start method, unlike its OS parent which may be a forkserver
            if parent := multiprocessing.parent_process():
                os.kill(parent.pid, signal.SIGTERM)
            os._exit(1)


def release_slot():
    """
    Flushes and releases this process's slot if it holds one
    """

    claim = _claims.pop(os.getpid(), None)
    if not claim:
        return

    slot, owner, stop, renewer = claim
    stop.set()
    renewer.join()  # so a renewal can't race the release and find the claim gone

    with _valkey(slot) as conn:
        conn.flushdb()  # while we still own it
    with _valkey(settings.TEST_VALKEY_COORD_DB) as conn:
        conn.eval(RELEASE_SCRIPT, 2, CLAIMS_KEY, OWNERS_KEY, slot, owner)


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

    # derive the slot's names from the configured test ones (e.g. Test -> Test32) so that settings can namespace
    # them, e.g. for separate environments sharing one DynamoDB or S3 service. A forked worker inherits the names its
    # parent already derived for its own slot, so derive from the prefixes as configured, and rename buckets from
    # whatever prefix they have now.
    _base_prefixes.setdefault("dynamo", settings.DYNAMO_TABLE_PREFIX)
    _base_prefixes.setdefault("bucket", settings.BUCKET_PREFIX)
    old_bucket_prefix = settings.BUCKET_PREFIX
    settings.DYNAMO_TABLE_PREFIX = f"{_base_prefixes['dynamo']}{slot}"
    settings.BUCKET_PREFIX = f"{_base_prefixes['bucket']}{slot}"

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
        # a serial run's tests use the main process's slot, so make sure its tables and buckets exist (parallel
        # workers create their own)
        if not isinstance(suite, ParallelTestSuite):
            create_slot_storage()

        return super().run_suite(suite, **kwargs)

    def teardown_test_environment(self, **kwargs):
        super().teardown_test_environment(**kwargs)

        release_slot()
