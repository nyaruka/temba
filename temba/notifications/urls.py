from django.urls import path

from .views import IncidentCRUDL, NotificationCRUDL, UnsubscribeView

urlpatterns = IncidentCRUDL().as_urlpatterns()
urlpatterns += NotificationCRUDL().as_urlpatterns()
urlpatterns += [
    path(
        "notification/unsubscribe/<str:token>/",
        UnsubscribeView.as_view(),
        name="notifications.notification_unsubscribe",
    )
]
