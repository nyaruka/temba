__version__ = "26.3.213"

# This will make sure the app is always imported when
# Django starts so that shared_task will use this app.
from .temba_celery import app as celery_app  # noqa
