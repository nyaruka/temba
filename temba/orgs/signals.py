from django.dispatch import Signal

pre_org_switch = Signal()

# sent with org and status when a workspace's status changes, including by following its parent's
org_status_changed = Signal()
