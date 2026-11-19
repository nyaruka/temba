from django.dispatch import Signal

pre_org_switch = Signal()

# sent with org and status when a workspace's status changes, e.g. to notify its admins
org_status_changed = Signal()
