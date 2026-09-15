from django import template

from temba.channels.models import ChannelLog
from temba.ivr.models import Call
from temba.msgs.models import Msg

register = template.Library()


@register.inclusion_tag("channels/tags/channel_log_link.html", takes_context=True)
def channel_log_link(context, obj):
    assert isinstance(obj, (Msg, Call)), "tag only supports Msg or Call instances"

    return {"logs_url": ChannelLog.get_read_url(obj, context["user"], context["user_org"])}


@register.simple_tag
def channel_callback(channel, action: str) -> str:
    """
    Gets the URL on which courier handles the given action for the given channel
    """
    return channel.courier_url(action)
