import os
import sys
from datetime import timedelta
from ipaddress import ip_network

from celery.schedules import crontab

from django.utils.csp import CSP
from django.utils.translation import gettext_lazy as _

# Django tests these by string membership, so the network block is expanded rather than kept as a range
INTERNAL_IPS = ["127.0.0.1", "0.0.0.0"] + [str(ip) for ip in ip_network("192.168.0.0/24")]
HOSTNAME = "localhost"

# HTTP Headers using for outgoing requests to other services
OUTGOING_REQUEST_HEADERS = {"User-agent": "RapidPro"}

# Make this unique, and don't share it with anybody.
SECRET_KEY = "your own secret key"

# used to obfuscate IDs - i.e. contact ids in anonymous workspaces
ID_OBFUSCATION_KEY = (0xA3B1C, 0xD2E3F, 0x1A2B3, 0xC0FFEE)

DATA_UPLOAD_MAX_NUMBER_FIELDS = 2500  # needed for exports of big workspaces

# -----------------------------------------------------------------------------------
# Tests
# -----------------------------------------------------------------------------------
TESTING = sys.argv[1:2] == ["test"]
TEST_RUNNER = "temba.testrunner.TembaTestRunner"

if TESTING:
    PASSWORD_HASHERS = ("django.contrib.auth.hashers.MD5PasswordHasher",)
    DEBUG = False

_db_host = "postgres"
_valkey_host = "valkey"
_dynamodb_host = "dynamodb"
_s3_host = "s3"

# -----------------------------------------------------------------------------------
# AWS
# -----------------------------------------------------------------------------------

AWS_ACCESS_KEY_ID = "root"
AWS_SECRET_ACCESS_KEY = "tembatemba"
AWS_REGION = "us-east-1"

DYNAMO_ENDPOINT_URL = f"http://{_dynamodb_host}:8000"
DYNAMO_TABLE_PREFIX = "Test" if TESTING else "Temba"

ELASTIC_ENDPOINT_URL = "http://elastic:9200"

# -----------------------------------------------------------------------------------
# Storage
# -----------------------------------------------------------------------------------

BUCKET_PREFIX = "test" if TESTING else "temba"

STORAGES = {
    # default storage for things like exports, imports
    "default": {
        "BACKEND": "storages.backends.s3boto3.S3Boto3Storage",
        "OPTIONS": {"bucket_name": f"{BUCKET_PREFIX}-default"},
    },
    # wherever rp-archiver writes archive files
    "archives": {
        "BACKEND": "storages.backends.s3boto3.S3Boto3Storage",
        "OPTIONS": {"bucket_name": f"{BUCKET_PREFIX}-archives"},
    },
    # media file uploads that need to be publicly accessible
    "public": {
        "BACKEND": "storages.backends.s3boto3.S3Boto3Storage",
        "OPTIONS": {
            "bucket_name": f"{BUCKET_PREFIX}-default",
            "signature_version": "s3v4",
            "default_acl": "public-read",
            "querystring_auth": False,
        },
    },
    # static files are served by the app itself (WhiteNoise) rather than a web server in front of it, so
    # collectstatic also writes .gz/.br siblings for WhiteNoise to serve - it never compresses at request time
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}

# settings used by django-storages (defaults to the dev stack's S3)
AWS_S3_REGION_NAME = AWS_REGION
AWS_S3_ENDPOINT_URL = f"http://{_s3_host}:8333"
AWS_S3_ADDRESSING_STYLE = "path"
AWS_S3_FILE_OVERWRITE = False

STORAGE_URL = f"{AWS_S3_ENDPOINT_URL}/{BUCKET_PREFIX}-default"

# -----------------------------------------------------------------------------------
# Localization
# -----------------------------------------------------------------------------------

USE_TZ = True
TIME_ZONE = "GMT"
USER_TIME_ZONE = "Africa/Kigali"

LANGUAGE_CODE = "en-us"

LANGUAGES = (
    ("en-us", _("English")),
    ("es", _("Spanish")),
    ("fr", _("French")),
    ("pt-br", _("Portuguese")),
)
DEFAULT_LANGUAGE = "en-us"

SITE_ID = 1

USE_I18N = True
USE_L10N = True

# -----------------------------------------------------------------------------------
# Static Files
# -----------------------------------------------------------------------------------

# List of finder classes that know how to find static files in
# various locations.
STATICFILES_FINDERS = (
    "django.contrib.staticfiles.finders.FileSystemFinder",
    "temba.utils.staticfiles.ComponentsFinder",
    "django.contrib.staticfiles.finders.AppDirectoriesFinder",
    "compressor.finders.CompressorFinder",
)


PROJECT_DIR = os.path.join(os.path.abspath(os.path.dirname(__file__)))
LOCALE_PATHS = (os.path.join(PROJECT_DIR, "../locale"),)
RESOURCES_DIR = os.path.join(PROJECT_DIR, "../resources")
FIXTURE_DIRS = (os.path.join(PROJECT_DIR, "../fixtures"),)
TESTFILES_DIR = os.path.join(PROJECT_DIR, "../testfiles")
# the components/ project, whose build output is served by temba.utils.staticfiles.ComponentsFinder
COMPONENTS_DIR = os.path.join(PROJECT_DIR, "../components")

STATICFILES_DIRS = (
    os.path.join(PROJECT_DIR, "../static"),
    os.path.join(PROJECT_DIR, "../media"),
)
STATIC_ROOT = os.path.join(PROJECT_DIR, "../sitestatic")
STATIC_URL = "/sitestatic/"
COMPRESS_ROOT = os.path.join(PROJECT_DIR, "../sitestatic")
MEDIA_ROOT = os.path.join(PROJECT_DIR, "../media")
MEDIA_URL = "/media/"

# WhiteNoise serves everything under STATIC_URL from STATIC_ROOT, so no web server needs to be configured to do it.
# Two things to know about it: it only ever serves the .gz/.br siblings generated at collectstatic time, never
# compressing a response on the fly, and it only marks a file immutable if the staticfiles storage is a manifest one
# that can map the hashed name back - which ours isn't. So everything, hashed compressor bundle or not, gets this
# max-age, chosen to match the far-future expiry a web server would have been configured to send for these.
WHITENOISE_MAX_AGE = 315360000  # 10 years

# -----------------------------------------------------------------------------------
# Email
# -----------------------------------------------------------------------------------
# Mailers are how email is sent. The default mailer sends most email, but messages which carry their own SMTP
# configuration URL - e.g. notifications for workspaces with their own branding and SMTP settings - are sent by the
# custom SMTP mailer. Both must always be configured.
MAILERS = {
    "default": {
        "BACKEND": "django.core.mail.backends.smtp.EmailBackend",
        "OPTIONS": {
            "host": "smtp.gmail.com",
            "username": "server@temba.io",
            "password": "mypassword",
            "use_tls": True,
            "timeout": 10,
        },
    },
    "custom_smtp": {
        "BACKEND": "temba.utils.email.backend.CustomSMTPBackend",
        "OPTIONS": {"timeout": 10},
    },
}

DEFAULT_FROM_EMAIL = "Temba <server@temba.io>"

# Used when sending email from within a flow and the user hasn't configured
# their own SMTP server.
FLOW_FROM_EMAIL = "Temba <no-reply@temba.io>"

# -----------------------------------------------------------------------------------
# Templates
# -----------------------------------------------------------------------------------

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [
            os.path.join(PROJECT_DIR, "../templates"),
        ],
        "OPTIONS": {
            "builtins": ["django.contrib.humanize.templatetags.humanize"],
            "context_processors": [
                "django.contrib.auth.context_processors.auth",
                "django.template.context_processors.debug",
                "django.template.context_processors.i18n",
                "django.template.context_processors.media",
                "django.template.context_processors.static",
                "django.contrib.messages.context_processors.messages",
                "django.template.context_processors.request",
                "temba.context_processors.branding",
                "temba.context_processors.config",
                "temba.orgs.views.context_processors.org_perms_processor",
            ],
            "loaders": [
                "django.template.loaders.filesystem.Loader",
                "django.template.loaders.app_directories.Loader",
            ],
        },
    }
]

FORM_RENDERER = "django.forms.renderers.TemplatesSetting"

# -----------------------------------------------------------------------------------
# Middleware
# -----------------------------------------------------------------------------------

# The position of WhiteNoise matters: it answers requests for static files itself without calling anything below it, so
# only the middleware above it touches those responses. The headers every response should carry go above it, and the
# things that are only for the app's own responses go below it - static files are served pre-compressed with a
# far-future max-age and mustn't be gzipped again or marked uncacheable.
MIDDLEWARE = (
    "temba.middleware.ProxiedRequestMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.csp.ContentSecurityPolicyMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.gzip.GZipMiddleware",
    "temba.middleware.NoStoreMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "temba.middleware.OrgMiddleware",
    "temba.knowledge.middleware.HelpSiteMiddleware",
    "temba.middleware.LanguageMiddleware",
    "temba.middleware.TimezoneMiddleware",
    "temba.middleware.ToastMiddleware",
    "allauth.account.middleware.AccountMiddleware",
)

# paths which are reached by network address rather than by one of the app's domains, and so would otherwise be
# rejected by the ALLOWED_HOSTS check - a load balancer health checking an instance is the case that matters. For
# these the host is replaced with the app's own domain, so get_host() returns that rather than whatever was sent.
# Nothing served at one of these paths may build URLs from the host, since a forged host is accepted here. Each must
# be exactly the path asked for, trailing slash and all: a near miss doesn't error, it falls through to the usual
# host check and fails there.
ALLOWED_HOSTS_EXEMPT_PATHS = ()

# whether to treat every request as having arrived over https regardless of what the connection or any forwarded header
# says - for when TLS is always terminated in front of the app
SECURE_ASSUME_HTTPS = False

# nothing here is meant to be embedded in a frame - this is the same thing as X-Frame-Options for browsers that have
# moved on to CSP for it
SECURE_CSP = {"frame-ancestors": [CSP.NONE]}

# -----------------------------------------------------------------------------------
# Apps
# -----------------------------------------------------------------------------------

ROOT_URLCONF = "temba.urls"

# other urls to add
APP_URLS = []

SITEMAP = ("public.public_index", "api")

INSTALLED_APPS = (
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.sites",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.humanize",
    "django.contrib.gis",
    "django.contrib.sitemaps",
    "django.contrib.postgres",
    "django.forms",
    "allauth",
    "allauth.account",
    "allauth.mfa",
    "allauth.socialaccount",
    "allauth.socialaccount.providers.google",
    "formtools",
    "rest_framework",
    "rest_framework.authtoken",
    "compressor",
    "smartmin",
    "timezone_field",
    "temba.users",
    "temba.ai",
    "temba.apks",
    "temba.archives",
    "temba.api",
    "temba.request_logs",
    "temba.classifiers",
    "temba.dashboard",
    "temba.globals",
    "temba.public",
    "temba.schedules",
    "temba.templates",
    "temba.orgs",
    "temba.contacts",
    "temba.channels",
    "temba.msgs",
    "temba.notifications",
    "temba.flows",
    "temba.tickets",
    "temba.knowledge",
    "temba.triggers",
    "temba.utils",
    "temba.campaigns",
    "temba.ivr",
    "temba.locations",
    "temba.airtime",
    "temba.sql",
    "temba.staff",
)

# don't let smartmin auto create django messages for create and update submissions
SMARTMIN_DEFAULT_MESSAGES = False

# -----------------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------------

LOGGING = {
    "version": 1,
    "disable_existing_loggers": True,
    "formatters": {"verbose": {"format": "%(levelname)s %(asctime)s %(module)s %(message)s"}},
    "handlers": {
        "console": {"level": "DEBUG", "class": "logging.StreamHandler", "formatter": "verbose"},
    },
    "root": {"level": "INFO", "handlers": ["console"]},
}

# -----------------------------------------------------------------------------------
# Branding
# -----------------------------------------------------------------------------------

BRAND = {
    "name": "RapidPro",
    "description": _("Visually build nationally scalable mobile applications anywhere in the world."),
    "hosts": ["rapidpro.io"],
    "domain": "app.rapidpro.io",
    "emails": {"notifications": "support@rapidpro.io"},
    "logos": {
        "primary": "images/logo-dark.svg",
        "favico": "brands/rapidpro/rapidpro.ico",
        "avatar": "brands/rapidpro/rapidpro-avatar.webp",
    },
    "landing": {
        "hero": "brands/rapidpro/splash.jpg",
    },
    "features": ["sso"],
    # brands that offer self-serve signup can set "signup_url" to where users without a workspace should be
    # sent to create one - account creation itself is invite-only unless the adapters say otherwise
}

FEATURES = {"locations"}

# The default checked options for flow starts and broadcasts
DEFAULT_EXCLUSIONS = {"in_a_flow": True}

# Estimated send time limits before warning or blocking, zero is no limit
SEND_HOURS_WARNING = 0
SEND_HOURS_BLOCK = 0

# -----------------------------------------------------------------------------------
# Permissions
# -----------------------------------------------------------------------------------

PERMISSIONS = {
    "*": (
        "create",  # can create an object
        "read",  # can read an object, viewing it's details
        "update",  # can update an object
        "delete",  # can delete an object,
        "list",  # can view a list of the objects
    ),
    "ai.llm": ("connect", "translate"),
    "api.apitoken": ("explorer",),
    "archives.archive": ("run", "message"),
    "campaigns.campaign": ("archive", "activate", "menu"),
    "channels.channel": ("chart", "claim", "configuration", "logs", "facebook_whitelist"),
    "contacts.contact": ("export", "chat", "interrupt", "menu", "omnibox", "open_ticket", "start"),
    "contacts.contactfield": ("update_priority",),
    "contacts.contactgroup": ("menu",),
    "contacts.contactimport": ("preview",),
    "flows.flow": ("assets", "copy", "editor", "export", "menu", "next", "results", "start"),
    "flows.flowstart": ("interrupt", "status"),
    "globals.global": ("unused",),
    "locations.adminboundary": ("alias", "boundaries", "geometry"),
    "msgs.broadcast": ("scheduled", "scheduled_delete"),
    "msgs.msg": ("archive", "export", "label", "menu"),
    "orgs.export": ("download",),
    "orgs.org": (
        "create",
        "dashboard",
        "download",
        "edit",
        "export",
        "flow_smtp",
        "grant",
        "join_accept",
        "join",
        "languages",
        "locations",
        "manage_integrations",
        "manage",
        "menu",
        "prometheus",
        "resthooks",
        "service",
        "spa",
        "switch",
        "trial",
        "twilio_account",
        "twilio_connect",
        "workspace",
    ),
    "request_logs.httplog": ("webhooks",),
    "knowledge.article": ("colors", "publish", "sort", "upload"),
    "knowledge.helpdeskimport": ("status",),
    "knowledge.helpsite": ("domain", "verify"),
    "knowledge.knowledgesource": ("menu", "upload"),
    "tickets.ticket": ("assign", "menu", "note", "export", "analytics", "analytics_export"),
    "triggers.trigger": ("archived", "type", "menu"),
}


# names of the auth groups which staff can attach to workspaces as admin groups, making their members administrators of
# those workspaces. Each also gets a filter in the staff user list.
ADMIN_GROUPS = ()

# assigns the permissions that each group should have
GROUP_PERMISSIONS = {
    "Administrators": (
        "ai.llm.*",
        "airtime.airtimetransfer_list",
        "airtime.airtimetransfer_read",
        "api.apitoken_explorer",
        "api.apitoken_list",
        "api.resthook_list",
        "api.resthooksubscriber_create",
        "api.resthooksubscriber_delete",
        "api.resthooksubscriber_list",
        "api.webhookevent_list",
        "archives.archive.*",
        "campaigns.campaign.*",
        "campaigns.campaignevent.*",
        "channels.channel_claim",
        "channels.channel_configuration",
        "channels.channel_create",
        "channels.channel_delete",
        "channels.channel_facebook_whitelist",
        "channels.channel_list",
        "channels.channel_logs",
        "channels.channel_read",
        "channels.channel_update",
        "channels.channelevent_list",
        "contacts.contact_chat",
        "contacts.contact_create",
        "contacts.contact_delete",
        "contacts.contact_export",
        "contacts.contact_interrupt",
        "contacts.contact_list",
        "contacts.contact_menu",
        "contacts.contact_omnibox",
        "contacts.contact_open_ticket",
        "contacts.contact_read",
        "contacts.contact_update",
        "contacts.contactfield.*",
        "contacts.contactgroup.*",
        "contacts.contactimport.*",
        "flows.flow.*",
        "flows.flowlabel.*",
        "flows.flowrun_list",
        "flows.flowstart.*",
        "globals.global.*",
        "ivr.call.*",
        "locations.adminboundary_alias",
        "locations.adminboundary_boundaries",
        "locations.adminboundary_geometry",
        "locations.adminboundary_list",
        "msgs.broadcast.*",
        "msgs.label.*",
        "msgs.media_create",
        "msgs.msg_archive",
        "msgs.msg_create",
        "msgs.msg_delete",
        "msgs.msg_export",
        "msgs.msg_label",
        "msgs.msg_list",
        "msgs.msg_menu",
        "msgs.msg_update",
        "notifications.incident.*",
        "notifications.notification.*",
        "orgs.export.*",
        "orgs.invitation.*",
        "orgs.org_locations",
        "orgs.org_create",
        "orgs.org_dashboard",
        "orgs.org_delete",
        "orgs.org_download",
        "orgs.org_edit",
        "orgs.org_export",
        "orgs.org_flow_smtp",
        "orgs.org_languages",
        "orgs.org_list",
        "orgs.org_manage_integrations",
        "orgs.org_menu",
        "orgs.org_prometheus",
        "orgs.org_read",
        "orgs.org_resthooks",
        "orgs.org_switch",
        "orgs.org_update",
        "orgs.org_workspace",
        "orgs.orgimport.*",
        "request_logs.httplog_list",
        "request_logs.httplog_read",
        "request_logs.httplog_webhooks",
        "templates.template.*",
        "knowledge.article.*",
        "knowledge.helpdeskimport.*",
        "knowledge.helpsite.*",
        "knowledge.knowledgesource.*",
        "knowledge.knowledgeitem.*",
        "tickets.shortcut.*",
        "tickets.team.*",
        "tickets.ticket.*",
        "tickets.topic.*",
        "triggers.trigger.*",
        "users.user_list",
        "users.user_update",
    ),
    "Editors": (
        "ai.llm_list",
        "ai.llm_read",
        "ai.llm_translate",
        "airtime.airtimetransfer_list",
        "airtime.airtimetransfer_read",
        "api.apitoken_explorer",
        "api.apitoken_list",
        "api.resthook_list",
        "api.resthooksubscriber_create",
        "api.resthooksubscriber_delete",
        "api.resthooksubscriber_list",
        "api.webhookevent_list",
        "archives.archive.*",
        "campaigns.campaign.*",
        "campaigns.campaignevent.*",
        "channels.channel_claim",
        "channels.channel_configuration",
        "channels.channel_create",
        "channels.channel_delete",
        "channels.channel_list",
        "channels.channel_read",
        "channels.channel_update",
        "channels.channelevent_list",
        "contacts.contact_chat",
        "contacts.contact_create",
        "contacts.contact_delete",
        "contacts.contact_export",
        "contacts.contact_interrupt",
        "contacts.contact_list",
        "contacts.contact_menu",
        "contacts.contact_omnibox",
        "contacts.contact_open_ticket",
        "contacts.contact_read",
        "contacts.contact_update",
        "contacts.contactfield.*",
        "contacts.contactgroup.*",
        "contacts.contactimport.*",
        "flows.flow.*",
        "flows.flowlabel.*",
        "flows.flowrun_list",
        "flows.flowstart_create",
        "flows.flowstart_list",
        "flows.flowstart_read",
        "flows.flowstart_update",
        "globals.global.*",
        "ivr.call_list",
        "locations.adminboundary_alias",
        "locations.adminboundary_boundaries",
        "locations.adminboundary_geometry",
        "locations.adminboundary_list",
        "msgs.broadcast.*",
        "msgs.label.*",
        "msgs.media_create",
        "msgs.msg_archive",
        "msgs.msg_create",
        "msgs.msg_delete",
        "msgs.msg_export",
        "msgs.msg_label",
        "msgs.msg_list",
        "msgs.msg_menu",
        "msgs.msg_update",
        "notifications.notification_list",
        "orgs.export_download",
        "orgs.org_download",
        "orgs.org_export",
        "orgs.org_languages",
        "orgs.org_menu",
        "orgs.org_read",
        "orgs.org_resthooks",
        "orgs.org_switch",
        "orgs.org_workspace",
        "orgs.orgimport.*",
        "request_logs.httplog_webhooks",
        "templates.template_list",
        "templates.template_read",
        "knowledge.article_colors",
        "knowledge.article_create",
        "knowledge.article_delete",
        "knowledge.article_list",
        "knowledge.article_publish",
        "knowledge.article_sort",
        "knowledge.article_update",
        "knowledge.article_upload",
        "knowledge.helpdeskimport_create",
        "knowledge.helpdeskimport_status",
        "knowledge.helpsite_domain",
        "knowledge.helpsite_update",
        "knowledge.helpsite_verify",
        "knowledge.knowledgesource_create",
        "knowledge.knowledgesource_delete",
        "knowledge.knowledgesource_menu",
        "knowledge.knowledgesource_read",
        "knowledge.knowledgesource_update",
        "knowledge.knowledgesource_upload",
        "knowledge.knowledgeitem_delete",
        "tickets.shortcut_create",
        "tickets.shortcut_delete",
        "tickets.shortcut_list",
        "tickets.shortcut_update",
        "tickets.ticket.*",
        "tickets.topic.*",
        "triggers.trigger.*",
    ),
    "Agents": (
        "contacts.contact_chat",
        "contacts.contact_interrupt",
        "notifications.notification_list",
        "orgs.org_languages",
        "orgs.org_menu",
        "orgs.org_switch",
        "tickets.ticket_analytics",
        "tickets.ticket_assign",
        "tickets.ticket_list",
        "tickets.ticket_menu",
        "tickets.ticket_note",
        "tickets.ticket_update",
        "tickets.topic_list",
    ),
}

# extra permissions that only apply to API requests (wildcard notation not supported here)
API_PERMISSIONS = {
    "Editors": ("orgs.org_list", "users.user_list"),
    "Agents": (
        "contacts.contact_create",
        "contacts.contact_list",
        "contacts.contact_update",
        "contacts.contactfield_list",
        "contacts.contactgroup_list",
        "locations.adminboundary_list",
        "msgs.media_create",
        "msgs.msg_create",
        "orgs.org_list",
        "orgs.org_read",
        "tickets.shortcut_list",
        "users.user_list",
    ),
}

# -----------------------------------------------------------------------------------
# Authentication
# -----------------------------------------------------------------------------------

LOGIN_URL = "/accounts/login/"
LOGIN_REDIRECT_URL = "/org/choose/"

AUTH_USER_MODEL = "users.User"
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 8}},
]

INVITATION_VALIDITY = timedelta(days=30)

# -----------------------------------------------------------------------------------
# Database
# -----------------------------------------------------------------------------------

_default_database_config = {
    "ENGINE": "django.db.backends.postgresql",
    "NAME": "temba",
    "USER": "temba",
    "PASSWORD": "temba",
    "HOST": _db_host,
    "PORT": "5432",
    "ATOMIC_REQUESTS": True,
    "CONN_MAX_AGE": 60,
    "OPTIONS": {},
    "DISABLE_SERVER_SIDE_CURSORS": True,
}

# installs can provide a default connection and an optional read-only connection (e.g. a separate read replica) which
# will be used for certain fetch operations
DATABASES = {"default": _default_database_config, "readonly": _default_database_config.copy()}


# -----------------------------------------------------------------------------------
# Cache
# -----------------------------------------------------------------------------------
_valkey_url = f"redis://{_valkey_host}:6379/{10 if TESTING else 15}"

CACHES = {
    "default": {
        "BACKEND": "django_valkey.cache.ValkeyCache",
        "LOCATION": _valkey_url,
    }
}

SESSION_ENGINE = "django.contrib.sessions.backends.cached_db"
SESSION_CACHE_ALIAS = "default"

# -----------------------------------------------------------------------------------
# Celery
# -----------------------------------------------------------------------------------

CELERY_BROKER_URL = _valkey_url
CELERY_RESULT_BACKEND = None
CELERY_TASK_TRACK_STARTED = True

# by default, celery doesn't have any timeout on our valkey connections, this fixes that
CELERY_BROKER_TRANSPORT_OPTIONS = {"socket_timeout": 5}

# valkey-backed beat scheduler which can be embedded in every worker (celery worker --beat) - a distributed lock
# ensures only one instance actually schedules, and if it stops refreshing the lock another takes over on expiry
# (the redbeat settings themselves are derived from the broker settings in temba_celery.py)
CELERY_BEAT_SCHEDULER = "redbeat.RedBeatScheduler"
CELERY_BEAT_MAX_LOOP_INTERVAL = 30  # max sleep between beat ticks - each tick refreshes the scheduler lock

# NOTE: entries are synced into valkey when a beat instance starts, so like task signatures, schedule changes need to
# be backward compatible with the previous version during a rolling deploy
CELERY_BEAT_SCHEDULE = {
    "check-android-channels": {"task": "check_android_channels", "schedule": timedelta(seconds=300)},
    "delete-released-orgs": {"task": "delete_released_orgs", "schedule": crontab(hour=4, minute=0)},
    "expire-invitations": {"task": "expire_invitations", "schedule": crontab(hour=0, minute=10)},
    "refresh-turn-whatsapp-tokens": {"task": "refresh_turn_whatsapp_tokens", "schedule": crontab(hour=6, minute=0)},
    "refresh-templates": {"task": "refresh_templates", "schedule": timedelta(hours=6)},
    "send-notification-emails": {"task": "send_notification_emails", "schedule": timedelta(seconds=60)},
    "squash-channel-counts": {"task": "squash_channel_counts", "schedule": timedelta(seconds=60)},
    "squash-group-counts": {"task": "squash_group_counts", "schedule": timedelta(seconds=60)},
    "squash-flow-counts": {"task": "squash_flow_counts", "schedule": timedelta(seconds=30)},
    "squash-item-counts": {"task": "squash_item_counts", "schedule": timedelta(seconds=30)},
    "squash-article-counts": {"task": "squash_article_counts", "schedule": timedelta(seconds=60)},
    "squash-llm-counts": {"task": "squash_llm_counts", "schedule": timedelta(seconds=60)},
    "squash-msg-counts": {"task": "squash_msg_counts", "schedule": timedelta(seconds=60)},
    "trim-article-counts": {"task": "trim_article_counts", "schedule": crontab(hour=3, minute=0)},
    "check-helpsite-domains": {"task": "check_helpsite_domains", "schedule": crontab(hour=4, minute=0)},
    "trim-channel-events": {"task": "trim_channel_events", "schedule": crontab(hour=3, minute=0)},
    "trim-channel-sync-events": {"task": "trim_channel_sync_events", "schedule": crontab(hour=3, minute=0)},
    "trim-exports": {"task": "trim_exports", "schedule": crontab(hour=2, minute=0)},
    "trim-flow-revisions": {"task": "trim_flow_revisions", "schedule": crontab(hour=0, minute=0)},
    "trim-flow-sessions": {"task": "trim_flow_sessions", "schedule": crontab(hour=0, minute=0)},
    "trim-http-logs": {"task": "trim_http_logs", "schedule": crontab(hour=2, minute=0)},
    "trim-llm-counts": {"task": "trim_llm_counts", "schedule": crontab(hour=3, minute=0)},
    "trim-notifications": {"task": "trim_notifications", "schedule": crontab(hour=2, minute=0)},
    "trim-webhook-events": {"task": "trim_webhook_events", "schedule": crontab(hour=3, minute=0)},
    "update-members-seen": {"task": "update_members_seen", "schedule": timedelta(seconds=30)},
    "update-tokens-used": {"task": "update_tokens_used", "schedule": timedelta(seconds=30)},
}

# -----------------------------------------------------------------------------------
# API
# -----------------------------------------------------------------------------------

REST_FRAMEWORK = {
    "DEFAULT_THROTTLE_RATES": {
        "v2": "3600/hour",
        "v2.contacts": "3600/hour",
        "v2.messages": "3600/hour",
        "v2.runs": "3600/hour",
    },
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.LimitOffsetPagination",
    "PAGE_SIZE": 250,
    "EXCEPTION_HANDLER": "temba.api.support.temba_exception_handler",
}
REST_HANDLE_EXCEPTIONS = not TESTING

# -----------------------------------------------------------------------------------
# Compression
# -----------------------------------------------------------------------------------

COMPRESS_FILTERS = {
    "css": ["compressor.filters.css_default.CssAbsoluteFilter"],
    "js": [],
}

COMPRESS_ENABLED = False
COMPRESS_OFFLINE = False

# -----------------------------------------------------------------------------------
# Pluggable Types
# -----------------------------------------------------------------------------------

INTEGRATION_TYPES = [
    "temba.orgs.integrations.dtone.DTOneType",
]

CHANNEL_TYPES = [
    "temba.channels.types.africastalking.AfricasTalkingType",
    "temba.channels.types.arabiacell.ArabiaCellType",
    "temba.channels.types.bandwidth.BandwidthType",
    "temba.channels.types.burstsms.BurstSMSType",
    "temba.channels.types.clickatell.ClickatellType",
    "temba.channels.types.clickmobile.ClickMobileType",
    "temba.channels.types.clicksend.ClickSendType",
    "temba.channels.types.dartmedia.DartMediaType",
    "temba.channels.types.dialog360.Dialog360Type",
    "temba.channels.types.dmark.DMarkType",
    "temba.channels.types.external.ExternalType",
    "temba.channels.types.facebook_legacy.FacebookLegacyType",
    "temba.channels.types.facebook.FacebookType",
    "temba.channels.types.firebase.FirebaseCloudMessagingType",
    "temba.channels.types.freshchat.FreshChatType",
    "temba.channels.types.globe.GlobeType",
    "temba.channels.types.highconnection.HighConnectionType",
    "temba.channels.types.hormuud.HormuudType",
    "temba.channels.types.hub9.Hub9Type",
    "temba.channels.types.i2sms.I2SMSType",
    "temba.channels.types.infobip.InfobipType",
    "temba.channels.types.instagram.InstagramType",
    "temba.channels.types.jasmin.JasminType",
    "temba.channels.types.jiochat.JioChatType",
    "temba.channels.types.justcall.JustCallType",
    "temba.channels.types.kaleyra.KaleyraType",
    "temba.channels.types.kannel.KannelType",
    "temba.channels.types.line.LineType",
    "temba.channels.types.m3tech.M3TechType",
    "temba.channels.types.macrokiosk.MacrokioskType",
    "temba.channels.types.mblox.MbloxType",
    "temba.channels.types.messagebird.MessageBirdType",
    "temba.channels.types.messangi.MessangiType",
    "temba.channels.types.mtn.MtnType",
    "temba.channels.types.mtarget.MtargetType",
    "temba.channels.types.novo.NovoType",
    "temba.channels.types.playmobile.PlayMobileType",
    "temba.channels.types.plivo.PlivoType",
    "temba.channels.types.rocketchat.RocketChatType",
    "temba.channels.types.signalwire.SignalWireType",
    "temba.channels.types.slack.SlackType",
    "temba.channels.types.smscentral.SMSCentralType",
    "temba.channels.types.somleng.SomlengType",
    "temba.channels.types.start.StartType",
    "temba.channels.types.telegram.TelegramType",
    "temba.channels.types.telesom.TelesomType",
    "temba.channels.types.thinq.ThinQType",
    "temba.channels.types.turn.TurnType",
    "temba.channels.types.twilio_messaging_service.TwilioMessagingServiceType",
    "temba.channels.types.twilio_whatsapp.TwilioWhatsappType",
    "temba.channels.types.twilio.TwilioType",
    "temba.channels.types.viber.ViberType",
    "temba.channels.types.vk.VKType",
    "temba.channels.types.vonage.VonageType",
    "temba.channels.types.wavy.WavyType",
    "temba.channels.types.webchat.WebChatType",
    "temba.channels.types.wechat.WeChatType",
    "temba.channels.types.whatsapp.WhatsAppType",
    "temba.channels.types.yo.YoType",
    "temba.channels.types.zenvia_sms.ZenviaSMSType",
    "temba.channels.types.zenvia_whatsapp.ZenviaWhatsAppType",
    "temba.channels.types.android.AndroidType",
]

# the help sites a helpdesk can be imported from, by class name - none in the core; a deployment adds its own
HELPDESK_IMPORT_TYPES = []

LLM_TYPES = {
    "temba.ai.types.anthropic.type.AnthropicType": {
        # model id -> max output tokens
        "models": {
            "claude-opus-4-8": 128_000,
            "claude-opus-4-7": 128_000,
            "claude-opus-4-5-20251101": 64_000,
            "claude-sonnet-5": 128_000,
            "claude-sonnet-4-6": 128_000,
            "claude-haiku-4-5-20251001": 64_000,
        },
    },
    "temba.ai.types.google.type.GoogleType": {
        "models": {
            "gemini-3.6-flash": 65_536,
            "gemini-3.5-flash": 65_536,
            "gemini-3.5-flash-lite": 65_536,
            "gemini-2.5-flash": 65_536,
        },
    },
    "temba.ai.types.openai.type.OpenAIType": {
        "models": {
            "gpt-5.6-sol": 128_000,
            "gpt-5.6-terra": 128_000,
            "gpt-5.6-luna": 128_000,
            "gpt-5.5": 128_000,
            "gpt-5.4": 128_000,
            "gpt-5.4-mini": 128_000,
            "gpt-4.1": 32_768,
            "gpt-4.1-mini": 32_768,
            "gpt-4.1-nano": 32_768,
            "gpt-4o": 16_384,
            "gpt-4o-mini": 16_384,
            "gpt-3.5-turbo": 4_096,
        },
    },
}
if TESTING:
    LLM_TYPES["temba.ai.types.openai_azure.type.OpenAIAzureType"] = {"models": {"gpt-35-turbo": 4_096}}


# set of ISO-639-3 codes of languages to allow in addition to all ISO-639-1 languages
NON_ISO6391_LANGUAGES = {"mul", "und"}

# -----------------------------------------------------------------------------------
# Mailroom
# -----------------------------------------------------------------------------------

MAILROOM_URL = None
MAILROOM_AUTH_TOKEN = None

# -----------------------------------------------------------------------------------
# WebSockets (realtime messaging server)
# -----------------------------------------------------------------------------------

# shared secret the websockets API requires in the X-Websockets-Secret header; required (see temba.api.checks) and
# left unset here so each deployment must configure it
WEBSOCKETS_AUTH_SECRET = None

# -----------------------------------------------------------------------------------
# Data Model
# -----------------------------------------------------------------------------------

GLOBAL_VALUE_SIZE = 10_000  # max length of global values

ORG_LIMIT_DEFAULTS = {
    "channels": 10,
    "contacts": 10_000_000,
    "fields": 250,
    "flows": 10_000,
    "globals": 250,
    "groups": 250,
    "knowledge": 10,
    "labels": 250,
    "llms": 10,
    "teams": 50,
    "topics": 50,
    "triggers": 250,
}

RETENTION_PERIODS = {
    "articlecount": timedelta(days=90),
    "channelevent": timedelta(days=90),
    "channellog": timedelta(days=7),
    "export": timedelta(days=90),
    "flowsession": timedelta(days=7),
    "httplog": timedelta(days=3),
    "llmcount": timedelta(days=30),
    "notification": timedelta(days=30),
    "syncevent": timedelta(days=7),
    "webhookevent": timedelta(hours=48),
}

# -----------------------------------------------------------------------------------
# 3rd Party Integrations
# -----------------------------------------------------------------------------------

MAILGUN_API_KEY = os.environ.get("MAILGUN_API_KEY", "")

ZENDESK_CLIENT_ID = os.environ.get("ZENDESK_CLIENT_ID", "")
ZENDESK_CLIENT_SECRET = os.environ.get("ZENDESK_CLIENT_SECRET", "")


#    1. Create an Facebook app on https://developers.facebook.com/apps/
#
#    2. Copy the Facebook Application ID
#
#    3. From Settings > Basic, show and copy the Facebook Application Secret
#
#    4. Generate a Random Secret to use as Facebook Webhook Secret as described
#       on https://developers.facebook.com/docs/messenger-platform/webhook#setup
#
FACEBOOK_APPLICATION_ID = os.environ.get("FACEBOOK_APPLICATION_ID", "MISSING_FACEBOOK_APPLICATION_ID")
FACEBOOK_APPLICATION_SECRET = os.environ.get("FACEBOOK_APPLICATION_SECRET", "MISSING_FACEBOOK_APPLICATION_SECRET")
FACEBOOK_WEBHOOK_SECRET = os.environ.get("FACEBOOK_WEBHOOK_SECRET", "MISSING_FACEBOOK_WEBHOOK_SECRET")

# Facebook login for business config IDs
FACEBOOK_LOGIN_WHATSAPP_CONFIG_ID = os.environ.get("FACEBOOK_LOGIN_WHATSAPP_CONFIG_ID", "")
FACEBOOK_LOGIN_INSTAGRAM_CONFIG_ID = os.environ.get("FACEBOOK_LOGIN_INSTAGRAM_CONFIG_ID", "")
FACEBOOK_LOGIN_MESSENGER_CONFIG_ID = os.environ.get("FACEBOOK_LOGIN_MESSENGER_CONFIG_ID", "")

WHATSAPP_ADMIN_SYSTEM_USER_ID = os.environ.get("WHATSAPP_ADMIN_SYSTEM_USER_ID", "MISSING_WHATSAPP_ADMIN_SYSTEM_USER_ID")
WHATSAPP_ADMIN_SYSTEM_USER_TOKEN = os.environ.get(
    "WHATSAPP_ADMIN_SYSTEM_USER_TOKEN", "MISSING_WHATSAPP_ADMIN_SYSTEM_USER_TOKEN"
)
WHATSAPP_FACEBOOK_BUSINESS_ID = os.environ.get("WHATSAPP_FACEBOOK_BUSINESS_ID", "MISSING_WHATSAPP_FACEBOOK_BUSINESS_ID")

# IP Addresses
# These are the externally accessible IP addresses of the servers running RapidPro.
# Needed for channel types that authenticate by whitelisting public IPs.
#
# You need to change these to real addresses to work with these.
IP_ADDRESSES = ("172.16.10.10", "162.16.10.20")

# -----------------------------------------------------------------------------------
# AllAuth
# -----------------------------------------------------------------------------------

AUTHENTICATION_BACKENDS = [
    "allauth.account.auth_backends.AuthenticationBackend",
]

ACCOUNT_FORMS = {
    "login": "temba.users.forms.TembaLoginForm",
    "signup": "temba.users.forms.TembaSignupForm",
    "change_password": "temba.users.forms.TembaChangePasswordForm",
    "add_email": "temba.users.forms.TembaAddEmailForm",
}

ACCOUNT_ADAPTER = "temba.users.adapter.TembaAccountAdapter"
SOCIALACCOUNT_ADAPTER = "temba.users.adapter.TembaSocialAccountAdapter"

MFA_ADAPTER = "temba.users.adapter.TembaMFAAdapter"

SOCIALACCOUNT_PROVIDERS = {}
SOCIALACCOUNT_EMAIL_AUTHENTICATION_AUTO_CONNECT = True
SOCIALACCOUNT_LOGIN_ON_GET = True

# maps email domains whose users should be logging in with SSO to the (translatable) warning shown to those still
# logging in with a password
SSO_LOGIN_WARNING_DOMAINS = {}
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"

ACCOUNT_LOGIN_METHODS = ("email",)
ACCOUNT_EMAIL_VERIFICATION = "mandatory"
ACCOUNT_EMAIL_NOTIFICATIONS = True
ACCOUNT_UNIQUE_EMAIL = True
ACCOUNT_CHANGE_EMAIL = True
ACCOUNT_DEFAULT_HTTP_PROTOCOL = "https"
ACCOUNT_USER_MODEL_USERNAME_FIELD = None
ACCOUNT_SESSION_REMEMBER = True


ACCOUNT_LOGIN_ON_EMAIL_CONFIRMATION = True
ACCOUNT_CONFIRM_EMAIL_ON_GET = True

ACCOUNT_SIGNUP_FIELDS = ["email*", "password1"]

if TESTING:
    ACCOUNT_RATE_LIMITS = False  # rate limit state in the cache would otherwise persist between test runs
