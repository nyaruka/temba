import { html, TemplateResult } from 'lit';
import { ifDefined } from 'lit-html/directives/if-defined.js';
import {
  AirtimeCreatedEvent,
  AirtimeTransferredEvent,
  CallEvent,
  ChatStartedEvent,
  ContactEmailChangedEvent,
  ContactGroupsEvent,
  ContactLanguageChangedEvent,
  ContactStatusChangedEvent,
  NameChangedEvent,
  OptInEvent,
  RunEvent,
  TicketEvent,
  UpdateFieldEvent,
  URNsChangedEvent
} from '../events';
import { getLanguageName } from '../languages';
import { formatCount } from '../utils';

export enum Events {
  AIRTIME_CREATED = 'airtime_created',
  AIRTIME_TRANSFERRED = 'airtime_transferred',
  BROADCAST_CREATED = 'broadcast_created',
  CALL_CREATED = 'call_created',
  CALL_MISSED = 'call_missed',
  CALL_RECEIVED = 'call_received',
  CHAT_STARTED = 'chat_started',
  CONTACT_EMAIL_CHANGED = 'contact_email_changed',
  CONTACT_FIELD_CHANGED = 'contact_field_changed',
  // ephemeral, updates contact state instead of rendering as history
  CONTACT_FLOW_CHANGED = 'contact_flow_changed',
  CONTACT_GROUPS_CHANGED = 'contact_groups_changed',
  CONTACT_LANGUAGE_CHANGED = 'contact_language_changed',
  // ephemeral, updates contact state instead of rendering as history
  CONTACT_LAST_SEEN_CHANGED = 'contact_last_seen_changed',
  CONTACT_NAME_CHANGED = 'contact_name_changed',
  CONTACT_STATUS_CHANGED = 'contact_status_changed',
  CONTACT_URNS_CHANGED = 'contact_urns_changed',
  EMAIL_CREATED = 'email_created',
  EMAIL_SENT = 'email_sent',
  ERROR = 'error',
  FAILURE = 'failure',
  FLOW_ENTERED = 'flow_entered',
  INPUT_LABELS_ADDED = 'input_labels_added',
  IVR_CREATED = 'ivr_created',
  MSG_CREATED = 'msg_created',
  MSG_RECEIVED = 'msg_received',
  OPTIN_REQUESTED = 'optin_requested',
  OPTIN_STARTED = 'optin_started',
  OPTIN_STOPPED = 'optin_stopped',
  RESTHOOK_CALLED = 'resthook_called',
  RUN_ENDED = 'run_ended',
  RUN_RESULT_CHANGED = 'run_result_changed',
  RUN_STARTED = 'run_started',
  SERVICE_CALLED = 'service_called',
  SESSION_TRIGGERED = 'session_triggered',
  TICKET_ASSIGNEE_CHANGED = 'ticket_assignee_changed',
  TICKET_CLOSED = 'ticket_closed',
  TICKET_NOTE_ADDED = 'ticket_note_added',
  TICKET_OPENED = 'ticket_opened',
  TICKET_REOPENED = 'ticket_reopened',
  TICKET_TOPIC_CHANGED = 'ticket_topic_changed',
  // ephemeral, drives the chat's typing indicator instead of recording
  // history - published by agents as they compose and never persisted
  TYPING_STARTED = 'typing_started',
  TYPING_STOPPED = 'typing_stopped',
  WARNING = 'warning',
  WEBHOOK_CALLED = 'webhook_called'
}

/**
 * Renders a single DS pill of the given type. temba-label auto-resolves
 * the icon from `type` (via PILL_TYPE_ICONS), so we don't pass `icon`
 * unless the consumer explicitly overrides it. When `href` is provided
 * the pill is wrapped in a navigation anchor (SPA goto); otherwise it's
 * rendered inline as a plain pill. Single source of truth for the
 * "entity pill in chat history" look — inline margin keeps wrapping
 * airy, and inline style works regardless of host-page Tailwind reach.
 *
 * Pills carry no native `title` — hover detail (verb, actor, time)
 * lives in the rich tooltip renderEvent wraps around each event.
 */
const renderEntityPill = (
  pillType: string,
  name: string,
  opts: {
    href?: string;
    icon?: string;
    prefixIcon?: string;
  } = {}
): TemplateResult => {
  // max-width lets a long name (flows especially) ellipsize inside the
  // pill instead of blowing out the event line. The wrapping anchor
  // needs the same cap plus min-width:0 — as a flex item it would
  // otherwise refuse to shrink below the pill's full content size,
  // defeating the ellipsis. --label-min-width keeps a couple of
  // characters visible when a pill is squeezed here, so it never
  // collapses to bare chrome (icon + ellipsis) in a tight event line.
  const pill = html`<temba-label
    type=${pillType}
    icon=${ifDefined(opts.icon)}
    prefix-icon=${ifDefined(opts.prefixIcon)}
    ?clickable=${!!opts.href}
    style="margin: 1px 2px; vertical-align: middle; max-width: 100%; --label-min-width: 2em;"
    >${name}</temba-label
  >`;
  // text-decoration: none matters here - flex blockifies the label,
  // and unlike the old inline layout an anchor's underline propagates
  // into block-level children, underlining the pill text.
  return opts.href
    ? html`<a
        href=${opts.href}
        onclick="goto(event, this)"
        style="vertical-align: middle; display: inline-flex; min-width: 0; max-width: 100%; text-decoration: none;"
        >${pill}</a
      >`
    : pill;
};

/**
 * Renders a single group addition or removal as a self-contained
 * pill linking to the group, following the fixed pill convention:
 * the group name on the left, the bold verb on the right — " Drivers
 * | Added " / " Farmers | Removed " — with the red removal variant
 * reinforcing removals (it has no default icon, so the group icon is
 * set explicitly there).
 */
const groupPill = (group: any, removed = false): TemplateResult =>
  attributePill(group.name, removed ? 'Removed' : 'Added', {
    type: removed ? 'removed' : 'group',
    icon: removed ? 'group' : undefined,
    href: `/contact/group/${group.uuid}/`
  });

const flowPill = (flow: any, opts: { prefixIcon?: string } = {}) =>
  renderEntityPill('flow', flow.name, {
    href: `/flow/editor/${flow.uuid}/`,
    ...opts
  });

const topicPill = (topic: any) =>
  renderEntityPill('topic', topic.name, {
    href: `/ticket/${topic.uuid}/open/`
  });

/**
 * Renders a ticket lifecycle change as a self-contained pill linking
 * to the ticket, following the fixed pill convention: label on the
 * left (a user or "Ticket") and the bold verb on the right, e.g.
 * " Sally Sue | Assigned ". Uses the topic (orange) variant so
 * everything ticket-related shares one color, with the agent icon
 * marking these as the ticket itself rather than a topic change.
 * The acting user is named (with an avatar) in the rich hover
 * tooltip renderEvent attaches.
 */
const ticketPill = (opts: {
  uuid: string;
  name?: string;
  folder?: string;
  verb: string;
}) =>
  attributePill(opts.name || 'Ticket', opts.verb, {
    type: 'topic',
    icon: 'tickets',
    href: `/ticket/all/${opts.folder || 'open'}/${opts.uuid}/`
  });

const getUserName = (user: any): string =>
  user.name || [user.first_name, user.last_name].filter(Boolean).join(' ');

// thin currentColor rule separating the attribute name from its value
// inside an attribute pill — picks up each variant's text color
const attributeDividerStyle =
  'display: inline-block; width: 1px; height: 11px; background: currentColor; opacity: 0.3; margin: 0 6px; vertical-align: -2px;';

// either half of an attribute pill — capped so a long name or value
// can't stretch the pill across the chat
const attributeSideStyle = (maxWidth = '18em') =>
  `display: inline-block; max-width: ${maxWidth}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom;`;

/**
 * Renders a name/value pair as a single self-contained pill: the
 * name, a thin divider, then the bolded value — e.g. " Age | 43 " or
 * " Update Info | Completed ". The layout is a fixed convention
 * across every event pill: label on the left, value on the right,
 * bold on the right. A null value renders as an italic "cleared".
 * Both sides truncate — the full text lives in the rich hover
 * tooltip renderEvent attaches, so no native titles here.
 * TemplateResult values (e.g. a temba-date) are passed through
 * bolded. With `href` the pill wraps in a navigation anchor, same
 * as renderEntityPill.
 */
const attributePill = (
  name: string,
  value: string | TemplateResult | null,
  opts: {
    type?: string;
    icon?: string;
    href?: string;
    nameMaxWidth?: string;
  } = {}
): TemplateResult => {
  const valueContent =
    value === null
      ? html`<span style="font-style: italic; opacity: 0.7;">cleared</span>`
      : typeof value === 'string'
        ? html`<span style="${attributeSideStyle()} font-weight: 600;"
            >${value}</span
          >`
        : html`<span style="font-weight: 600;">${value}</span>`;
  const nameContent = html`<span style=${attributeSideStyle(opts.nameMaxWidth)}
    >${name}</span
  >`;
  const pill = html`<temba-label
    type=${opts.type || 'neutral'}
    icon=${ifDefined(opts.icon)}
    ?clickable=${!!opts.href}
    style="margin: 1px 2px; vertical-align: middle;"
    >${nameContent}<span style=${attributeDividerStyle}></span
    >${valueContent}</temba-label
  >`;
  return opts.href
    ? html`<a
        href=${opts.href}
        onclick="goto(event, this)"
        style="vertical-align: middle;"
        >${pill}</a
      >`
    : pill;
};

/**
 * Inline-flex wrapper style that text + pills share. Without it,
 * plain text sits on its own baseline while vertical-align: middle
 * pills sit slightly above and the text appears to "float". flex
 * centering keeps the row of words and pills on one cross-axis.
 */
// min-height keeps the row a consistent height across renderers
// whether or not they contain a pill (which is ~22px tall) — without
// it, plain-text events like "Cleared language" sit a few pixels
// shorter than "Removed from <group pill>" and the chat history
// looks unevenly spaced.
const eventLineStyle =
  'display: inline-flex; align-items: center; flex-wrap: wrap; justify-content: center; gap: 2px 4px; min-height: 24px;';

export const renderRunEvent = (event: RunEvent): TemplateResult => {
  // follows the fixed pill convention: label (flow name) on the
  // left, bold value (the run state) on the right — " Update Info |
  // Completed " — matching how field pills read. Runs cut short
  // (interrupted / expired) use the red removal variant, matching
  // group removals; that variant has no default icon so the flow
  // icon is set explicitly.
  let verb = 'Started';
  let cutShort = false;
  if (event.type === Events.RUN_ENDED) {
    if (event.status === 'completed') {
      verb = 'Completed';
    } else if (event.status === 'expired') {
      verb = 'Expired';
      cutShort = true;
    } else {
      verb = 'Interrupted';
      cutShort = true;
    }
  }

  return html`<div style=${eventLineStyle}>
    ${attributePill(event.flow.name, verb, {
      type: cutShort ? 'removed' : 'flow',
      icon: cutShort ? 'flow' : undefined,
      href: `/flow/editor/${event.flow.uuid}/`,
      // flow names run long — cap them harder than other pill labels
      nameMaxWidth: '160px'
    })}
  </div>`;
};

export const renderChatStartedEvent = (
  event: ChatStartedEvent
): TemplateResult => {
  return html`<div style=${eventLineStyle}>
    ${renderEntityPill(
      'neutral',
      event.params ? 'Chat referral' : 'Chat started',
      {
        icon: 'message'
      }
    )}
  </div>`;
};

export const renderUpdateEvent = (event: UpdateFieldEvent): TemplateResult => {
  // Treat both a missing value object and an empty-string text as a
  // cleared field — backfill / reset payloads sometimes arrive as
  // `value: { text: '' }`, which would otherwise render with an
  // empty value pill.
  const value = event.value;
  let display: string | TemplateResult | null = null;
  if (value && value.text) {
    // date values carry a typed datetime alongside the raw text — show
    // those through temba-date for short, locale-aware formatting
    display = value.datetime
      ? html`<temba-date value=${value.datetime} display="day"></temba-date>`
      : value.text;
  }
  return html`<div style=${eventLineStyle}>
    ${attributePill(event.field.name, display, { type: 'field' })}
  </div>`;
};

export const renderNameChanged = (event: NameChangedEvent): TemplateResult => {
  return html`<div style=${eventLineStyle}>
    ${attributePill('Name', event.name || null, { icon: 'contact' })}
  </div>`;
};

export const renderContactEmailChangedEvent = (
  event: ContactEmailChangedEvent
): TemplateResult => {
  return html`<div style=${eventLineStyle}>
    ${attributePill('Email', event.email || null, { icon: 'email' })}
  </div>`;
};

// strip the scheme and query string from a raw URN for display
// (e.g. "tel:+1234?channel=x" → "+1234"); a malformed URN without a
// scheme separator passes through as-is rather than throwing
const urnDisplayValue = (urn: string): string => {
  const parts = urn.split(':');
  return (parts.length > 1 ? parts[1] : urn).split('?')[0];
};

export const renderContactURNsChanged = (
  event: URNsChangedEvent
): TemplateResult => {
  // URNs are replaced as a set, so the whole set shares one pill —
  // the value truncates past 18em with the full list on hover
  const urns = (event.urns || []).map(urnDisplayValue);
  return html`<div style=${eventLineStyle}>
    ${attributePill('URNs', urns.length ? urns.join(', ') : null, {
      icon: 'at-sign'
    })}
  </div>`;
};

export const renderTicketAction = (
  event: TicketEvent,
  action: string
): TemplateResult => {
  const ticketUUID = event.ticket?.uuid || event.ticket_uuid;

  // Notes in the real chat history now go through Chat.ts#renderNote
  // (see ContactChat.ts: ticket_note_added bypasses prerender). This
  // path only runs for non-chat consumers (e.g. the flow Simulator).
  // Render notes as a simple inline italic line — the chat-bubble
  // styling lives in Chat.ts so the two can't drift.
  if (action === 'noted') {
    return event.note
      ? html`<div style="white-space: pre-wrap; font-style: italic;">
          ${event.note}
        </div>`
      : null;
  }

  // closed → ticket is in the closed folder now; reopened → it's
  // back in open, so the pill links to wherever the ticket actually
  // lives. Tickets are always closed by someone, so that user's name
  // is the pill's label ("Adam Ant | Closed") rather than a generic
  // "Ticket" — with the generic fallback kept for defensive safety.
  const folder = action === 'closed' ? 'closed' : 'open';
  const verb = action === 'closed' ? 'Closed' : 'Reopened';
  return html`<div style=${eventLineStyle}>
    ${ticketPill({
      uuid: ticketUUID,
      name:
        action === 'closed' && event._user
          ? getUserName(event._user)
          : undefined,
      folder,
      verb
    })}
  </div>`;
};

export const renderTicketAssigneeChanged = (
  event: TicketEvent
): TemplateResult => {
  const ticketUUID = event.ticket?.uuid || event.ticket_uuid;
  if (event.assignee) {
    // the assignee is the pill's label — who owns the ticket now is
    // the fact that matters. Who did the assigning lives in the
    // hover tooltip.
    return html`<div style=${eventLineStyle}>
      ${ticketPill({
        uuid: ticketUUID,
        name: getUserName(event.assignee),
        verb: 'Assigned'
      })}
    </div>`;
  }
  return html`<div style=${eventLineStyle}>
    ${ticketPill({
      uuid: ticketUUID,
      verb: 'Unassigned'
    })}
  </div>`;
};

export const renderTicketOpened = (event: TicketEvent): TemplateResult => {
  // the opened pill leads with the topic behind its topic icon, then
  // the assignee behind an inline agent icon when the event carries
  // one, each segment split by the standard divider before the bold
  // verb — e.g. " (topic) Billing | (agent) Sally Sue | Opened ".
  // Without a topic the assignee (behind the label-level agent icon)
  // is the whole label, and with neither it falls back to the
  // generic ticket pill. ticket_opened carries its assignee inside
  // the ticket envelope (unlike ticket_assignee_changed, where it's
  // on the event itself).
  const topic = event.ticket.topic;
  const assignee = event.ticket.assignee || event.assignee;

  if (!topic && !assignee) {
    return html`<div style=${eventLineStyle}>
      ${ticketPill({
        uuid: event.ticket.uuid,
        verb: 'Opened'
      })}
    </div>`;
  }

  // an inline agent icon marking the assignee segment when the topic
  // occupies the pill's leading (label-level) icon slot — aligned to
  // match the divider
  const inlineAgentIcon = html`<temba-icon
    name="tickets"
    style="display: inline-block; vertical-align: -2px; margin-right: 4px;"
  ></temba-icon>`;

  const pill = html`<temba-label
    type="topic"
    icon=${topic ? 'topic' : 'tickets'}
    clickable
    style="margin: 1px 2px; vertical-align: middle;"
    >${topic
      ? html`<span style=${attributeSideStyle()}>${topic.name}</span>`
      : null}${assignee
      ? html`${topic
            ? html`<span style=${attributeDividerStyle}></span>`
            : null}${inlineAgentIcon}<span style=${attributeSideStyle()}
            >${getUserName(assignee)}</span
          >`
      : null}<span style=${attributeDividerStyle}></span
    ><span style="font-weight: 600;">Opened</span></temba-label
  >`;

  return html`<div style=${eventLineStyle}>
    <a
      href=${`/ticket/all/open/${event.ticket.uuid}/`}
      onclick="goto(event, this)"
      style="vertical-align: middle;"
      >${pill}</a
    >
  </div>`;
};

export const renderContactGroupsEvent = (
  event: ContactGroupsEvent,
  withTooltips = false
): TemplateResult | null => {
  // a group event can carry several groups — with tooltips on (the
  // contact chat), each pill gets its own tip anchored to the hovered
  // pill, so the tips wrap per-pill here rather than renderEvent
  // wrapping the whole line
  const wrap = (pill: TemplateResult): TemplateResult =>
    withTooltips
      ? html`<temba-tip
          style="display: inline-block; max-width: 100%;"
          position="top"
          distance="4"
          arrow-size="18"
          interactive
          .content=${renderEventTooltip(event)}
          >${pill}</temba-tip
        >`
      : pill;

  const pills = [
    ...(event.groups_added || []).map((group) => wrap(groupPill(group))),
    ...(event.groups_removed || []).map((group) => wrap(groupPill(group, true)))
  ];
  if (pills.length === 0) {
    return null;
  }
  return html`<div style=${eventLineStyle}>${pills}</div>`;
};

/**
 * Renders a run of informational events as a single collapsed
 * summary pill — the unique set of icons for what's inside followed
 * by the total event count, e.g. " ⌄ ⚡👤 12 ". The pill is
 * stateless; the chat wires `onExpand` and swaps in the detailed
 * pills when clicked.
 */
export const renderEventSummary = (
  events: any[],
  onExpand: () => void
): TemplateResult => {
  // one icon per kind of thing inside, deduped, in order of first
  // appearance
  const icons: string[] = [];
  const addIcon = (icon: string) => {
    if (!icons.includes(icon)) {
      icons.push(icon);
    }
  };
  for (const event of events) {
    switch (event.type) {
      case Events.RUN_STARTED:
      case Events.RUN_ENDED:
      case Events.FLOW_ENTERED:
      case Events.SESSION_TRIGGERED:
        addIcon('flow');
        break;
      case Events.CONTACT_GROUPS_CHANGED:
        addIcon('group');
        break;
      case Events.CONTACT_EMAIL_CHANGED:
      case Events.CONTACT_FIELD_CHANGED:
      case Events.CONTACT_NAME_CHANGED:
      case Events.CONTACT_LANGUAGE_CHANGED:
      case Events.CONTACT_STATUS_CHANGED:
      case Events.CONTACT_URNS_CHANGED:
        addIcon('fields');
        break;
      case Events.TICKET_OPENED:
      case Events.TICKET_CLOSED:
      case Events.TICKET_REOPENED:
      case Events.TICKET_ASSIGNEE_CHANGED:
      case Events.TICKET_TOPIC_CHANGED:
        addIcon('tickets');
        break;
      default:
        addIcon('event');
    }
  }

  return html`<temba-label
    type="neutral"
    icon="down"
    title="Show details"
    clickable
    style="margin: 1px 2px; vertical-align: middle;"
    @click=${onExpand}
    >${icons.map(
      (icon) =>
        html`<temba-icon
          name=${icon}
          style="display: inline-block; vertical-align: -2px; margin-right: 3px;"
        ></temba-icon>`
    )}<span style="font-weight: 600; margin-left: 2px;"
      >${formatCount(events.length)}</span
    ></temba-label
  >`;
};

export const renderAirtimeTransferredEvent = (
  event: AirtimeTransferredEvent
): TemplateResult => {
  const failed = parseFloat(event.amount) === 0;
  return html`<div style=${eventLineStyle}>
    ${failed
      ? attributePill('Airtime', 'failed', { icon: 'airtime' })
      : attributePill('Airtime', `${event.amount} ${event.currency}`, {
          icon: 'airtime'
        })}
  </div>`;
};

export const renderAirtimeCreatedEvent = (
  event: AirtimeCreatedEvent
): TemplateResult => {
  const status = event._status?.status ?? 'created';
  let value = `${event.amount} ${event.currency}`;

  switch (status) {
    case 'reversed':
      value = 'reversed';
      break;
    case 'rejected':
    case 'cancelled':
    case 'declined':
      value = 'failed';
      break;
  }

  return html`<div style=${eventLineStyle}>
    ${attributePill('Airtime', value, { icon: 'airtime' })}
  </div>`;
};

export const renderContactLanguageChangedEvent = (
  event: ContactLanguageChangedEvent
): TemplateResult => {
  const language = event.language ? getLanguageName(event.language) : null;
  return html`<div style=${eventLineStyle}>
    ${attributePill('Language', language, { icon: 'language' })}
  </div>`;
};

export const renderContactStatusChangedEvent = (
  event: ContactStatusChangedEvent
): TemplateResult => {
  return html`<div style=${eventLineStyle}>
    ${attributePill('Status', event.status || null)}
  </div>`;
};

export const renderCallEvent = (event: CallEvent): TemplateResult | null => {
  let label: string = null;
  let icon: string = null;
  if (event.type === Events.CALL_CREATED) {
    label = 'Call started';
    icon = 'call';
  } else if (event.type === Events.CALL_MISSED) {
    label = 'Call missed';
    icon = 'missed_call';
  } else if (event.type === Events.CALL_RECEIVED) {
    label = 'Call answered';
    icon = 'incoming_call';
  }
  if (!label) {
    return null;
  }
  return html`<div style=${eventLineStyle}>
    ${renderEntityPill('neutral', label, { icon })}
  </div>`;
};

export const renderOptInEvent = (event: OptInEvent): TemplateResult => {
  // opt-out gets the red removal treatment to mirror group removal;
  // the hover tooltip and icon carry the verb in all three cases
  if (event.type === Events.OPTIN_REQUESTED) {
    return html`<div style=${eventLineStyle}>
      ${renderEntityPill('neutral', event.optin.name, {
        icon: 'optin_requested'
      })}
    </div>`;
  } else if (event.type === Events.OPTIN_STARTED) {
    return html`<div style=${eventLineStyle}>
      ${renderEntityPill('neutral', event.optin.name, {
        icon: 'optin'
      })}
    </div>`;
  } else if (event.type === Events.OPTIN_STOPPED) {
    return html`<div style=${eventLineStyle}>
      ${renderEntityPill('removed', event.optin.name, {
        icon: 'optout'
      })}
    </div>`;
  }
};

export const renderDiagnosticEvent = (
  event: any,
  _isSimulation: boolean = false
): TemplateResult | null => {
  if (event.text) {
    let icon = '⚠️';
    let bgColor = '#fff3cd';
    let textColor = '#856404';

    if (event.type === 'error') {
      icon = '❗';
      bgColor = '#fee3e3';
      textColor = '#c01829';
    } else if (event.type === 'failure') {
      icon = '💥';
      bgColor = '#fee3e3';
      textColor = '#c01829';
    }

    return html`<div
      style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: ${bgColor}; color: ${textColor}; border-radius: 12px; margin: 4px 18px;"
    >
      <span style="font-size: 16px; line-height: 1.4;">${icon}</span>
      <span style="flex: 1; line-height: 1.4;">${event.text}</span>
    </div>`;
  }
  return null;
};

export const renderRunResultChanged = (event: any): TemplateResult | null => {
  // attributePill truncates long values; the hover tooltip carries
  // the full text
  return html`<div style=${eventLineStyle}>
    ${attributePill(event.name, String(event.value))}
  </div>`;
};

export const renderInputLabelsAdded = (event: any): TemplateResult | null => {
  const labels = event.labels || [];
  if (labels.length === 0) {
    return null;
  }
  return html`<div style=${eventLineStyle}>
    ${labels.map((l: any) => renderEntityPill('label', l.name))}
  </div>`;
};

export const renderEmailSent = (event: any): TemplateResult | null => {
  const recipients = event.to || event.addresses || [];
  if (recipients.length === 0) {
    return null;
  }
  return html`<div style=${eventLineStyle}>
    ${renderEntityPill('neutral', recipients.join(', '), {
      icon: 'email'
    })}
  </div>`;
};

export const renderBroadcastCreated = (event: any): TemplateResult | null => {
  const text = event.translations?.[event.base_language]?.text;
  const maxLen = 50;
  const display =
    text && text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
  return html`<div style=${eventLineStyle}>
    ${renderEntityPill('neutral', display || 'Broadcast', {
      icon: 'broadcast'
    })}
  </div>`;
};

export const renderSessionTriggered = (event: any): TemplateResult | null => {
  const flow = event.flow;
  if (flow) {
    return html`<div style=${eventLineStyle}>
      ${flowPill(flow, {
        prefixIcon: 'contact'
      })}
    </div>`;
  }
  return null;
};

export const renderResthookCalled = (event: any): TemplateResult | null => {
  return html`<div style=${eventLineStyle}>
    ${renderEntityPill('neutral', event.resthook, {
      icon: 'resthooks'
    })}
  </div>`;
};

export const renderWebhookCalled = (event: any): TemplateResult | null => {
  const maxLen = 50;
  const displayUrl =
    event.url && event.url.length > maxLen
      ? event.url.slice(0, maxLen) + '...'
      : event.url;
  return html`<div style=${eventLineStyle}>
    ${renderEntityPill('neutral', displayUrl, {
      icon: 'webhook'
    })}
  </div>`;
};

export const renderServiceCalled = (event: any): TemplateResult | null => {
  return html`<div style=${eventLineStyle}>
    ${renderEntityPill('neutral', event.service, {
      icon: 'service'
    })}
  </div>`;
};

// ---------------------------------------------------------------------------
// Rich hover tooltips
//
// Every inline event pill in the contact chat gets a temba-tip that
// only adds what the pill can't already show: the full text of a
// value the pill truncates (or the nicely formatted date and time
// behind a date field's short day), the acting user (avatar on the
// left, name beside the timestamp) and the detailed timestamp. A
// pill with nothing else to add still shows the timestamp alone.
// This replaces the native `title` attributes the pills used to
// carry.
// ---------------------------------------------------------------------------

const tooltipAvatar = (user: any): TemplateResult =>
  html`<temba-user
    name=${ifDefined(user.name)}
    first_name=${ifDefined(user.first_name)}
    last_name=${ifDefined(user.last_name)}
    email=${ifDefined(user.email)}
    avatar=${ifDefined(user.avatar)}
  ></temba-user>`;

// pill sides ellipsize at 18em — roughly this many characters at the
// pill font size. Values within the cap are already fully visible in
// the pill, so the tooltip only repeats ones longer than this.
const PILL_VALUE_CHARS = 32;

const fullValue = (
  value: string | undefined,
  visibleChars = PILL_VALUE_CHARS
): string[] => (value && value.length > visibleChars ? [value] : []);

/**
 * The detail lines an event's tooltip adds beyond the pill itself —
 * just the values the pill truncates. Most events add nothing (their
 * pill already says it all); returns null for events that don't
 * render as pills at all.
 */
const getEventTooltipLines = (
  event: any
): (string | TemplateResult)[] | null => {
  switch (event.type) {
    case Events.CONTACT_FIELD_CHANGED: {
      const value = event.value;
      // date fields render as a short day in the pill — the tooltip
      // carries the full date and time, formatted rather than a raw
      // iso string
      if (value?.datetime) {
        return [
          html`<temba-date
            value=${value.datetime}
            display="datetime"
          ></temba-date>`
        ];
      }
      return fullValue(value?.text);
    }
    case Events.CONTACT_NAME_CHANGED:
      return fullValue(event.name);
    case Events.CONTACT_EMAIL_CHANGED:
      return fullValue(event.email);
    case Events.CONTACT_URNS_CHANGED: {
      const urns = (event.urns || []).map(urnDisplayValue);
      return fullValue(urns.join(', '));
    }
    case Events.RUN_RESULT_CHANGED:
      return fullValue(String(event.value));
    case Events.EMAIL_CREATED:
    case Events.EMAIL_SENT: {
      const recipients = event.to || event.addresses || [];
      // the subject is never in the pill; recipients only repeat when
      // the pill truncates them
      return [
        ...fullValue(recipients.join(', ')),
        ...(event.subject ? [event.subject] : [])
      ];
    }
    // these two pills cut their value at 50 characters themselves
    case Events.BROADCAST_CREATED:
      return fullValue(event.translations?.[event.base_language]?.text, 50);
    case Events.WEBHOOK_CALLED:
      return fullValue(event.url, 50);
    // diagnostics render as banners and notes as chat bubbles — no
    // pill, so no pill tooltip
    case Events.ERROR:
    case Events.FAILURE:
    case Events.WARNING:
    case Events.TICKET_NOTE_ADDED:
      return null;
    default:
      return [];
  }
};

// a detail line in the tooltip: short values stay on one line (the
// tooltip hugs them), while runaway ones (a paragraph-sized field
// value, a long URL) wrap for a few lines within the container's cap
// and then ellipsize
const tooltipLineStyle =
  'white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden;';

/**
 * Lays out tooltip content: the acting user's avatar on the left
 * (when there is one) with a hairline rule, then the detail column —
 * truncated-value lines set apart on a tinted, padded block, then a
 * metadata line with the user's name (slightly heavier) and the
 * detailed timestamp separated by a middle dot. When the metadata is
 * all there is, the name and time stack on two lines instead to
 * balance against the avatar. Without a user it's just the time.
 */
const renderTooltipContent = (
  event: any,
  lines: (string | TemplateResult)[]
): TemplateResult | null => {
  const user = event._user;
  const createdOn = event.created_on;
  const iso = !createdOn
    ? null
    : typeof createdOn === 'string'
      ? createdOn
      : createdOn.toISOString();

  if (!user && lines.length === 0 && !iso) {
    return null;
  }

  // the hairline rule gets equal breathing room from the flex gap and
  // stretches to the row height. The avatar column is pinned to the
  // circle's 26px width because temba-user carries a trailing margin
  // (meant for an inline name) that would otherwise push the rule
  // off-balance.
  return html`<div
    style="display: flex; align-items: center; gap: 8px; text-align: left; font-size: 12px; line-height: 1.45; padding: 4px 2px; max-width: 340px;"
  >
    ${user
      ? html`<div style="flex-shrink: 0; width: 26px;">
            ${tooltipAvatar(user)}
          </div>
          <div
            style="align-self: stretch; width: 1px; background: rgba(0, 0, 0, 0.08); flex-shrink: 0;"
          ></div>`
      : null}
    <div style="min-width: 0;">
      ${lines.length > 0
        ? html`<div
            style="background: #f3f3f3; border-radius: 4px; padding: 4px 8px; margin-bottom: 4px;"
          >
            ${lines.map(
              (line) => html`<div style=${tooltipLineStyle}>${line}</div>`
            )}
          </div>`
        : null}
      ${lines.length === 0 && user && iso
        ? html`<div style="font-size: 11px;">
            <div style="font-weight: 500;">${getUserName(user)}</div>
            <div><temba-date value=${iso} display="datetime"></temba-date></div>
          </div>`
        : user || iso
          ? html`<div
              style="font-size: 11px; display: flex; align-items: center; gap: 5px;"
            >
              ${user
                ? html`<div style="font-weight: 500;">
                    ${getUserName(user)}
                  </div>`
                : null}
              ${user && iso
                ? html`<div style="font-size: 16px; line-height: 1;">·</div>`
                : null}
              ${iso
                ? html`<temba-date
                    value=${iso}
                    display="datetime"
                  ></temba-date>`
                : null}
            </div>`
          : null}
    </div>
  </div>`;
};

/**
 * Builds the rich tooltip content for an event pill. Returns null for
 * events that don't render as pills.
 */
export const renderEventTooltip = (event: any): TemplateResult | null => {
  const lines = getEventTooltipLines(event);
  if (lines === null) {
    return null;
  }
  return renderTooltipContent(event, lines);
};

/**
 * Unified event renderer that handles both simulation and contact chat contexts.
 * @param event - The event to render
 * @param isSimulation - Whether this is for simulation (true) or contact chat (false)
 * @returns A template result or null if the event cannot be rendered
 */
export const renderEvent = (
  event: any,
  isSimulation: boolean
): TemplateResult | null => {
  let content: TemplateResult | null = null;

  switch (event.type) {
    case Events.ERROR:
    case Events.FAILURE:
    case Events.WARNING:
      content = renderDiagnosticEvent(event, isSimulation);
      break;
    case Events.AIRTIME_CREATED:
      content = renderAirtimeCreatedEvent(event as AirtimeCreatedEvent);
      break;
    case Events.AIRTIME_TRANSFERRED:
      content = renderAirtimeTransferredEvent(event as AirtimeTransferredEvent);
      break;
    case Events.CALL_CREATED:
    case Events.CALL_MISSED:
    case Events.CALL_RECEIVED:
      content = renderCallEvent(event as CallEvent);
      break;
    case Events.CHAT_STARTED:
      content = renderChatStartedEvent(event as ChatStartedEvent);
      break;
    case Events.CONTACT_FIELD_CHANGED:
      content = renderUpdateEvent(event as UpdateFieldEvent);
      break;
    case Events.CONTACT_GROUPS_CHANGED:
      // in the chat, tooltips attach per group pill (each speaks only
      // to its own group), so the whole-line wrap below is skipped
      content = renderContactGroupsEvent(
        event as ContactGroupsEvent,
        !isSimulation
      );
      break;
    case Events.CONTACT_EMAIL_CHANGED:
      content = renderContactEmailChangedEvent(
        event as ContactEmailChangedEvent
      );
      break;
    case Events.CONTACT_LANGUAGE_CHANGED:
      content = renderContactLanguageChangedEvent(
        event as ContactLanguageChangedEvent
      );
      break;
    case Events.CONTACT_NAME_CHANGED:
      content = renderNameChanged(event as NameChangedEvent);
      break;
    case Events.CONTACT_STATUS_CHANGED:
      content = renderContactStatusChangedEvent(
        event as ContactStatusChangedEvent
      );
      break;
    case Events.CONTACT_URNS_CHANGED:
      content = renderContactURNsChanged(event as URNsChangedEvent);
      break;
    case Events.INPUT_LABELS_ADDED:
      content = renderInputLabelsAdded(event);
      break;
    case Events.RUN_RESULT_CHANGED:
      content = renderRunResultChanged(event);
      break;
    case Events.OPTIN_REQUESTED:
    case Events.OPTIN_STARTED:
    case Events.OPTIN_STOPPED:
      content = renderOptInEvent(event as OptInEvent);
      break;
    case Events.RUN_STARTED:
    case Events.RUN_ENDED:
    case Events.FLOW_ENTERED:
      content = renderRunEvent(event as RunEvent);
      break;
    case Events.EMAIL_CREATED:
    case Events.EMAIL_SENT:
      content = renderEmailSent(event);
      break;
    case Events.BROADCAST_CREATED:
      content = renderBroadcastCreated(event);
      break;
    case Events.SESSION_TRIGGERED:
      content = renderSessionTriggered(event);
      break;
    case Events.RESTHOOK_CALLED:
      content = renderResthookCalled(event);
      break;
    case Events.WEBHOOK_CALLED:
      content = renderWebhookCalled(event);
      break;
    case Events.SERVICE_CALLED:
      content = renderServiceCalled(event);
      break;
    case Events.TICKET_ASSIGNEE_CHANGED:
      content = renderTicketAssigneeChanged(event as TicketEvent);
      break;
    case Events.TICKET_CLOSED:
      content = renderTicketAction(event as TicketEvent, 'closed');
      break;
    case Events.TICKET_OPENED:
      content = renderTicketOpened(event as TicketEvent);
      break;
    case Events.TICKET_NOTE_ADDED:
      content = renderTicketAction(event as TicketEvent, 'noted');
      break;
    case Events.TICKET_REOPENED:
      content = renderTicketAction(event as TicketEvent, 'reopened');
      break;
    case Events.TICKET_TOPIC_CHANGED: {
      // event.topic is optional — guard so a payload without one
      // degrades cleanly instead of throwing inside topicPill.
      // The topic pill (icon + topic color) is self-contained enough
      // to stand alone without a "Topic changed to" sentence.
      const newTopic = (event as TicketEvent).topic;
      content = newTopic
        ? html`<div style=${eventLineStyle}>${topicPill(newTopic)}</div>`
        : null;
      break;
    }
    default:
      return null;
  }

  if (content === null) {
    return null;
  }

  // wrap in a div with appropriate font size
  const fontSize = isSimulation ? '11px' : '14px';

  // in the contact chat, hovering an event pill pops our own rich
  // tooltip (verbose detail, avatars, detailed time). The simulator
  // keeps its click-to-inspect event details instead, and group
  // events carry per-pill tips (see renderContactGroupsEvent). width:
  // fit-content keeps the hover area hugging the pills rather than
  // spanning the row.
  const tooltip =
    isSimulation || event.type === Events.CONTACT_GROUPS_CHANGED
      ? null
      : renderEventTooltip(event);
  if (tooltip) {
    return html`<div style="font-size: ${fontSize}">
      <temba-tip
        style="display: block; width: fit-content; max-width: 100%; margin: 0 auto;"
        position="top"
        distance="4"
        arrow-size="18"
        interactive
        .content=${tooltip}
        >${content}</temba-tip
      >
    </div>`;
  }
  return html`<div style="font-size: ${fontSize}">${content}</div>`;
};

/**
 * @deprecated Use renderEvent(event, true) instead
 */
export const renderSimulatorEvent = (event: any): TemplateResult | null => {
  return renderEvent(event, true);
};
