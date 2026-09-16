import { TemplateResult, html, nothing, PropertyValueMap, css } from 'lit';
import { msg, str } from '@lit/localize';
import { property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { RapidElement } from '../RapidElement';
import { CustomEventType, QuickReply } from '../interfaces';
import { TicketEvent } from '../events';
import { renderEventSummary } from '../events/eventRenderers';
import { DEFAULT_AVATAR } from '../webchat/assets';
import { attachmentAsString } from '../utils';
import { DateTime } from 'luxon';

const SCROLL_FETCH_BUFFER = 200; // pixels from top
const MIN_FETCH_TIME = 250;

// how long a typing indicator lives without a fresh pulse - stop events can
// be missed (they're excluded from history recovery) so indicators decay
const TYPING_TIMEOUT = 10 * 1000;

const getUnsendableReasonMessage = (reason: string): string => {
  switch (reason) {
    case 'no_route':
      return msg('No channel available to send message');
    case 'contact_blocked':
      return msg('Contact has been blocked');
    case 'contact_stopped':
      return msg('Contact has been stopped');
    case 'contact_archived':
      return msg('Contact is archived');
    case 'org_suspended':
      return msg('Workspace is suspended');
    case 'looping':
      return msg('Message loop detected');
    default:
      return msg('Unable to send message');
  }
};

const getStatusReasonMessage = (reason: string): string => {
  switch (reason) {
    case 'error_limit':
      return msg('Error limit reached');
    case 'too_old':
      return msg('Message is too old to send');
    case 'channel_removed':
      return msg('Channel was removed');
    default:
      return msg('Message failed to send');
  }
};

export enum MessageType {
  Inline = 'inline',
  Error = 'error',
  Collapse = 'collapse',
  Note = 'note'
}

export type GroupReason =
  | 'time_elapsed'
  | 'new_author'
  | 'new_type'
  | 'initial';

export interface MessageGroup {
  messages: string[];
  reason: GroupReason;
}

export interface ObjectReference {
  uuid: string;
  name: string;
}

interface User extends ObjectReference {
  avatar?: string;
  email: string;
  first_name?: string;
  last_name?: string;
}

export interface Msg {
  text: string;
  channel: ObjectReference;
  quick_replies: (string | QuickReply)[];
  urn: string;
  direction: string;
  type: string;
  external_id?: string;
  attachments: string[];
  unsendable_reason?:
    | 'no_route'
    | 'contact_blocked'
    | 'contact_stopped'
    | 'contact_archived'
    | 'org_suspended'
    | 'looping';
}

export interface ContactEvent {
  uuid?: string;
  type: string;
  created_on: Date;
  _user?: User;
  _rendered?: { html: TemplateResult; type: MessageType };
}

export interface MsgEvent extends ContactEvent {
  msg: Msg;
  optin?: ObjectReference;
  _status?: {
    created_on: string;
    status: 'wired' | 'sent' | 'delivered' | 'read' | 'errored' | 'failed';
    reason: 'error_limit' | 'too_old' | 'channel_removed';
  };
  _deleted?: {
    created_on: string;
    by_contact: boolean;
    user?: { name: string; uuid: string };
  };
}

export interface TypingEvent extends ContactEvent {
  direction?: string;
}

// typing indicators group and side with real messages: a user typing
// (outgoing) behaves like a reply, a contact typing (incoming) like a
// received message
const effectiveType = (event: ContactEvent): string => {
  if (event.type === 'typing_started') {
    return (event as TypingEvent).direction === 'incoming'
      ? 'msg_received'
      : 'msg_created';
  }
  return event.type;
};

// identifies who a typing indicator belongs to - the user when stamped,
// otherwise the contact
const getTypingKey = (event: TypingEvent): string => {
  return event._user?.uuid || 'contact';
};

// event types whose inline rendering is a self-contained pill (see
// eventRenderers.ts) — consecutive runs of these condense onto a
// single wrapping line instead of one per line. Diagnostics
// (error/warning/failure) and note bubbles stay on their own lines.
const CONDENSED_EVENT_TYPES = new Set([
  'airtime_created',
  'airtime_transferred',
  'broadcast_created',
  'call_created',
  'call_missed',
  'call_received',
  'chat_started',
  'contact_field_changed',
  'contact_groups_changed',
  'contact_language_changed',
  'contact_name_changed',
  'contact_status_changed',
  'contact_urns_changed',
  'email_created',
  'email_sent',
  'flow_entered',
  'input_labels_added',
  'optin_requested',
  'optin_started',
  'optin_stopped',
  'resthook_called',
  'run_ended',
  'run_result_changed',
  'run_started',
  'service_called',
  'session_triggered',
  'ticket_assignee_changed',
  'ticket_closed',
  'ticket_opened',
  'ticket_reopened',
  'ticket_topic_changed',
  'webhook_called'
]);

// whether a message has nothing to show in its bubble (and isn't deleted)
const isEmptyMsg = (event: MsgEvent): boolean =>
  !event._deleted &&
  !!event.msg &&
  !event.msg.text &&
  (event.msg.attachments || []).length === 0;

// local-time calendar day, used to bucket messages into day sections
const getDayKey = (date: Date): string =>
  `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/**
 * Human label for a day section: Today, Yesterday, "Jun 22" within
 * the current year, and a full "9/1/2025" for anything older.
 * "Now" comes from luxon so it honors the same clock the rest of the
 * date rendering uses (and its test stubs).
 */
const getDayLabel = (date: Date): string => {
  const today = DateTime.now().toJSDate();
  if (getDayKey(date) === getDayKey(today)) {
    return msg('Today');
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (getDayKey(date) === getDayKey(yesterday)) {
    return msg('Yesterday');
  }
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    });
  }
  return date.toLocaleDateString();
};

export class Chat extends RapidElement {
  static get styles() {
    return css`
      :host {
        display: flex;
        flex-direction: column;
        flex-grow: 1;
        position: relative;
        z-index: 1;
      }

      slot[name='header'] {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        display: block;
      }

      slot[name='footer'] {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        display: block;
        /* The slot overlays the bottom of the chat history, so clicks
           on the chat scrollbar or messages behind it must pass
           through. Slotted footer content can opt back in with
           pointer-events: auto on its interactive bits. */
        pointer-events: none;
      }

      .block {
        margin-bottom: 1em;
        display: flex;
        flex-direction: row;
      }

      .block.outgoing {
        flex-direction: row-reverse;
      }

      .block.collapse {
        margin: 0;
        align-items: center;
        display: flex;
        flex-direction: column;
        margin-bottom: 0.5em;
      }

      .block.collapse .messsage {
        transform: scaleY(0);
        margin: 0;
        padding: 0;
        line-height: 0;
      }

      /* Each calendar day of history renders as its own section. The
         section itself is normal top-down flow (its contents are
         ordered oldest-first at render time) — position: sticky
         misbehaves inside column-reverse, so only the scroller
         reverses. */
      .day-section {
        display: flex;
        flex-direction: column;
      }

      /* The day marker pins to the top of the chat window while its
         day's messages scroll underneath — position: sticky keeps it
         floating until the section ends, at which point the next
         day's marker takes over. pointer-events pass through so the
         chip never blocks interaction with messages behind it. */
      .day-marker {
        position: sticky;
        top: 0;
        z-index: 3;
        display: flex;
        justify-content: center;
        padding: 0.25em 0 0.75em;
        pointer-events: none;
      }

      /* Translucent chip so messages read through it while it floats
         over them mid-scroll. */
      .day-marker .day {
        font-size: 0.7em;
        font-weight: 500;
        letter-spacing: 0.03em;
        color: #71767d;
        background: rgba(255, 255, 255, 0.85);
        backdrop-filter: blur(6px);
        border: 1px solid rgba(0, 0, 0, 0.06);
        border-radius: 999px;
        padding: 3px 12px;
        box-shadow: 0 1px 3px rgba(16, 24, 40, 0.08);
      }

      .group-reason {
        text-align: center;
        font-size: 0.75em;
        color: #999;
        margin-bottom: 1em;
        margin-top: 0.5em;
        padding: 0.5em 1em;
        font-style: italic;
      }

      .row {
        display: flex;
        flex-direction: row;
        align-items: flex-start;
        margin-bottom: 8px;
      }

      .row.is-event {
        margin-bottom: 2px;
        margin-left: 0px !important;
        margin-right: 4px !important;
      }

      /* An expanded run of self-contained pill events (field changes,
         group changes, etc. — see CONDENSED_EVENT_TYPES): a collapse
         rail down the left, then the pills flowing as a wrapping,
         centered row. Extra specificity keeps the .incoming .row
         row-reverse rule below from flipping the rail to the right. */
      .group-messages .row.condensed-events {
        flex-direction: row;
      }

      /* Expanding animates via the grid 0fr -> 1fr technique so the
         run grows smoothly from the summary's height without any
         measured heights; collapsing plays the same animation in
         reverse (forwards) while the run is in the .collapsing state,
         then the render swaps in the summary pill. */
      .condensed-events .reveal {
        flex-grow: 1;
        min-width: 0;
        display: grid;
        grid-template-rows: 1fr;
        animation: reveal-expand 200ms ease;
        /* floor both animations at the summary pill's height so the
           swap between summary and run happens with no net height
           change — without this the run shrinks to zero and the
           summary pops back up, reading as a false bounce */
        min-height: 24px;
      }

      .condensed-events.collapsing .reveal {
        animation: reveal-collapse 180ms ease forwards;
        pointer-events: none;
      }

      .condensed-events .reveal-inner {
        overflow: hidden;
        min-width: 0;
      }

      .condensed-events .run {
        display: flex;
        flex-direction: row;
        flex-wrap: nowrap;
        align-items: stretch;
        gap: 4px;
      }

      @keyframes reveal-expand {
        from {
          grid-template-rows: 0fr;
          opacity: 0;
        }
        to {
          grid-template-rows: 1fr;
          opacity: 1;
        }
      }

      @keyframes reveal-collapse {
        from {
          grid-template-rows: 1fr;
          opacity: 1;
        }
        to {
          grid-template-rows: 0fr;
          opacity: 0;
        }
      }

      /* the summary pill eases back in after a collapse (and on first
         render — it's subtle enough to double as a gentle entrance) */
      .row.summary-row {
        animation: summary-in 150ms ease;
      }

      @keyframes summary-in {
        from {
          opacity: 0;
          transform: translateY(2px);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }

      /* a message that just arrived settles into place from just below,
         growing from the corner its bubble points at */
      .row.arriving {
        animation: arrive 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
        animation-delay: var(--arrive-delay, 0ms);
        transform-origin: bottom left;
      }

      .incoming .row.arriving {
        transform-origin: bottom right;
      }

      @keyframes arrive {
        from {
          opacity: 0;
          transform: translateY(0.6em) scale(0.96);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .condensed-events .reveal,
        .condensed-events.collapsing .reveal,
        .row.summary-row,
        .row.arriving {
          animation: none;
        }
      }

      .condensed-events .events {
        flex-grow: 1;
        min-width: 0;
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        align-items: center;
        column-gap: 4px;
        row-gap: 2px;
      }

      .condensed-events .event {
        flex-grow: 0;
        max-width: 100%;
      }

      /* The rail is the collapse affordance: an icon button at the
         top with a thin line running the height of the run. The whole
         rail is clickable, quietly highlighting on hover. */
      .collapse-rail {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 1px 2px;
        cursor: pointer;
        --icon-color: #9aa1a9;
      }

      .collapse-rail .rail-line {
        flex-grow: 1;
        width: 2px;
        border-radius: 2px;
        background: #e4e7ea;
      }

      .collapse-rail:hover {
        --icon-color: #6b7280;
      }

      .collapse-rail:hover .rail-line {
        background: #c9cdd2;
      }

      .input-panel {
        padding: 1em;
        background: #fff;
      }

      temba-user {
        margin-right: 0.6em;
        margin-left: 0.6em;
        width: 2em;
        align-self: flex-end;
      }

      .toggle {
        flex-shrink: 0;
        width: 4em;
        height: 4em;
        overflow: hidden;
        border-radius: 100%;
        box-shadow:
          rgba(0, 0, 0, 0.1) 0px 0px 1em 0.7em,
          rgba(0, 0, 0, 0.2) 0px 1px 2px 0px,
          inset 0 0 0 0.25em rgba(0, 0, 0, 0.1);
        cursor: pointer;
        transition: box-shadow var(--toggle-speed, 200ms) ease-out;
        position: absolute;
        bottom: 1em;
        right: 1em;
      }

      .toggle:hover {
        box-shadow:
          rgba(0, 0, 0, 0.1) 0px 0px 1em 0.7em,
          rgba(0, 0, 0, 0.4) 0px 1px 2px 0px,
          inset 0 0 0 0.25em rgba(0, 0, 0, 0.2);
      }

      .incoming .row {
        flex-direction: row-reverse;
        margin-left: 1em;
      }

      /* Bubble fills are soft top-lit gradients derived from the
         same theme vars the flat fills used — color-mix keeps host
         re-theming working — with a whisper of shadow for depth and
         a hairline border mixed just darker than the fill so bubbles
         hold their edge against the background. Base rules carry flat
         fills and pre-mixed borders for browsers without color-mix()
         (pre-Chrome 111); the @supports block below layers the
         gradients on top. */
      .bubble {
        padding: 10px 14px;
        background: var(--color-chat-in, #e5e5ea);
        border-radius: 18px;
        border: var(--chat-border-in, 1px solid #d5d5da);
        box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
      }

      .bubble .name {
        font-size: 0.95em;
        font-weight: 400;
        color: rgba(0, 0, 0, 0.4);
        margin-bottom: 0.25em;
      }

      .outgoing .latest .bubble {
        border-bottom-left-radius: 4px;
      }

      .incoming .bubble-wrap {
        align-items: flex-end;
      }

      .incoming .bubble {
        background: var(--color-chat-out, #007aff);
        border: var(--chat-border-out, 1px solid #006ee6);
        color: white;
      }

      @supports (color: color-mix(in srgb, red, red)) {
        .bubble {
          background: linear-gradient(
            180deg,
            color-mix(in srgb, var(--color-chat-in, #e5e5ea) 62%, white) 0%,
            var(--color-chat-in, #e5e5ea) 100%
          );
          border: var(
            --chat-border-in,
            1px solid
              color-mix(in srgb, var(--color-chat-in, #e5e5ea) 93%, black)
          );
        }

        .incoming .bubble {
          background: linear-gradient(
            180deg,
            color-mix(in srgb, var(--color-chat-out, #007aff) 90%, white) 0%,
            var(--color-chat-out, #007aff) 58%,
            color-mix(in srgb, var(--color-chat-out, #007aff) 95%, black) 100%
          );
          border: var(
            --chat-border-out,
            1px solid
              color-mix(in srgb, var(--color-chat-out, #007aff) 90%, black)
          );
        }
      }

      .incoming .latest .bubble {
        border-bottom-right-radius: 4px;
      }

      .incoming .bubble .name {
        color: rgba(255, 255, 255, 0.7);
      }

      /* Notes get the same top-lit gradient treatment as message
         bubbles, derived from their sticky-note yellow. The flat fill
         first is the fallback for browsers without color-mix() — all
         literals here, so the invalid gradient drops at parse time. */
      .note .bubble {
        background: #fffac3;
        background: linear-gradient(
          180deg,
          color-mix(in srgb, #fffac3 62%, white) 0%,
          #fffac3 100%
        );
        border: 1px solid #e8d169;
        color: #5d4e1e;
      }

      .note .bubble .name {
        color: rgba(93, 78, 30, 0.65);
      }

      .warning .bubble {
        background: #fef3c7;
        color: rgba(125, 87, 18, 0.8);
        border: none;
      }

      .warning .bubble .name {
        color: rgba(125, 87, 18, 0.6);
      }

      .failed .bubble,
      .error .bubble {
        border: none;
        background: #fee3e3;
        color: #c01829;
      }

      .error .bubble .name,
      .failed .bubble .name {
        color: rgba(192, 24, 41, 0.6);
      }

      .deleted .bubble,
      .empty .bubble {
        background: #fff;
        color: #999;
        border: 1px solid #e0e0e0;
      }

      .deleted .bubble .name,
      .empty .bubble .name {
        color: #aaa;
      }

      .typing-dots {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 0;
      }

      .typing-dots span {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: currentColor;
        opacity: 0.4;
        animation: typing-bounce 1.2s ease-in-out infinite;
      }

      .typing-dots span:nth-child(2) {
        animation-delay: 0.15s;
      }

      .typing-dots span:nth-child(3) {
        animation-delay: 0.3s;
      }

      @keyframes typing-bounce {
        0%,
        60%,
        100% {
          transform: translateY(0);
          opacity: 0.4;
        }
        30% {
          transform: translateY(-3px);
          opacity: 1;
        }
      }

      .message-text {
        white-space: pre-wrap;
        margin-bottom: 0;
        line-height: 1.2;
        word-break: break-word;
        font-size: 13px;
      }

      .message-deleted,
      .message-empty {
        font-style: italic;
        margin-bottom: 0;
        line-height: 1.2;
        font-size: 13px;
      }

      .quick-replies {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 6px;
        padding: 8px 0;
        margin: 0 auto;
        max-width: 90%;
      }

      .quick-reply-btn {
        padding: 4px 8px;
        border-radius: 18px;
        border: 1px solid var(--color-chat-out, #007aff);
        background: white;
        color: var(--color-chat-out, #007aff);
        font-size: 11px;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .quick-reply-btn:hover:not(:disabled) {
        background: var(--color-chat-out, #007aff);
        color: white;
      }

      .quick-reply-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .chat {
        width: 28rem;
        border-radius: var(--curvature);
        overflow: hidden;
        box-shadow:
          rgba(0, 0, 0, 0.1) 0px 3px 7px 0px,
          rgba(0, 0, 0, 0.2) 0px 1px 2px 0px,
          rgba(0, 0, 0, 0.1) 5em 5em 5em 5em;
        position: absolute;
        bottom: 3em;
        right: 1em;
        transition: all var(--toggle-speed, 200ms) ease-out;
        transform: scale(0.9);
        pointer-events: none;
        opacity: 0;
      }

      .chat.open {
        bottom: 6em;
        opacity: 1;
        transform: scale(1);
        pointer-events: initial;
      }

      .messages {
        position: relative;
        flex-grow: 1;
        overflow: hidden;
      }

      .scroll {
        position: absolute;
        top: 0;
        bottom: 0;
        right: 0;
        left: 0;
        overflow-y: auto;
        overflow-x: hidden;
        -webkit-overflow-scrolling: touch;
        overflow-scrolling: touch;
        padding: var(--chat-top-padding, 1em) 1em
          var(--chat-bottom-padding, 2.5em) 1em;
        display: flex;
        flex-direction: column-reverse;
      }

      :host(.phone-screen) .scroll {
        scrollbar-width: none;
        -ms-overflow-style: none;
      }

      :host(.phone-screen) .scroll::-webkit-scrollbar {
        display: none;
      }

      /* Top/bottom scroll-shadow indicators. Decorative only — they
         must not intercept clicks (would otherwise block the chat
         scrollbar and the bottom edge of the messages area). */
      .messages:before {
        content: '';
        background: radial-gradient(
            farthest-side at 50% 0,
            rgba(0, 0, 0, 0.2),
            rgba(0, 0, 0, 0)
          )
          center top;
        height: 10px;
        display: block;
        position: absolute;
        width: 100%;
        transition: opacity var(--toggle-speed, 200ms) ease-out;
        z-index: 1;
        pointer-events: none;
      }

      .messages:after {
        content: '';
        background: radial-gradient(
            farthest-side at 50% 100%,
            rgba(0, 0, 0, 0.2),
            rgba(0, 0, 0, 0)
          )
          center bottom;
        height: 10px;
        display: block;
        position: absolute;
        bottom: 0;
        margin-top: -10px;
        width: 100%;
        margin-right: 5em;
        transition: opacity var(--toggle-speed, 200ms) ease-out;
        z-index: 1;
        pointer-events: none;
      }

      .bubble-wrap {
        position: relative;
        max-width: 70%;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
      }

      .scroll-at-top.messages:before {
        opacity: 0;
      }

      .scroll-at-bottom.messages:after {
        opacity: 0;
      }

      .input {
        border: none;
        flex-grow: 1;
        color: #333;
        font-size: 1em;
      }

      .input:focus {
        outline: none;
      }

      input::placeholder {
        opacity: 0.3;
      }

      .input.inactive {
        // pointer-events: none;
        // opacity: 0.3;
      }

      .active {
      }

      .send-icon {
        color: #eee;
        pointer-events: none;
        transform: rotate(-45deg);
        transition: transform 0.2s ease-out;
      }

      .pending .send-icon {
        color: var(--color-primary-dark);
        pointer-events: initial;
        transform: rotate(0deg);
      }

      .notice {
        padding: 1em;
        background: #f8f8f8;
        color: #666;
        text-align: center;
        cursor: pointer;
      }

      .connecting .notice {
        display: flex;
        justify-content: center;
      }

      .connecting .notice temba-icon {
        margin-left: 0.5em;
      }

      .reconnect {
        color: var(--color-primary-dark);
        text-decoration: underline;
        font-size: 0.9em;
      }

      .input:disabled {
        background: transparent !important;
      }

      temba-loading {
        justify-content: center;
        margin: 0.5em auto;
        margin-bottom: 2em;
      }

      temba-loading.hidden {
        display: none;
      }

      .inline {
      }

      .event {
        flex-grow: 1;
        align-self: center;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        font-size: 11px;
        color: #8e8e93;
        max-width: 100%;
        overflow: hidden;
      }

      .event .webhook-event {
        display: inline-flex;
        align-items: flex-start;
        gap: 6px;
        max-width: 100%;
        min-width: 0;
      }

      .event .webhook-event-text {
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        word-break: break-all;
        min-width: 0;
        padding: 4px 0;
      }

      .event .webhook-event-url {
        color: inherit;
        text-decoration: underline;
        cursor: pointer;
      }

      .event .webhook-event-url:hover {
        text-decoration: none;
      }

      .event p {
        margin: 0;
        padding: 0;
      }

      .event strong {
        font-weight: 500;
      }

      .collapse {
      }

      a {
        color: var(--color-primary-dark);
      }

      .attachments {
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
        align-self: flex-start;
      }

      .incoming .attachments {
        align-self: flex-end;
      }

      temba-thumbnail {
        margin: 0.4em;
        border-radius: var(--curvature);
      }

      .failed temba-thumbnail,
      .error temba-thumbnail {
        --thumb-background: #ffe6e6;
        --thumb-border: var(--color-error);
        border: 1px solid var(--color-error);
        color: #ad4747a8;
      }

      .outgoing .popup {
        justify-content: left;
      }

      .incoming .popup {
        justify-content: right;
      }

      .popup {
        display: flex;
        align-items: center;
        position: absolute;
        background: #fff;
        margin: 0;
        /* same treatment as the metadata line in the event tooltips */
        font-size: 11px;
        padding: 6px 10px;
        border-radius: var(--curvature);
        box-shadow:
          rgba(0, 0, 0, 0.05) 0px 3px 7px 0px,
          rgba(0, 0, 0, 0.2) 0px 1px 2px 0px;
        border: 1px solid #f3f3f3;
        opacity: 0;
        visibility: hidden;
        /* sit a small gap above the bubble regardless of popup height
           so the arrow bridges it, matching the event tooltips — the
           hoverable linger makes the gap crossable */
        bottom: calc(100% + 6px);
        transform: translateY(6px);
        z-index: 2;
        /* linger briefly on unhover so the mouse can travel into the
           popup to select or click its contents, then slide back down
           while fading; visibility flips once the fade finishes and
           keeps the hidden popup from swallowing mouse events over
           the bubble */
        transition:
          opacity 120ms cubic-bezier(0.2, 0, 0, 1) 300ms,
          transform 120ms cubic-bezier(0.2, 0, 0, 1) 300ms,
          visibility 0s linear 420ms;
      }

      .popup .log-link {
        margin-left: 1em;
        color: #999;
      }

      .popup .log-link:hover {
        color: var(--color-primary-dark);
      }

      .popup .arrow {
        z-index: 1;
        position: absolute;
        bottom: -9px;
        width: 16px;
        height: 11px;
        /* the shadow is on this wrapper rather than the clipped
           shape below so it hugs the triangle's slanted edges */
        filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.12));
      }

      /* a CSS-drawn tail rather than a ▼ glyph — glyph ink lands
         wherever the platform font puts it, so the tip rendered
         hidden on some systems and overshot on others. This triangle
         is deterministic: its top 2px lie on the popup body hiding
         the border where the tail meets it, the rest bridges the gap
         below so the tip visibly laps over the top of the bubble */
      .popup .arrow::after {
        content: '';
        display: block;
        width: 100%;
        height: 100%;
        background: #fff;
        clip-path: polygon(0 0, 100% 0, 50% 100%);
      }

      .bubble-wrap:hover .popup {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
        /* same 350ms hover-intent delay as the event pill tips, then
           slide up into position */
        transition:
          opacity 120ms cubic-bezier(0.2, 0, 0, 1) 350ms,
          transform 120ms cubic-bezier(0.2, 0, 0, 1) 350ms,
          visibility 0s linear 350ms;
      }

      .new-message-notification {
        position: absolute;
        bottom: 1em;
        left: 50%;
        transform: translateX(-50%) translateY(100px);
        background: var(--color-primary-dark, #3c92dd);
        color: white;
        padding: 0.75em 1.5em;
        border-radius: var(--curvature);
        box-shadow:
          rgba(0, 0, 0, 0.2) 0px 3px 7px 0px,
          rgba(0, 0, 0, 0.3) 0px 1px 2px 0px;
        cursor: pointer;
        opacity: 0;
        transition: all 0.3s ease-out;
        z-index: 100;
        font-weight: 500;
        pointer-events: none;
      }

      .new-message-notification.visible {
        transform: translateX(-50%) translateY(0);
        opacity: 1;
        pointer-events: auto;
      }

      .new-message-notification:hover {
        background: var(--color-primary-darker, #2b7ac4);
        box-shadow:
          rgba(0, 0, 0, 0.3) 0px 4px 10px 0px,
          rgba(0, 0, 0, 0.4) 0px 2px 4px 0px;
      }

      mark {
        background: #fef08a;
        color: #1a1a1a;
        padding: 0.1em 0.3em;
        margin: 0 0.1em;
        border-radius: 3px;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
      }

      .search-match .bubble {
        box-shadow: 0 0 0 2px #fef08a;
      }

      @keyframes search-pulse {
        0% {
          box-shadow: 0 0 0 2px #fef08a;
        }
        50% {
          box-shadow: 0 0 0 4px #fef08a;
        }
        100% {
          box-shadow: 0 0 0 2px #fef08a;
        }
      }

      .search-match .bubble {
        animation: search-pulse 1s ease-in-out 2;
      }
    `;
  }

  @property({ type: Array })
  messageGroups: MessageGroup[] = [];

  @property({ type: Boolean })
  fetching = false;

  @property({ type: Boolean, attribute: false })
  hideTopScroll = true;

  @property({ type: Boolean, attribute: false })
  hideBottomScroll = true;

  @property({ type: String, attribute: 'avatar' })
  defaultAvatar = DEFAULT_AVATAR;

  @property({ type: Boolean })
  agent = false;

  @property({ type: Boolean })
  avatars = false;

  // identity of the contact this chat belongs to, used to render a
  // name-based avatar for the contact's own incoming messages (which the
  // backend does not attach a `_user` to)
  @property({ type: String })
  contactName: string;

  @property({ type: String })
  contactUuid: string;

  @property({ type: Boolean, attribute: false })
  endOfHistory = false;

  @property({ type: Object, attribute: false })
  oldestEventDate: Date = null;

  @property({ type: Boolean, attribute: false })
  showNewMessageNotification = false;

  @property({ type: Object })
  showMessageLogsAfter: Date = null;

  @property({ type: Boolean })
  hasFooter = false;

  @property({ type: Boolean })
  showTimestamps = true;

  @property({ type: String, attribute: false })
  searchHighlight: string = null;

  @property({ type: String, attribute: false })
  highlightMessageUuid: string = null;

  private msgMap = new Map<string, ContactEvent>();

  // runs of informational events collapse behind a summary pill —
  // this tracks which runs the user has expanded as a set of event
  // ids (a run is expanded if any of its events is present). keying
  // on membership rather than the run's first id keeps expansion
  // stable when pagination prepends older events into the run
  private expandedEventChunks = new Set<string>();

  // runs mid-collapse: they keep rendering expanded (with the closing
  // animation) until the animation finishes, then swap to the summary
  private collapsingEventChunks = new Set<string>();
  private metadataCache = new Map<string, ContactEvent>();

  // ephemeral typing indicators by author key - they live in msgMap and
  // messageGroups like real messages (so they group and render normally)
  // but are added and removed through setTyping / clearTyping
  private typingEvents = new Map<string, TypingEvent>();
  private typingTimeouts = new Map<string, number>();

  // bumped on reset so deferred addMessages work from before a reset is
  // discarded rather than re-merged into the fresh view
  private resetGeneration = 0;

  // messages that just arrived live, by uuid, with their position in the
  // batch they came in - they play an entrance, staggered a little when
  // several land together. History pages don't: they were always there.
  private arriving = new Map<string, number>();

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    // clear pending typing decay timers so no callback fires on a detached
    // element (typingEvents/msgMap are left intact for a possible reconnect)
    this.typingTimeouts.forEach((timeout) => window.clearTimeout(timeout));
    this.typingTimeouts.clear();
  }

  public firstUpdated(
    changed: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ): void {
    super.firstUpdated(changed);
    const scroll = this.shadowRoot.querySelector('.scroll');
    const hasScroll = scroll.scrollHeight > scroll.clientHeight;
    this.hideBottomScroll = true;
    this.hideTopScroll = !hasScroll;
  }

  public addMessages(
    messages: ContactEvent[],
    startTime: Date = null,
    append = false,
    maintainScroll = false
  ) {
    if (!startTime) {
      startTime = new Date();
    }

    const generation = this.resetGeneration;
    const elapsed = new Date().getTime() - startTime.getTime();
    window.setTimeout(
      () => {
        this.fetching = false;

        // the chat was reset while we were waiting, our messages are stale
        if (generation !== this.resetGeneration) {
          return;
        }
        // first add messages to the map
        const newMessages = [];
        for (const m of messages) {
          // metadata events aren't rendered themselves - they update the message they reference
          if (m.type === 'msg_deleted' || m.type === 'msg_status_changed') {
            this.applyMetadataEvent(m);
            continue;
          }

          if (this.addMessage(m)) {
            newMessages.push(m.uuid);
          }
        }

        if (newMessages.length === 0) {
          // nothing rendered (a metadata-only or duplicate page) —
          // still settle the fetch and keep the chain going, since an
          // unscrollable view has no other way to ask for the rest of
          // history
          this.fireCustomEvent(CustomEventType.FetchComplete);
          this.requestMoreIfUnscrollable();
          return;
        }

        const ele = this.shadowRoot.querySelector('.scroll');
        const prevTop = ele.scrollTop;
        const prevScrollHeight = ele.scrollHeight;
        const scrollableHeight = ele.scrollHeight - ele.clientHeight;
        const isScrolledAway =
          scrollableHeight > 0 && Math.abs(ele.scrollTop) > 50;

        // a real message from someone typing replaces their indicator, and
        // any remaining indicators re-float below the appended messages
        if (append) {
          this.clearTypingForAuthors(
            newMessages.map((uuid) => this.msgMap.get(uuid))
          );
        }

        const grouped = this.groupMessages(newMessages);
        this.insertGroups(grouped, append);

        if (append) {
          newMessages.forEach((uuid, i) => this.arriving.set(uuid, i));
          this.refloatTyping();
        }

        // show notification if new messages are appended and user is scrolled away from bottom
        // but not during search (searchHighlight is set)
        if (
          append &&
          isScrolledAway &&
          newMessages.length > 0 &&
          !this.searchHighlight
        ) {
          this.showNewMessageNotification = true;
        }

        window.setTimeout(() => {
          if (generation !== this.resetGeneration) {
            return;
          }

          // when appending (new messages at bottom), adjust scroll to maintain visible content
          // with column-reverse, new content at bottom increases scrollHeight
          if (append && (isScrolledAway || maintainScroll)) {
            const heightDiff = ele.scrollHeight - prevScrollHeight;
            ele.scrollTop = prevTop - heightDiff;
          } else {
            ele.scrollTop = prevTop;
          }

          // recalculate shadow visibility after content change
          const scrollableHeight = ele.scrollHeight - ele.clientHeight;
          const absScrollTop = Math.abs(ele.scrollTop);
          this.hideTopScroll = absScrollTop >= scrollableHeight - 1;
          this.hideBottomScroll = absScrollTop <= 1;

          this.fireCustomEvent(CustomEventType.FetchComplete);
          this.requestMoreIfUnscrollable();
        }, 100);
      },
      // if it's the first load don't wait, otherwise wait a minimum amount of time
      this.messageGroups.length === 0
        ? 0
        : Math.max(0, MIN_FETCH_TIME - elapsed)
    );
  }

  /**
   * Synchronously loads messages into the chat without any timeouts or scroll
   * adjustments. Use this when the caller controls visibility and scroll
   * positioning (e.g. search result navigation).
   */
  public loadMessages(messages: ContactEvent[]) {
    const newMessageIds: string[] = [];
    for (const m of messages) {
      if (m.type === 'msg_deleted' || m.type === 'msg_status_changed') {
        this.applyMetadataEvent(m);
        continue;
      }
      if (this.addMessage(m)) {
        newMessageIds.push(m.uuid);
      }
    }
    if (newMessageIds.length > 0) {
      const grouped = this.groupMessages(newMessageIds);
      this.insertGroups(grouped, false);
    }
  }

  /**
   * Applies a metadata event (deletion, status change) to the message it
   * references, or caches it for when that message is loaded.
   */
  private applyMetadataEvent(event: ContactEvent) {
    const msgUuid = (event as any).msg_uuid;
    if (!msgUuid) {
      return;
    }
    const message = this.msgMap.get(msgUuid) as MsgEvent;
    if (message) {
      this.applyMetadata(message, event);
      this.requestUpdate();
    } else {
      this.metadataCache.set(msgUuid, event);
    }
  }

  private applyMetadata(message: MsgEvent, event: ContactEvent) {
    const data = event as any;
    const createdOn =
      data.created_on instanceof Date
        ? data.created_on.toISOString()
        : data.created_on;

    if (event.type === 'msg_deleted') {
      message._deleted = {
        created_on: createdOn,
        by_contact: !!data.by_contact,
        user: event._user
      };

      // mirror the server, which clears the content of deleted messages
      message.msg.text = '';
      message.msg.attachments = [];
    } else if (event.type === 'msg_status_changed') {
      message._status = {
        created_on: createdOn,
        status: data.status,
        reason: data.reason
      };
    }
  }

  private addMessage(msg: ContactEvent): boolean {
    const isNew = !this.messageExists(msg);
    this.msgMap.set(msg.uuid, msg);

    // apply any metadata that arrived before the message itself
    const pending = this.metadataCache.get(msg.uuid);
    if (pending) {
      this.metadataCache.delete(msg.uuid);
      this.applyMetadata(msg as MsgEvent, pending);
    }
    return isNew;
  }

  /**
   * Shows a typing indicator for the event's author, appended to the
   * newest messages so it groups with them. Repeat pulses from the same
   * author just refresh the decay timer; without fresh pulses or an
   * explicit clearTyping the indicator decays on its own.
   */
  public setTyping(event: TypingEvent) {
    const key = getTypingKey(event);
    const shown = this.typingEvents.get(key);
    if (shown) {
      // keep the indicator's timestamp fresh so a long-lived one doesn't
      // drift across the grouping time window and split into its own group
      shown.created_on = event.created_on;
    } else {
      this.typingEvents.set(key, event);
      this.addMessage(event);
      this.arriving.set(event.uuid, 0);
      this.insertGroups(this.groupMessages([event.uuid]), true);
    }

    const existing = this.typingTimeouts.get(key);
    if (existing) {
      window.clearTimeout(existing);
    }
    this.typingTimeouts.set(
      key,
      window.setTimeout(() => this.removeTyping(key), TYPING_TIMEOUT)
    );
  }

  /**
   * Clears the typing indicator for the event's author, or all indicators
   * when no event is given.
   */
  public clearTyping(event?: TypingEvent) {
    if (event) {
      this.removeTyping(getTypingKey(event));
    } else {
      for (const key of [...this.typingEvents.keys()]) {
        this.removeTyping(key);
      }
    }
  }

  private removeTyping(key: string) {
    const timeout = this.typingTimeouts.get(key);
    if (timeout) {
      window.clearTimeout(timeout);
      this.typingTimeouts.delete(key);
    }

    const event = this.typingEvents.get(key);
    if (event) {
      this.typingEvents.delete(key);
      this.removeEvent(event.uuid);
    }
  }

  private removeEvent(uuid: string) {
    this.msgMap.delete(uuid);
    for (let i = 0; i < this.messageGroups.length; i++) {
      const group = this.messageGroups[i];
      const idx = group.messages.indexOf(uuid);
      if (idx >= 0) {
        group.messages.splice(idx, 1);
        if (group.messages.length === 0) {
          this.messageGroups.splice(i, 1);
        }
        break;
      }
    }
    this.requestUpdate('messageGroups');
  }

  // an author's real message replaces their typing indicator
  private clearTypingForAuthors(events: ContactEvent[]) {
    for (const event of events) {
      if (event.type === 'typing_started') {
        continue;
      }
      const key = event._user?.uuid
        ? event._user.uuid
        : event.type === 'msg_received'
          ? 'contact'
          : null;
      if (key && this.typingEvents.has(key)) {
        this.removeTyping(key);
      }
    }
  }

  // re-appends active typing indicators so they always sit below the
  // newest messages
  private refloatTyping() {
    if (this.typingEvents.size === 0) {
      return;
    }
    const events = [...this.typingEvents.values()];
    for (const event of events) {
      this.removeEvent(event.uuid);
    }
    for (const event of events) {
      this.addMessage(event);
    }
    this.insertGroups(
      this.groupMessages(events.map((event) => event.uuid)),
      true
    );
  }

  public messageExists(msg: ContactEvent): boolean {
    return this.msgMap.has(msg.uuid);
  }

  private isSameGroup(
    msg1: ContactEvent,
    msg2: ContactEvent
  ): { same: boolean; reason?: GroupReason } {
    if (!msg1 || !msg2) {
      return { same: true };
    }

    // for type equivalence, treat all non-message types as the same.
    // Notes are treated like messages so they group with other notes
    // only when type + author match (and split from non-note events).
    const type1 = effectiveType(msg1);
    const type2 = effectiveType(msg2);
    const isMsg1 =
      type1 === 'msg_created' ||
      type1 === 'msg_received' ||
      type1 === 'ivr_created' ||
      type1 === 'ticket_note_added';
    const isMsg2 =
      type2 === 'msg_created' ||
      type2 === 'msg_received' ||
      type2 === 'ivr_created' ||
      type2 === 'ticket_note_added';
    const typeMatch = isMsg1 && isMsg2 ? type1 === type2 : isMsg1 === isMsg2;

    // the only time boundary is the calendar day (the chat renders
    // day sections with sticky markers, so groups must align to
    // days) — within a day, hours apart doesn't split a group, so
    // e.g. a run expiry and a campaign start hours later still
    // condense with the events between them
    if (getDayKey(msg1.created_on) !== getDayKey(msg2.created_on)) {
      return { same: false, reason: 'time_elapsed' };
    }

    if (!typeMatch) {
      return { same: false, reason: 'new_type' };
    }

    // only check author for message types
    if (isMsg1 && isMsg2 && msg1._user?.name !== msg2._user?.name) {
      return { same: false, reason: 'new_author' };
    }

    return { same: true };
  }

  private insertGroups(newGroups: MessageGroup[], append = false) {
    if (!append) {
      newGroups.reverse();
    }

    for (const newGroup of newGroups) {
      // see if our new group belongs to the most recent group
      const group =
        this.messageGroups[append ? 0 : this.messageGroups.length - 1];

      if (group) {
        const lastMsgId = group.messages[group.messages.length - 1];
        const lastMsg = this.msgMap.get(lastMsgId);
        const newMsg = this.msgMap.get(newGroup.messages[0]);
        // if our message belongs to the previous group, in we go
        const groupCheck = this.isSameGroup(lastMsg, newMsg);
        if (groupCheck.same) {
          if (append) {
            group.messages.push(...newGroup.messages);
          } else {
            // historical messages are older, prepend to maintain chronological order
            group.messages.unshift(...newGroup.messages);
          }
        } else {
          // otherwise, just add our entire group as a new one
          if (append) {
            this.messageGroups.splice(0, 0, newGroup);
          } else {
            // update the boundary group's reason to reflect the new adjacency
            if (groupCheck.reason) {
              group.reason = groupCheck.reason;
            }
            this.messageGroups.push(newGroup);
          }
        }
      } else {
        if (append) {
          this.messageGroups.splice(0, 0, newGroup);
        } else {
          this.messageGroups.push(newGroup);
        }
      }
    }

    this.requestUpdate('messageGroups');
  }

  private groupMessages(msgIds: string[]): MessageGroup[] {
    // group our messages by origin and user
    const groups: MessageGroup[] = [];
    let lastGroup: MessageGroup = null;
    let lastMsg: ContactEvent = null;

    for (const msgId of msgIds) {
      const msg = this.msgMap.get(msgId);
      const groupCheck = this.isSameGroup(msg, lastMsg);

      if (!groupCheck.same || !lastGroup) {
        lastGroup = {
          messages: [],
          reason: groupCheck.reason || 'initial'
        };
        groups.push(lastGroup);
      }

      lastGroup.messages.push(msgId);
      lastMsg = msg;
    }
    return groups;
  }

  /**
   * Older history is fetched from scroll position, but a fetched page
   * can render shorter than the viewport (condensed event runs
   * collapse a whole page into a line or two), leaving nothing to
   * scroll and no way to request more. After content settles, keep
   * asking for history until the view can meaningfully scroll — the
   * host's own guards (in-flight fetch, end of history) stop the
   * chain.
   */
  private requestMoreIfUnscrollable() {
    const ele = this.shadowRoot.querySelector('.scroll');
    if (ele && ele.scrollHeight - ele.clientHeight <= SCROLL_FETCH_BUFFER) {
      this.fireCustomEvent(CustomEventType.ScrollThreshold);
    }
  }

  private handleScroll(event: any) {
    const ele = event.target;
    const scrollableHeight = ele.scrollHeight - ele.clientHeight;

    if (scrollableHeight <= 0) {
      return;
    }

    // with column-reverse, scrollTop behavior depends on the browser
    // check if scrollTop is negative (some browsers) or positive (others)
    const absScrollTop = Math.abs(ele.scrollTop);

    // when scrolling up to older messages, absScrollTop increases
    // trigger when we're close to the maximum scroll (oldest messages)
    const shouldFetch = absScrollTop >= scrollableHeight - SCROLL_FETCH_BUFFER;

    this.hideTopScroll = absScrollTop >= scrollableHeight - 1;
    this.hideBottomScroll = absScrollTop <= 1;

    // hide notification when scrolled to bottom
    if (absScrollTop <= 10) {
      this.showNewMessageNotification = false;
    }

    if (shouldFetch) {
      this.fireCustomEvent(CustomEventType.ScrollThreshold);
    }

    // trigger when scrolling near the bottom (newest messages) in column-reverse
    if (absScrollTop <= SCROLL_FETCH_BUFFER * 3 && scrollableHeight > 0) {
      this.fireCustomEvent(CustomEventType.ScrollThresholdBottom);
    }
  }

  public scrollToBottom() {
    const scroll = this.shadowRoot.querySelector('.scroll');
    if (scroll) {
      scroll.scrollTop = 0;
      this.hideBottomScroll = true;
      this.showNewMessageNotification = false;
    }
  }

  public scrollToMessage(
    uuid: string,
    animate = true,
    onComplete?: () => void
  ) {
    this.highlightMessageUuid = uuid;
    window.setTimeout(() => {
      const scroll = this.shadowRoot.querySelector('.scroll') as HTMLElement;
      const row = this.shadowRoot.querySelector(
        `.row[data-uuid="${uuid}"]`
      ) as HTMLElement;
      if (scroll && row) {
        // manually set scrollTop to center the row within the scroll area
        // this avoids scrollIntoView which can move ancestor containers
        const scrollRect = scroll.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const rowCenter = rowRect.top + rowRect.height / 2;
        const scrollCenter = scrollRect.top + scrollRect.height / 2;
        const offset = rowCenter - scrollCenter;
        if (animate) {
          scroll.scrollBy({ top: offset, behavior: 'smooth' });
        } else {
          scroll.scrollTop = scroll.scrollTop + offset;
        }
      }
      if (onComplete) {
        // wait one frame for the browser to finish the scroll
        requestAnimationFrame(() => onComplete());
      }
    }, 150);
  }

  private highlightText(text: string, search: string): TemplateResult | string {
    if (!search || !text) {
      return text;
    }
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    const parts = text.split(regex);
    if (parts.length === 1) {
      return text;
    }
    return html`${parts.map((part, index) =>
      index % 2 === 1 ? html`<mark>${part}</mark>` : part
    )}`;
  }

  private handleNewMessageClick() {
    this.scrollToBottom();
  }

  private getReasonLabel(reason: GroupReason): string {
    switch (reason) {
      case 'new_author':
        return '👤 Different author';
      case 'new_type':
        return '🔄 Message type changed';
      case 'time_elapsed':
      case 'initial':
      default:
        return '';
    }
  }

  private arrivingClass(uuid: string): string {
    return this.arriving.has(uuid) ? 'arriving' : '';
  }

  // later arrivals in a batch start a beat after the ones before them, up
  // to a short cap so a big catch-up doesn't crawl in
  private arrivingStyle(uuid: string): string | typeof nothing {
    const index = this.arriving.get(uuid);
    if (index === undefined) {
      return nothing;
    }
    return `--arrive-delay: ${Math.min(index, 5) * 45}ms`;
  }

  // once played, an entrance is done - the row keeps its class until the
  // next render, which is fine as an animation only runs when a node is made
  private handleArrived(uuids: string[]) {
    uuids.forEach((uuid) => this.arriving.delete(uuid));
  }

  private renderMessageGroup(group: MessageGroup): TemplateResult {
    const msgIds = group.messages;

    const mostRecentId = msgIds[msgIds.length - 1];
    const currentMsg = this.msgMap.get(mostRecentId);

    const currentType = effectiveType(currentMsg);
    const incoming = this.agent
      ? currentType !== 'msg_received'
      : currentType === 'msg_received';

    const name = currentMsg._user?.name;

    const isMessageType =
      currentType === 'msg_received' ||
      currentType === 'msg_created' ||
      currentType === 'ivr_created' ||
      currentType === 'ticket_note_added';
    const showAvatar =
      this.avatars && ((isMessageType && this.agent) || !incoming);

    // resolve the identity shown in the avatar: prefer the user attached to
    // the event (an agent or flow author), otherwise fall back to the contact
    // for their own incoming messages.
    //
    // contact fallback assumes `_user` is absent for `msg_received` (contact
    // messages carry no `_user`, so first_name/last_name aren't available and
    // getFullName falls back to `name`); the fallback only applies when there
    // is no `_user` on the event.
    const fromContact = currentType === 'msg_received' && !currentMsg._user;
    const avatarName = currentMsg._user
      ? currentMsg._user.name
      : fromContact
        ? this.contactName
        : undefined;
    const avatarUuid = currentMsg._user
      ? currentMsg._user.uuid
      : fromContact
        ? this.contactUuid
        : undefined;

    // determine whether to fall back to the generic default (system) avatar.
    // when the event has a `_user`, preserve the original behavior exactly:
    // system iff that user has no uuid (a name-only flow author still gets the
    // default avatar). for a contact event with no `_user`, it's system only
    // when we have no contact identity at all.
    const isSystem = currentMsg._user
      ? !currentMsg._user.uuid
      : fromContact
        ? !this.contactUuid && !this.contactName
        : true;

    const reasonLabel = this.getReasonLabel(group.reason);
    const showReason = false; // reasonLabel && idx > 0;

    // chunk the group into runs — consecutive condensable pill events
    // share a single wrapping row, everything else renders one per row
    const chunks: { condensed: boolean; ids: string[]; start: number }[] = [];
    msgIds.forEach((msgId, index) => {
      const msg = this.msgMap.get(msgId);
      const condensed =
        msg?._rendered?.type === MessageType.Inline &&
        CONDENSED_EVENT_TYPES.has(msg.type);
      const last = chunks[chunks.length - 1];
      if (last && last.condensed && condensed) {
        last.ids.push(msgId);
      } else {
        chunks.push({ condensed, ids: [msgId], start: index });
      }
    });

    const resultHtml = html`
      <div class="block  ${incoming ? 'incoming' : 'outgoing'}">
        <div class="group-messages" style="flex-grow:1">
          ${repeat(
            chunks,
            (chunk) => chunk.ids[0],
            (chunk) => {
              if (chunk.condensed) {
                // condensable events collapse behind a single summary
                // pill until expanded — even a run of one, so single
                // events behave the same as longer runs
                const expanded = chunk.ids.some((id) =>
                  this.expandedEventChunks.has(id)
                );
                if (!expanded) {
                  const events = chunk.ids.map((id) => this.msgMap.get(id));
                  return html`<div class="row message is-event summary-row">
                    <div class="event">
                      ${renderEventSummary(events, () => {
                        chunk.ids.forEach((id) =>
                          this.expandedEventChunks.add(id)
                        );
                        this.requestUpdate();
                      })}
                    </div>
                  </div>`;
                }

                // collapsing runs keep rendering expanded while the
                // closing animation plays, then swap to the summary
                const collapsing = chunk.ids.some((id) =>
                  this.collapsingEventChunks.has(id)
                );
                return html`<div
                  class="row message is-event condensed-events ${collapsing
                    ? 'collapsing'
                    : ''} ${this.arrivingClass(chunk.ids[0])}"
                  style=${this.arrivingStyle(chunk.ids[0])}
                  @animationend=${() => this.handleArrived(chunk.ids)}
                >
                  <div class="reveal">
                    <div class="reveal-inner">
                      <div class="run">
                        <div
                          class="collapse-rail"
                          title=${msg('Collapse')}
                          @click=${() => {
                            if (collapsing) {
                              return;
                            }
                            chunk.ids.forEach((id) =>
                              this.collapsingEventChunks.add(id)
                            );
                            this.requestUpdate();
                            window.setTimeout(() => {
                              chunk.ids.forEach((id) => {
                                this.collapsingEventChunks.delete(id);
                                this.expandedEventChunks.delete(id);
                              });
                              this.requestUpdate();
                            }, 180);
                          }}
                        >
                          <temba-icon name="up" size="0.85"></temba-icon>
                          <div class="rail-line"></div>
                        </div>
                        <div class="events">
                          ${chunk.ids.map((msgId) => {
                            const msg = this.msgMap.get(msgId);
                            return html`<div
                              class="event"
                              data-uuid=${msg.uuid || nothing}
                            >
                              ${msg._rendered.html}
                            </div>`;
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>`;
              }
              return chunk.ids.map((msgId, chunkIndex) => {
                const index = chunk.start + chunkIndex;
                const msg = this.msgMap.get(msgId);
                const msgEvent = msg as MsgEvent;
                const statusClass = (msg as any)._status
                  ? (msg as any)._status.status
                  : '';
                const hasError =
                  msgEvent.msg?.unsendable_reason ||
                  (msgEvent._status?.reason &&
                    (statusClass === 'failed' || statusClass === 'errored'));
                const unsendableClass = hasError ? 'error' : '';
                const deletedClass = msgEvent._deleted ? 'deleted' : '';
                const emptyClass = isEmptyMsg(msgEvent) ? 'empty' : '';
                const latestClass = index === msgIds.length - 1 ? 'latest' : '';
                const eventClass = msg._rendered ? 'is-event' : '';
                const noteClass =
                  msg.type === 'ticket_note_added' ? 'note' : '';
                const typingClass =
                  msg.type === 'typing_started' ? 'typing' : '';
                const matchClass =
                  this.highlightMessageUuid === msg.uuid ? 'search-match' : '';
                return html`<div
                  class="row message ${statusClass} ${unsendableClass} ${deletedClass} ${emptyClass} ${latestClass} ${eventClass} ${noteClass} ${typingClass} ${matchClass} ${this.arrivingClass(
                    msgId
                  )}"
                  style=${this.arrivingStyle(msgId)}
                  data-uuid=${msg.uuid || nothing}
                  @animationend=${() => this.handleArrived([msgId])}
                >
                  ${this.renderMessage(msg, index == 0 ? name : null)}
                </div>`;
              });
            }
          )}
        </div>
        ${showAvatar
          ? html`<div class="avatar" style="align-self:flex-end">
              <temba-user
                uuid=${avatarUuid ?? nothing}
                name=${avatarName ?? nothing}
                first_name=${currentMsg._user?.first_name ?? nothing}
                last_name=${currentMsg._user?.last_name ?? nothing}
                avatar=${currentMsg._user?.avatar ?? nothing}
                ?system=${isSystem}
              >
              </temba-user>
            </div>`
          : null}
      </div>
      ${showReason
        ? html`<div class="group-reason">${reasonLabel}</div>`
        : null}
    `;

    return resultHtml;
  }

  private renderNote(event: TicketEvent, name: string | null): TemplateResult {
    // notes carry their time the same way messages do — in the
    // hover popup — rather than printing it under the bubble
    return html`<div class="bubble-wrap">
      ${this.showTimestamps
        ? html`<div class="popup" style="white-space: nowrap;">
            <temba-date
              value="${event.created_on.toISOString()}"
              display="datetime"
            ></temba-date>
            <div class="arrow"></div>
          </div>`
        : null}
      <div class="bubble">
        ${name ? html`<div class="name">${name}</div>` : null}
        <div style="white-space: pre-wrap;">${event.note}</div>
      </div>
    </div>`;
  }

  private renderMessage(event: ContactEvent, name = null): TemplateResult {
    if (event._rendered) {
      return html`<div class="event">${event._rendered.html}</div>`;
    }

    if (event.type === 'ticket_note_added') {
      return this.renderNote(event as TicketEvent, name);
    }

    if (event.type === 'typing_started') {
      return html`<div class="bubble-wrap">
        <div class="bubble">
          ${name ? html`<div class="name">${name}</div>` : null}
          <div class="typing-dots"><span></span><span></span><span></span></div>
        </div>
      </div>`;
    }

    const message = event as MsgEvent;

    // safety check: if msg doesn't exist, return nothing
    if (!message.msg) {
      return html``;
    }

    const unsendableReason = message.msg?.unsendable_reason;
    const statusReason = message._status?.reason;
    const errorMessage = unsendableReason
      ? getUnsendableReasonMessage(unsendableReason)
      : statusReason
        ? getStatusReasonMessage(statusReason)
        : null;

    const isDeleted = message._deleted;

    // a deleted message has its channel logs deleted too, so no log link
    const logsURL =
      !isDeleted &&
      this.showMessageLogsAfter &&
      message.created_on >= this.showMessageLogsAfter &&
      message.msg.channel
        ? `/channels/channel/logs/${message.msg.channel.uuid}/msg/${event.uuid}/`
        : null;

    const deletedByText = isDeleted
      ? message._deleted.by_contact
        ? msg('contact')
        : message._deleted.user?.name || msg('user')
      : null;

    // messages with no text and no attachments get a muted placeholder
    const isEmpty = isEmptyMsg(message);

    // check if message has location attachment and text is just coordinates
    const hasLocationAttachment = message.msg.attachments?.some((att) =>
      attachmentAsString(att).startsWith('geo:')
    );
    const textIsCoordinates =
      hasLocationAttachment &&
      message.msg.text &&
      /^-?\d+\.?\d*\s*,\s*-?\d+\.?\d*$/.test(message.msg.text.trim());
    // Keep the text interpolation itself whitespace-free: this element uses
    // pre-wrap, so formatter-inserted newlines become visible in screenshots.
    const messageText =
      this.searchHighlight && this.highlightMessageUuid === message.uuid
        ? this.highlightText(message.msg.text, this.searchHighlight)
        : message.msg.text;

    return html`
      <div class="bubble-wrap">
        ${this.showTimestamps
          ? html`<div class="popup" style="white-space: nowrap;">
              ${errorMessage
                ? html`<div
                    style="color: var(--color-error); margin-right: 1em;"
                  >
                    ${errorMessage}
                  </div>`
                : null}
              <temba-date
                value="${message.created_on.toISOString()}"
                display="datetime"
              ></temba-date>
              ${logsURL
                ? html`<a
                    class="log-link"
                    href="${logsURL}"
                    target="_blank"
                    rel="noopener noreferrer"
                    ><temba-icon name="log"></temba-icon
                  ></a>`
                : null}

              <div class="arrow"></div>
            </div>`
          : null}
        ${isDeleted
          ? html`<div class="bubble">
              ${name ? html`<div class="name">${name}</div>` : null}
              <div class="message-deleted">
                ${msg(str`Message deleted by ${deletedByText}`)}
              </div>
            </div>`
          : isEmpty
            ? html`<div class="bubble">
                ${name ? html`<div class="name">${name}</div>` : null}
                <div class="message-empty">${msg('Empty Message')}</div>
              </div>`
            : message.msg.text && !textIsCoordinates
              ? html`<div class="bubble">
                  ${name ? html`<div class="name">${name}</div>` : null}
                  <div class="message-text">${messageText}</div>
                </div>`
              : null}

        <div class="attachments">
          ${(message.msg.attachments || []).map(
            (attachment) =>
              html`<temba-thumbnail
                attachment="${attachmentAsString(attachment)}"
              ></temba-thumbnail>`
          )}
        </div>
      </div>
    `;
  }

  public reset() {
    this.resetGeneration++;
    this.typingTimeouts.forEach((timeout) => window.clearTimeout(timeout));
    this.typingTimeouts.clear();
    this.typingEvents.clear();
    this.msgMap.clear();
    this.metadataCache.clear();
    this.expandedEventChunks.clear();
    this.collapsingEventChunks.clear();
    this.arriving.clear();
    this.messageGroups = [];
    this.hideBottomScroll = true;
    this.hideTopScroll = true;
    this.endOfHistory = false;
    this.oldestEventDate = null;
  }

  public setEndOfHistory(oldestDate: Date) {
    this.endOfHistory = true;
    this.oldestEventDate = oldestDate;
  }

  public render(): TemplateResult {
    return html` <div
      class="
        messages 
        ${this.hideBottomScroll ? 'scroll-at-bottom' : ''}
        ${this.hideTopScroll ? 'scroll-at-top' : ''}"
    >
      <div class="scroll" @scroll=${this.handleScroll}>
        ${this.messageGroups
          ? (() => {
              // bucket groups into calendar-day sections, oldest to
              // newest (high index to low index). Each section renders
              // with a sticky day marker that floats over its messages
              // while they scroll by.
              const sections: {
                key: string;
                label: string;
                groups: TemplateResult[];
              }[] = [];
              for (let idx = this.messageGroups.length - 1; idx >= 0; idx--) {
                const msgGroup = this.messageGroups[idx];
                const firstMsg = this.msgMap.get(msgGroup.messages[0]);
                const day = firstMsg?.created_on || new Date();
                const key = getDayKey(day);
                let section = sections[sections.length - 1];
                if (!section || section.key !== key) {
                  section = { key, label: getDayLabel(day), groups: [] };
                  sections.push(section);
                }
                // oldest first within the section — the section is a
                // normal top-down column, only the scroller reverses
                section.groups.push(this.renderMessageGroup(msgGroup));
              }
              // newest section first in DOM for the column-reverse scroller
              sections.reverse();
              return sections.map(
                (section) =>
                  html`<div class="day-section">
                    <div class="day-marker">
                      <div class="day">${section.label}</div>
                    </div>
                    ${section.groups}
                  </div>`
              );
            })()
          : null}

        <temba-loading
          class="${!this.fetching ? 'hidden' : ''}"
        ></temba-loading>
      </div>
      ${!this.hasFooter
        ? html`<div
            class="new-message-notification ${this.showNewMessageNotification
              ? 'visible'
              : ''}"
            @click=${this.handleNewMessageClick}
          >
            New Messages
          </div>`
        : null}
      <slot class="header" name="header"></slot>
      <slot class="footer" name="footer"></slot>
    </div>`;
  }
}
