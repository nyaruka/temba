# parallel test workers import this module before django.setup() runs, so it can't import (or live in a package
# that imports) anything requiring the app registry, e.g. models or temba.tests

import io
import re

import django.test.runner
from django.conf import settings
from django.core.cache import caches
from django.core.files.storage import storages
from django.core.management import call_command
from django.test.runner import DiscoverRunner, ParallelTestSuite, _init_worker


def _temba_init_worker(counter, *args, **kwargs):
    """
    Django's own worker init gives each parallel test worker its own clone of the test database. This extends that
    with a per-worker valkey database and per-worker DynamoDB tables and S3 buckets, so that workers
    can't see each other's state in those services.
    """

    _init_worker(counter, *args, **kwargs)

    worker_id = django.test.runner._worker_id

    # serial test runs use valkey database 10 and local dev uses 15, so give workers 1..10 databases 0..9
    if worker_id > 10:
        raise RuntimeError("can't run more than 10 parallel test workers as each needs its own valkey database")

    location = settings.CACHES["default"]["LOCATION"]
    new_location = re.sub(r"/\d+$", f"/{worker_id - 1}", location)
    if new_location == location:
        raise RuntimeError(f"couldn't derive a per-worker valkey database from {location}")

    settings.CACHES["default"]["LOCATION"] = new_location

    # the system checks run by Django's own worker init will have already instantiated the cache connection, so
    # reset the cache handler to ensure connections are recreated with this worker's settings
    caches.__dict__.pop("settings", None)
    for alias in settings.CACHES:
        try:
            delattr(caches._connections, alias)
        except AttributeError:
            pass

    caches["default"].clear()  # in case a previous test run left anything behind in this worker's valkey database

    # derive the worker's names from the configured test ones (e.g. Test -> Test3) so that settings can namespace
    # them, e.g. for separate environments sharing one DynamoDB or S3 service
    base_bucket_prefix = settings.BUCKET_PREFIX
    settings.DYNAMO_TABLE_PREFIX = f"{settings.DYNAMO_TABLE_PREFIX}{worker_id}"
    settings.BUCKET_PREFIX = f"{base_bucket_prefix}{worker_id}"

    for alias, config in settings.STORAGES.items():
        bucket_name = config.get("OPTIONS", {}).get("bucket_name")
        if bucket_name:
            new_name = bucket_name.replace(f"{base_bucket_prefix}-", f"{settings.BUCKET_PREFIX}-", 1)
            config["OPTIONS"]["bucket_name"] = new_name

            # some storage backends are instantiated during django.setup() above (e.g. model field storages) so
            # existing instances need to be updated as well
            storage = storages[alias]
            storage.bucket_name = new_name
            storage.__dict__.pop("bucket", None)

    settings.STORAGE_URL = f"{settings.AWS_S3_ENDPOINT_URL}/{settings.BUCKET_PREFIX}-default"

    # create this worker's tables and buckets if they don't already exist (both commands read the prefixes set above)
    call_command("migrate_dynamo", stdout=io.StringIO())
    call_command("create_buckets", stdout=io.StringIO())


class TembaParallelTestSuite(ParallelTestSuite):
    init_worker = _temba_init_worker


class TembaTestRunner(DiscoverRunner):
    parallel_test_suite = TembaParallelTestSuite

    def setup_test_environment(self, **kwargs):
        super().setup_test_environment(**kwargs)

        # a serial run uses the test tables and buckets themselves, so make sure they exist (parallel workers also
        # create their own)
        call_command("migrate_dynamo", stdout=io.StringIO())
        call_command("create_buckets", stdout=io.StringIO())
