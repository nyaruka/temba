Unreleased
----------
* Update RapidPro Ireland to v26.2.2
* Fix Instagram reconnect: use Facebook OAuth redirect instead of FB.login popup, reuse the claim redirect URI already whitelisted in Meta, and return a clear error when the linked page is missing from the token (no 500)

1.8.8-rapidpro-26.0.0
----------
* Make Turn.io available for all org

1.8.5-rapidpro-10.2.4
----------
* Add Microsoft SSO
* Make sure beta only channels cannot be enabled/disabled by admin unless staff or beta user

1.8.4-rapidpro-10.2.4
----------
* Get back with bothub

1.8.3-rapidpro-10.2.4
----------
* Fix error to get User in API

1.8.2-rapidpro-10.2.4
----------
* Update to v10.2.4

1.8.2-rapidpro-10.2.0
----------
* Update to v10.2.0

1.8.2-rapidpro-10.0.0
----------
* Avoid index error in view

1.8.1-rapidpro-10.0.0
----------
* Avoid negative index error

1.8.0-rapidpro-10.0.0
----------
* Support for creating WAC channel for previously registered numbers

1.7.36-rapidpro-10.0.0
----------
* Change AWS_S3_ADDESSING_STYLE to be a environ variable

1.7.35-rapidpro-10.0.0
----------
* Add get_bulk_action_labels to ContactCRUDL Group class

1.7.34-rapidpro-10.0.0
----------
* Update node version in Dockerfile

1.7.33-rapidpro-10.0.0
----------
* Remove any reference from weni-rp-apps
* Remove tickets types

1.7.32-rapidpro-10.0.0
----------
* Fix: AWS region

1.7.31-rapidpro-10.0.0
----------
* Update RapidPro with version 10.0.0

1.7.31-rapidpro-9.3.142
----------
* Update RapidPro with version 9.3.142

1.7.31-rapidpro-9.2.5
----------
* Update RapidPro with version 9.2.5

1.7.31-rapidpro-9.2.0
----------
* Update RapidPro with version 9.2.0

1.7.31-rapidpro-9.1.198
----------
* Update RapidPro with version 9.1.198

1.7.31-rapidpro-9.0.0
----------
* Change media upload to be static

1.7.30-rapidpro-9.0.0
----------
* Update RapidPro with version 9.0.0

1.7.30-rapidpro-8.3.123
----------
* Fix: settings branding syntax error

1.7.29-rapidpro-8.3.123
----------
* Update RapidPro with version 8.3.123

1.7.29-rapidpro-8.2.0
----------
* Feat: Allow variable org channels limit

1.7.28-rapidpro-8.2.0
----------
* Fix: WhatsApp Cloud connect context data

1.7.27-rapidpro-8.2.0
----------
* Fix: S3 storages

1.7.26-rapidpro-8.2.0
----------
* Fix: BRAND setting

1.7.25-rapidpro-8.2.0
----------
* Update RapidPro with version 8.2.0

1.7.25-rapidpro-8.0.1
----------
* Update django storages version to 1.14.3

1.7.24-rapidpro-8.0.1
----------
* Update RapidPro with version 8.0.1
* Fix: incorrect js identation

1.7.23-rapidpro-7.5.149
----------
* Update RapidPro with version 7.5.149

1.7.23-rapidpro-7.5.129
----------
* Add business_management permission for instagram and facebook

1.7.22-rapidpro-7.5.129
----------
* Fix error in org/manage url

1.7.21-rapidpro-7.5.129
----------
* Fix: WhatsApp Cloud connect
* Fix: Add WhatsApp Cloud connect permission to admin

1.7.20-rapidpro-7.5.129
----------
* Hotfix: Update python-dateutil lib and WhatsappCloud type

1.7.19-rapidpro-7.5.129
----------
* Update python-dateutil lib version
* Show WhatsAppCloud in add channels

1.7.18-rapidpro-7.5.129
----------
* Fix branding

1.7.17-rapidpro-7.5.129
----------
* Fix branding hosts

1.7.16-rapidpro-7.5.129
----------
* Fix compress and branding

1.7.15-rapidpro-7.5.129
----------
* Fix invalid template name

1.7.14-rapidpro-7.5.129
----------
* Update RapidPro with version 7.5.129

1.7.14-rapidpro-7.5.91
----------
* Feat: New Embed Signup process

1.7.13-rapidpro-7.5.91
----------
* Fix: ChannelLog HttpLog import order

1.7.12-rapidpro-7.5.91
----------
* Fix: ChannelLog mask variable

1.7.11-rapidpro-7.5.91
----------
* Fix: Update floweditor manifest import

1.7.10-rapidpro-7.5.91
----------
* Fix: Duplicated footer on ticket and no_nav pages

1.7.9-rapidpro-7.5.91
----------
* Fix: Add redirect key into branding

1.7.8-rapidpro-7.5.91
----------
* Fix: Frame duplicated macro block usage
* Update FlowEditor to 1.2.1

1.7.7-rapidpro-7.5.91
----------
* Update: RapidPro to version 7.5.91

1.7.7-rapidpro-7.4.2
----------
* Fix: Resolve condition to ignore empty bucket

1.7.6-rapidpro-7.4.2
----------
* Add condition to ignore empty bucket

1.7.5-rapidpro-7.4.2
----------
* Remove Facebook login redirect

1.7.4-rapidpro-7.4.2
----------
* Update rp-version to fix django_url error

1.7.3-rapidpro-7.4.2
----------
* Fix: WhatsApp Cloud Connect

1.7.2-rapidpro-7.4.2
----------
* Fix: Fix error in create contact and update rp-apps version

1.7.1-rapidpro-7.4.2
----------
* Fix: WhatsApp cloud connect behavior

1.7.0-rapidpro-7.4.2
----------
* Use Weni Floweditor from package.json

1.6.22-rapidpro-7.4.2
----------
* Update Rapidpro to version 7.4.2
* Fix: Add instance check on contact field form
* Update django-compressor to 4.3.1
* Feat: branding inactive threshold env
* Fix: Missing aws querystring auth and codecov

1.6.21-rapidpro-7.1.27
----------
* Update weni-rp-apps from 2.1.2 to 2.1.3

1.6.20-rapidpro-7.1.27
----------
* Transforms ContactImport model constants into environment variables

1.6.19-rapidpro-7.1.27
----------
* Update gunicorn start

1.6.18-rapidpro-7.1.27
----------
* fix: case removal and reorder on expression and field routers [flow-editor #19](https://github.com/Ilhasoft/floweditor/pull/19)
* fix: change the has_issues field to False, when create flow

1.6.17-rapidpro-7.1.27
----------
* Fix: add weni.s3 to installed_apps

1.6.16-rapidpro-7.1.27
----------
* Revert "fix: add weni.s3 to installed_apps"

1.6.15-rapidpro-7.1.27
----------
* Update weni-rp-apps from 2.0.1 to 2.1.0
* Add activities app on INSTALLED_APPS
* fix: add weni.s3 to installed_apps
* feat: Adjustment in welcome flow

1.6.14-rapidpro-7.1.27
----------
* Add Courier S3 endpoint env key
* Update weni-rp-apps to 2.0.1

1.6.13-rapidpro-7.1.27
----------
* Adds exclusion list of channels that go to integrations
* Update rp-apps to 2.0.0

1.6.12-rapidpro-7.1.27
----------
* Create endpoint that returns success orgs

1.6.11-rapidpro-7.1.27
----------
* Update weni-rp-apps package to support gRPC-REST conversion

1.6.10-rapidpro-7.1.27
----------
* Internal ticketer conditional on org initialize

1.6.9-rapidpro-7.1.27
----------
* Modify contact history request trigger method to `load`

1.6.8-rapidpro-7.1.27
----------
* Add weni-rp-apps orgs_api app

1.6.7-rapidpro-7.1.27
----------
* Weni announcement as billing alert

1.6.6-rapidpro-7.1.27
----------
* Add ticketer name input field on twilioflex connect #380

1.6.5-rapidpro-7.1.27
----------
* Env for `refresh_whatsapp_templates` task time schedule

1.6.4-rapidpro-7.1.27
----------
* Improve `trim_channel_logs_task` performance by splitting the query

1.6.3-rapidpro-7.1.27
----------
* Bump weni-rp-apps from 1.0.28 to 1.0.29
* Locks the Poetry version to 1.1.15 #371

1.6.2-rapidpro-7.1.27
----------
* Improve trim_http_logs_task performance by splitting the query

1.6.1-rapidpro-7.1.27
----------
* Bump weni-rp-apps from 1.0.27 to 1.0.28

1.6.0-rapidpro-7.1.27
----------
* Bump weni-rp-apps from 1.0.26 to 1.0.27
* connect wenichats ticketer integration
* Enable CORS on Rapidpro
* fix: sidemenu padding
* Downgrade Sentry version from 1.9.9 to 1.9.8

1.5.9-rapidpro-7.1.27
----------
* Bump weni-rp-apps from 1.0.25 to 1.0.26

1.5.8-rapidpro-7.1.27
----------
* Remove gcc dependencies from Dockerfile

1.5.7-rapidpro-7.1.27
----------
* Lock dulwich package version into 0.20.45

1.5.6-rapidpro-7.1.27
----------
* Add build dependencies on Dockerfile

1.5.5-rapidpro-7.1.27
----------
* Update gunicorn to support max_requests #348 

1.5.4-rapidpro-7.1.27
----------
* Bump weni-rp-apps from 1.0.24 to 1.0.25

1.5.3-rapidpro-7.1.27
----------
* Adjust weni.internal in INSTALLED_APPS

1.5.2-rapidpro-7.1.27
----------
* Add weni.internals to INSTALLED_APPS

1.5.1-rapidpro-7.1.27
----------
* Bump weni-rp-apps from 1.0.22 to 1.0.23
* add iframe post message on editor load

1.5.0-rapidpro-7.1.27
----------
* Feat: Hide org config fields
* Remove mozilla_django_oidc SessionRefresh middleware
* RocketChat Ticketer out of beta

1.4.0-rapidpro-7.1.27
----------
* Integration support with Microsoft Teams

1.3.5-rapidpro-7.1.27
----------
* Update FB api version to 14.0 to get templates for WhatsApp Cloud
* Redirect advice #325 

1.3.4-rapidpro-7.1.27
----------
* Fix message templates syncing for new categories #321 (Nyaruka refference change api facebook version)

1.3.3-rapidpro-7.1.27
----------
* Fix Facebook channel creation #319 

1.3.2-rapidpro-7.1.27
----------
* Update weni-rp-apps to 1.0.20

1.3.1-rapidpro-7.1.27
----------
* Update weni-rp-apps to 1.0.19

1.3.0-rapidpro-7.1.27
----------
* Update weni-rp-apps to 1.0.18
* WhatsApp Cloud New Channel Feature
* Slack channel

1.2.7-rapidpro-7.1.27
----------
* Link translation using MutationObserver for FlowEditor links

1.2.6-rapidpro-7.1.27
----------
* RapidPro updated to v7.1.27

1.2.6-rapidpro-7.0.4
----------
 * HelpHero iframe event

1.2.5-rapidpro-7.0.4
----------
 * Helphero integration
 * New Sample Flow

1.2.4-rapidpro-7.0.4
----------
 * New Weni announcement
 * Option to disable OIDC Authentication

1.2.3-rapidpro-7.0.4
----------
 * Update weni-rp-apps to 1.0.16

1.2.2-rapidpro-7.0.4
----------
 * Update weni-rp-apps to 1.0.15
 * Change twilioflex form labels and help text

1.2.1-rapidpro-7.0.4
----------
 * Change refresh templates task schedule to 1h

1.2.0-rapidpro-7.0.4
----------
 * Add ticketer Twilio Flex

1.1.8-rapidpro-7.0.4
----------
 * Added option to exclude channels from claim view when not in the Weni Flows design

1.1.7-rapidpro-7.0.4
----------
 * Added LogRocket in place of Hotjar

1.1.6-rapidpro-7.0.4
----------
 * Add subscribed_apps permission for Instagram Channel
 * Feature to limit recovery password to 5 times in 12 hours.

1.1.5-rapidpro-7.0.4
----------
 * Update weni-rp-apps to 1.0.13
 * Add pages_read_engagement permission for Instagram
 * Fix: back button history behavior 
 * Downgrade elasticsearch version to 7.13.4

1.1.4-rapidpro-7.0.4
----------
 * Update weni-rp-apps to 1.0.12

1.1.3-rapidpro-7.0.4
----------
 * Fix: Use original filename instead uuid at end of path on upload attachment

1.1.2-rapidpro-7.0.4
----------
 * Fix: Branding with privacy url

1.1.1-rapidpro-7.0.4
----------
 * Fix: Kyrgyzstan whatsapp language code

1.1.0-rapidpro-7.0.4
----------
 * Merge instagram channel
 * Lock weni-rp-apps to 1.0.8
 * Feat/back button missing

1.0.7-rapidpro-7.0.4
----------
 * Fix: Gujarati whatsapp language code

1.0.6-rapidpro-7.0.4
----------
 * Add background flow type, location support and title variables in branding info.

1.0.5-rapidpro-7.0.4
----------
 * set NON_ISO6391_LANGUAGES on temba/settings.py.prod

1.0.4-rapidpro-7.0.4
----------
 * fixed CELERY_BROKER_URL

1.0.3-rapidpro-7.0.4
----------
 * DATABASES["readonly"] setting fixed

1.0.2-rapidpro-7.0.4
----------
 * Removed old two-factor authentication

1.0.1-rapidpro-7.0.4
----------
* RapidPro updated to v7.0.4
  * Settings updated on temba/settings.py.prod
    * LOG_TRIM_* variables replaced by RETENTION_PERIODS
    * CELERYBEAT_SCHEDULE updated to CELERY_BEAT_SCHEDULE
* Python updated to 3.9

1.0.1-rapidpro-6.5.15
----------
 * Downgrade psycopg2-binary version to 2.8.6 
 * Removes discontinued elasticapm processor 
 * Add weni-rp-apps to pip dependencies

1.0.0-rapidpro-6.5.15
----------
 * RapidPro v6.5.15
 * Dockerfile with python 3.6 and NodeJS 12
 * Dockerfile with Varnish 6.0 for static files caching
 * Added APM
 * Added log config
 * Allowed 32MB of client body size
 * Added a new env var to enable/disable existing loggers
 * Added weni-rp-apps into INSTALLED_APPS
 * Added Custom layout for use within Weni Connect
 * Enabled authentication from OIDC
 * Enabled CSP configuration
 * Removed Authorization from webhookresult and channellog requests on read
 * Added communication with Weni Connect via PostMessage
