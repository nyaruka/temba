/* eslint-disable @typescript-eslint/no-this-alias */
import {
  css,
  html,
  nothing,
  PropertyValueMap,
  PropertyValues,
  TemplateResult
} from 'lit';
import { property } from 'lit/decorators.js';
import { msg, str } from '@lit/localize';
import {
  Contact,
  CustomEventType,
  NamedUser,
  Ticket,
  User
} from '../interfaces';
import {
  formatCount,
  fetchResults,
  generateUUIDv7,
  getUrl,
  postJSON,
  postUrl,
  WebResponse
} from '../utils';
import { ContactStoreElement } from './ContactStoreElement';
import { Compose, ComposeValue } from '../form/Compose';
import { ContactHistoryPage } from '../events';
import {
  Chat,
  MessageType,
  ContactEvent,
  MsgEvent,
  TypingEvent as RenderedTypingEvent
} from '../display/Chat';
import { DEFAULT_AVATAR } from '../webchat/assets';
import { UserPicker } from '../form/UserPicker';
import { Select } from '../form/select/Select';
import {
  Events,
  renderEvent,
  renderTicketAction,
  renderTicketAssigneeChanged
} from '../events/eventRenderers';
import { publishToSocket } from './SocketService';
import {
  ContactHistoryEvent,
  RealtimeSubscription,
  subscribeToContactHistory,
  TypingEvent
} from './Realtime';
import { applyContactEvent, watchContact } from './ContactWatch';
import { Icon } from '../Icons';
import { designTokens } from '../styles/designTokens';
import { DateTime } from 'luxon';

// how often we re-publish typing_started while composing - just inside the
// tightest platform sustain interval (Telegram's indicator lapses after 5s)
const TYPING_PULSE_INTERVAL = 4000;

// how often we re-render idle conversations so the last seen duration
// doesn't go stale
const STATE_REFRESH_INTERVAL = 60000;

// re-export for backwards compatibility
export { renderTicketAction, renderTicketAssigneeChanged };

export interface SearchResult {
  uuid: string;
  type: string;
  created_on: string;
  ticket_uuid?: string;
  msg?: any;
  _user?: any;
  [key: string]: any;
}

export class ContactChat extends ContactStoreElement {
  // we run our own firehose subscription below (history rendering, typing,
  // ephemeral state) with its own contact/ticket channel choreography, so we
  // opt out of the central watcher entirely - our data loads and syncs
  // through the store as before
  protected watchTypes: string[] = null;

  public static get styles() {
    return css`
      ${designTokens}

      :host {
        flex-grow: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        margin-top: var(--gap);
        --compose-shadow: none;
        --compose-border: none;
        --compose-padding: 3px;
        --compose-curvature: none;
      }

      .chat-wrapper {
        display: flex;
        flex-grow: 1;
        flex-direction: column;
        min-height: 0;
        background: var(--surface);
        /* inside a card layout's header frame, the frame draws these */
        border: var(--framed-border, 1px solid var(--border-strong));
        border-radius: var(--framed-radius, var(--r-lg));
        box-shadow: var(--framed-shadow, var(--shadow-2));
        overflow: hidden;
      }

      temba-contact-history {
        flex-grow: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }

      .compose {
        display: flex;
        flex-direction: column;
        --compose-border: 1px solid #e1e1e1;
        --compose-curvature: 6px;
        margin: 0.5em;
        /* white keeps the input readable as a card against the tinted
           chat box region behind it - rounded to match the compose
           container so the corners don't bleed past its border */
        background: #fff;
        border-radius: var(--compose-curvature);
      }

      /* The chat box focuses with a solid outline and no exterior
         glow - just this control, other widgets keep the design-system
         halo. The focus vars must be set on temba-compose itself - its
         shadow :host declares them via the design tokens, which beats
         anything inherited from .compose. */
      .compose temba-compose {
        --color-focus: var(--focus, rgb(91, 156, 229));
        --widget-box-shadow-focused: none;
      }

      /* While the contact is in a flow the compose outline carries the
         flow hue: resting border matches the flow pill border, focus
         goes solid flow green. The pre-mixed static comes first — a
         custom property can't fall back per-declaration, so the
         derived version needs the @supports gate. */
      .in-flow .compose {
        --compose-border: 1px solid #c5e8d2;
      }

      @supports (color: color-mix(in srgb, red, red)) {
        .in-flow .compose {
          --compose-border: 1px solid
            color-mix(in srgb, var(--flow, #16a34a) 25%, white);
        }
      }

      .in-flow .compose temba-compose {
        --color-focus: var(--flow, #16a34a);
      }

      .closed-footer {
        padding: 1em;
        background: #f2f2f2;
        border-top: 3px solid #e1e1e1;
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      a {
        color: var(--color-link-primary);
      }

      a:hover {
        text-decoration: underline;
        color: var(--color-link-primary-hover);
      }

      temba-button {
        margin: 0.1em 0.25em;
      }

      temba-completion {
        --widget-box-shadow: none;
        --color-widget-border: transparent;
        --widget-box-shadow-focused: none;
        --color-focus: transparent;
        --color-widget-bg-focused: transparent;
      }

      .error-gutter {
        display: flex;
        padding: 0.5em 1em;
        background: #f9f9f9;
        item-align: center;
      }

      .error-message {
        color: var(--color-error);
        padding-right: 1em;
        flex-grow: 1;
        align-self: center;
      }

      /* The history draws no bottom border - each strip below it
         (ticket bar, status row, chat box) owns its top border
         instead, so the separator always belongs to the strip it
         introduces. The status row's goes flow-green while the
         contact is in a flow, which places the green line below the
         ticket bar when there is one and directly below the history
         when there isn't. */
      temba-chat {
        background: linear-gradient(0deg, #fff, #fff);
        --color-chat-out: var(--color-message);
        /* nothing floats over the bottom of the history anymore - the
           status area below holds that content, so no reserved space */
        --chat-bottom-padding: 1em;
        transition: opacity 0.15s ease;
      }

      .chat-container {
        position: relative;
        display: flex;
        flex-direction: column;
        flex-grow: 1;
        min-height: 0;
      }

      /* The search bar rides above the chat card — outside its border —
         so sliding it in shrinks the card to make room instead of
         overlaying the history. It borrows the list pages' searchbar
         layout (bare single-line input + trailing icon controls) but
         wears the card chrome (surface + border + shadow) instead of the
         sunken strip — the page background here is grey, so a sunken bar
         would blend right into it. The gap below it is the layout's
         spacing unit, matching the gap between the chat and the cards. */
      @keyframes search-slide-in {
        from {
          max-height: 0;
          opacity: 0;
          padding-top: 0;
          padding-bottom: 0;
          margin-bottom: 0;
        }
        to {
          max-height: 3em;
          opacity: 1;
          padding-top: 4px;
          padding-bottom: 4px;
          margin-bottom: var(--layout-spacing, 8px);
        }
      }

      @keyframes search-slide-out {
        from {
          max-height: 3em;
          opacity: 1;
          padding-top: 4px;
          padding-bottom: 4px;
          margin-bottom: var(--layout-spacing, 8px);
        }
        to {
          max-height: 0;
          opacity: 0;
          padding-top: 0;
          padding-bottom: 0;
          margin-bottom: 0;
        }
      }

      .searchbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 12px;
        /* inside a framed card it keeps off the frame's edges - outside one
           it sits flush above the chat card */
        margin: var(--framed-inset, 0) var(--framed-inset, 0)
          var(--layout-spacing, 8px);
        background: var(--surface);
        border: 1px solid var(--border-strong);
        border-radius: var(--r-lg);
        box-shadow: var(--shadow-2);
        color: var(--text-3);
        font-family: var(--font);
        font-size: 13.5px;
        overflow: hidden;
        animation: search-slide-in 0.15s ease-out;
      }

      .searchbar.closing {
        animation: search-slide-out 0.15s ease-in forwards;
      }

      .searchbar input {
        flex: 1 1 auto;
        border: 0;
        background: transparent;
        outline: 0;
        font: inherit;
        color: var(--text-1);
        min-width: 0;
        /* match the stepper buttons' height so the bar doesn't grow
           when results (and their page buttons) appear */
        height: 22px;
      }

      .searchbar input::placeholder {
        color: var(--text-3);
      }

      /* "↵ to search" hint — fades in alongside the run-search icon
         only while there's a pending draft to apply. */
      .searchbar .search-hint {
        flex: 0 0 auto;
        font-size: 0.75em;
        color: var(--text-3);
        white-space: nowrap;
        user-select: none;
      }

      .searchbar .search-hint .enter-key {
        position: relative;
        top: 2px;
      }

      /* Standard clickable icons — bare glyph at rest, a circular wash
         on hover. The default wash is near-white and disappears against
         the white bar, so each carries a more saturated one; run search
         only renders when a draft is pending, so it's always the
         primary action and its wash warms to accent. */
      .searchbar .search-go,
      .searchbar .search-cancel {
        flex: 0 0 auto;
        margin-left: 5px;
        --icon-color: var(--text-3);
        --icon-color-circle-hover: rgba(15, 22, 36, 0.1);
      }

      .searchbar .search-go {
        --icon-color-circle-hover: var(--accent-200);
      }

      /* Match stepper — the list pager's chevron-only page buttons
         bracketing a quiet "n of N" count, stepping through matches
         instead of pages. */
      .match-pager {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 2px;
      }

      .pager-status {
        padding: 0 4px;
        color: var(--text-3);
        font-size: 12.5px;
        white-space: nowrap;
      }

      .page-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: var(--r-sm);
        color: var(--text-3);
        cursor: pointer;
        user-select: none;
      }

      /* enter-target lights the button Enter would fire — the older-
         match step while the input holds the already-searched query. */
      .page-btn:hover,
      .page-btn.enter-target {
        background: var(--sunken);
        color: var(--text-1);
      }

      .page-btn temba-icon {
        --icon-color: currentColor;
      }

      .search-no-results {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: var(--text-3);
        font-family: var(--font);
        font-size: 13.5px;
        text-align: center;
        pointer-events: none;
        z-index: 5;
      }

      /* The search trigger floats over the history's top-right corner,
         styled as the list pages' Search action chip — bordered icon +
         label — but on an opaque surface (with a soft shadow) since it
         sits over chat content rather than a header. */
      .search-toggle {
        position: absolute;
        top: 0.75em;
        right: 1.5em;
        z-index: 5;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 26px;
        box-sizing: border-box;
        padding: 0 10px;
        border: 1px solid var(--border-strong);
        border-radius: var(--r-sm);
        background: var(--surface);
        color: var(--text-2);
        font-family: var(--font);
        font-size: 13px;
        cursor: pointer;
        user-select: none;
        box-shadow: var(--shadow-1);
      }

      .search-toggle:hover {
        background: var(--sunken);
        color: var(--text-1);
      }

      .search-toggle temba-icon {
        --icon-color: currentColor;
      }

      /* The single status area above the chat box. Holds the ticket
         controls (assignee / topic / close) and the contact status
         (last seen, current flow) as stacked rows sharing one tint so
         everything about the conversation's state lives in one place,
         between the history and the compose. */
      .status-area {
        background: rgba(0, 0, 0, 0.02);
      }

      /* the compose drops its top margin so the status area hugs the
         chat box instead of floating above it */
      .status-area + .chat-box .compose {
        margin-top: 0;
      }

      /* Insets match .ticket-controls (px, not em - the rows have
         different font sizes and em padding would drift the edges
         apart) so the last seen lines up with the assignee widget box
         and the Interrupt button sits flush with the Close button. */
      .contact-status {
        display: flex;
        align-items: center;
        justify-content: space-between;
        /* px so the guaranteed breathing room between last seen and
           the flow doesn't scale down with the row's small font - the
           flow name ellipsizes before this gap ever compresses */
        gap: 24px;
        padding: 5px 8px;
        font-size: 11.5px;
        color: #8e8e93;
        border-top: 1px solid #ddd;
      }

      /* While the contact is in a flow the row takes the flow pill's
         wash and foreground (see pillVariants .pill-flow) so it reads
         as flow-tinted - the ticket controls above keep the plain
         status-area grey. Fallbacks match the --flow design token for
         pages without tokens. */
      .in-flow .contact-status {
        /* pre-mixed statics first for browsers without color-mix() */
        background: #e3f4e9;
        color: var(--flow, #16a34a);
        --icon-color: var(--flow, #16a34a);
        border-top-color: #c5e8d2;
      }

      @supports (color: color-mix(in srgb, red, red)) {
        .in-flow .contact-status {
          background: color-mix(in srgb, var(--flow, #16a34a) 12%, white);
          border-top-color: color-mix(in srgb, var(--flow, #16a34a) 25%, white);
        }
      }

      /* compact the interrupt button to the row's caption scale */
      .contact-status temba-button {
        --button-small-height: 20px;
        --button-small-x-pad: 6px;
        --button-small-font-size: 11px;
      }

      .contact-status .last-seen {
        white-space: nowrap;
        /* last seen always reads in full - the flow side gives way */
        flex-shrink: 0;
      }

      .contact-status .current-flow {
        display: flex;
        align-items: center;
        gap: 0.5em;
        /* the flow name can be long - let it ellipsize instead of
           crowding out the last seen side */
        min-width: 0;
        margin-left: auto;
      }

      .contact-status .current-flow .flow-link {
        display: flex;
        align-items: center;
        gap: 0.35em;
        color: inherit;
        font-weight: 500;
        text-decoration: none;
        min-width: 0;
      }

      .contact-status .current-flow .flow-link .flow-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        /* shrinks with the bar but keeps a couple of characters plus
           the ellipsis so the name never collapses entirely */
        min-width: 2em;
      }

      .contact-status .current-flow .flow-link:hover .flow-name {
        text-decoration: underline;
      }

      .contact-status .current-flow temba-button {
        flex-shrink: 0;
        margin-left: 0.25em;
      }

      /* The compose region shares the status area tint so the panel is
         framed by the same treatment top and bottom. */
      .chat-box {
        background: rgba(0, 0, 0, 0.02);
        border-top: 1px solid #ddd;
      }

      /* the status row and chat box share one tinted region - no line
         between them */
      .status-area + .chat-box {
        border-top: none;
      }

      .in-flow .chat-box {
        /* pre-mixed static first for browsers without color-mix() */
        background: #e3f4e9;
      }

      @supports (color: color-mix(in srgb, red, red)) {
        .in-flow .chat-box {
          background: color-mix(in srgb, var(--flow, #16a34a) 12%, white);
        }
      }

      .ticket-controls {
        padding: 8px;
        text-align: center;
        align-items: center;
        display: flex;
        border-top: 1px solid #ddd;
      }

      /* the row's controls all stand 32px tall, the height the assignee
         picker's avatar needs, so it reads as one strip - the select's
         height doesn't count its 1px border */
      .ticket-controls temba-select {
        --temba-select-min-height: 30px;
      }

      /* the assignee picker, the same one that heads the ticket list, sized
         down to the strip - a 22px avatar (its 26px circle at 0.85) and the
         row's own type - and boxed like the topic select beside it */
      .ticket-controls temba-user-picker {
        width: 220px;
        flex-shrink: 0;
        --user-picker-font-size: 13px;
        --user-picker-font-weight: var(--w-medium, 500);
        --user-picker-avatar-size: 22px;
        --user-picker-avatar-scale: 0.85;
        --user-picker-gap: 6px;
        --user-picker-inset: 4px;
        --user-picker-min-height: 32px;
        --user-picker-bg: var(--color-widget-bg, #fff);
        --user-picker-hover-bg: var(--color-widget-bg-focused, #fff);
        --user-picker-border: 1px solid var(--color-widget-border);
      }

      temba-user {
        border: 1px solid #ddd;
        padding: 0.2em 0.5em;
        border-radius: var(--curvature);
        min-width: 10em;
        background: #fff;
      }

      temba-user:hover {
        border: 1px solid #ddd;
        background: #f9f9f9;
      }

      .assign-button {
        --button-mask: #ebebeb;
        color: #333;
        margin: 0.25em;
      }

      temba-button {
        --button-border: 1px solid #ddd;
      }

      /* close and reopen sit at the height, type and corners of the row's
         other controls */
      .ticket-controls temba-button {
        /* a button's edge is a 1px ring outside its box, so 30px reads as
           32px beside the bordered select */
        --button-small-height: 30px;
        --button-small-x-pad: 12px;
        --button-small-font-size: 13px;
        --button-small-radius: var(--r, 8px);
      }
    `;
  }

  @property({ type: String, attribute: 'ticket' })
  ticketUUID: string;

  @property({ type: String })
  contactsEndpoint = '/api/v2/contacts.json';

  @property({ type: String })
  currentNote = '';

  @property({ type: Boolean })
  showDetails = true;

  @property({ type: Object })
  currentTicket: Ticket = null;

  @property({ type: Object })
  currentContact: Contact = null;

  @property({ type: String })
  agent = '';

  // uuid of the logged-in user, used to filter out our own typing events
  // (publications are echoed to all subscribers, including the publisher)
  @property({ type: String, attribute: 'user' })
  userUuid = '';

  @property({ type: Boolean })
  blockFetching = false;

  @property({ type: Boolean })
  showInterrupt = false;

  @property({ type: Boolean })
  disableAssign = false;

  @property({ type: Boolean })
  disableReply = false;

  @property({ type: Boolean })
  showSearch = false;

  @property({ type: String })
  avatar = DEFAULT_AVATAR;

  @property({ type: String })
  set showMessageLogsAfter(value: string) {
    const oldValue = this._showMessageLogsAfter;
    this._showMessageLogsAfter = value ? new Date(value) : null;
    this.requestUpdate('showMessageLogsAfter', oldValue);
  }

  get showMessageLogsAfter(): Date {
    return this._showMessageLogsAfter;
  }

  private _showMessageLogsAfter: Date = null;

  @property({ type: String })
  errorMessage: string;

  @property({ type: Boolean, attribute: false })
  errorRetryable = true;

  @property({ type: Boolean, attribute: false })
  searchMode = false;

  @property({ type: String, attribute: false })
  searchQuery = '';

  @property({ type: Array, attribute: false })
  searchResults: SearchResult[] = [];

  @property({ type: Number, attribute: false })
  searchIndex = -1;

  @property({ type: Boolean, attribute: false })
  searchLoading = false;

  @property({ type: Boolean, attribute: false })
  searchFocused = false;

  @property({ type: Boolean, attribute: false })
  searchClosing = false;

  @property({ type: Boolean, attribute: false })
  searchNoResults = false;

  // http promise to monitor for completeness
  public httpComplete: Promise<void>;
  private chat: Chat;

  ticket = null;
  beforeUUID: string = null; // for scrolling back through history
  afterUUID: string = null; // newest event seen, for catch-up fetches

  // live history subscriptions by topic for the current contact (and ticket)
  private subscriptions = new Map<string, RealtimeSubscription>();
  private fetchingMissed = false;

  // the contact's most recent incoming message, tracked for the external id
  // that typing publications carry (WhatsApp expresses typing as an operation
  // on the contact's last incoming message)
  private lastIncomingMsgOn: Date = null;
  private lastIncomingMsgExternalId: string = null;

  // typing publication state - the pulse interval while the agent is
  // composing, and whether publishing was denied for this conversation
  private typingChannel: string = null;
  private typingPulse: number = null;
  private typingDisabled = false;

  // periodic re-render keeping the last seen duration fresh while the
  // conversation is idle
  private stateRefresh: number = null;

  constructor() {
    super();
  }

  public willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);

    if (changed.has('data')) {
      this.currentContact = this.data;
    }

    if (changed.has('currentContact') && this.currentContact) {
      const prev = changed.get('currentContact') as Contact | undefined;
      if (this.currentContact.uuid !== prev?.uuid) {
        this.blockFetching = false;
        this.errorMessage = null;
      }
    }
  }

  public firstUpdated(
    changed: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ): void {
    super.firstUpdated(changed);
  }

  public connectedCallback() {
    super.connectedCallback();
    this.chat = this.shadowRoot.querySelector('temba-chat');
    // a search handed off before we had a chat to run it in only waits on
    // the contact, which may already be loaded
    this.tryPendingSearch();
    this.updateSubscriptions();
    this.stateRefresh = window.setInterval(
      () => this.requestUpdate(),
      STATE_REFRESH_INTERVAL
    );
  }

  public disconnectedCallback() {
    super.disconnectedCallback();
    this.stopTyping();
    this.unsubscribeAll();
    window.clearInterval(this.stateRefresh);
    this.stateRefresh = null;
  }

  public updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    if (
      changedProperties.has('currentContact') ||
      changedProperties.has('currentTicket')
    ) {
      this.updateSubscriptions();
    }

    if (changedProperties.has('currentContact') && this.currentContact) {
      this.chat = this.shadowRoot.querySelector('temba-chat');
      if (
        this.currentContact.uuid !==
        changedProperties.get('currentContact')?.uuid
      ) {
        this.reset();
      } else {
        this.fetchMissedEvents();
      }
      this.fetchPreviousMessages();
      this.tryPendingSearch();
    }
  }

  private unsubscribeAll() {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions.clear();
  }

  /**
   * Keeps our socket subscriptions in sync with the current contact and
   * ticket. New events arrive as they happen on "history:<contact-uuid>";
   * ticket detail events (notes, assignment, topic) only arrive on
   * "history:<contact-uuid>:<ticket-uuid>" so we subscribe to both when
   * viewing a ticket. Only the channels that actually changed are touched,
   * so switching tickets on the same contact leaves the contact channel
   * continuously subscribed with no gap in delivery.
   */
  private updateSubscriptions() {
    const topics = new Map<string, { contact: string; ticket: string }>();
    if (this.isConnected && this.currentContact) {
      const contact = this.currentContact.uuid;
      topics.set(contact, { contact, ticket: null });

      // on a contact switch the new ticket is set before the new contact has
      // finished fetching, so hold off on the ticket channel until they match
      // - a ticket paired with another contact's channel is denied server-side
      const contactPending = this.contact && this.contact !== contact;
      if (this.currentTicket && !contactPending) {
        topics.set(`${contact}:${this.currentTicket.uuid}`, {
          contact,
          ticket: this.currentTicket.uuid
        });
      }
    }

    // drop subscriptions we no longer need
    this.subscriptions.forEach((sub, key) => {
      if (!topics.has(key)) {
        sub.unsubscribe();
        this.subscriptions.delete(key);
      }
    });

    // add any new ones
    topics.forEach((topic, key) => {
      if (!this.subscriptions.has(key)) {
        this.subscriptions.set(
          key,
          // the contact's own channel is owned by the central watcher, which
          // every other contact component on the page shares - we take it as
          // a stream and keep rendering history ourselves. Ticket detail
          // events aren't contact state and stay a direct subscription
          topic.ticket
            ? subscribeToContactHistory(
                topic.contact,
                topic.ticket,
                (data: any) => this.handleSocketEvent(data),
                // on every (re)subscribe fetch anything we might have missed
                () => this.fetchMissedEvents()
              )
            : watchContact(
                topic.contact,
                '*',
                (event: any) => this.handleSocketEvent(event),
                () => this.fetchMissedEvents()
              )
        );
      }
    });
  }

  private handleSocketEvent(event: ContactHistoryEvent) {
    if (!this.currentContact) {
      return;
    }

    // ephemeral contact state updates - they don't touch the history view
    // so they apply even while searching
    if (
      event.type === Events.CONTACT_LAST_SEEN_CHANGED ||
      event.type === Events.CONTACT_FLOW_CHANGED
    ) {
      this.handleContactStateEvent(event);
      return;
    }

    // while searching we're viewing an arbitrary point in history, new
    // events will be picked up by the refetch when search closes
    if (!this.chat || this.searchMode) {
      return;
    }

    // typing events are ephemeral indicator state, not history
    if (
      event.type === Events.TYPING_STARTED ||
      event.type === Events.TYPING_STOPPED
    ) {
      this.handleTypingEvent(event as TypingEvent);
      return;
    }

    // createMessages parses the wire event into the rendered form the page
    // type describes, dates and all
    const messages = this.createMessages({
      events: [this.copyWireEvent(event) as unknown as ContactEvent],
      next: null
    });
    if (messages.length > 0) {
      this.chat.addMessages(messages, null, true);
    }
  }

  /**
   * Ephemeral events that update contact state rather than record history.
   * They are never persisted, so applying them is the only way they show up.
   * How each one applies is the central watcher's to define - we just run it
   * against our copy, which is the store's cached contact, so applying it in
   * place also keeps the cache fresh for later readers.
   */
  private handleContactStateEvent(event: ContactHistoryEvent) {
    applyContactEvent(this.currentContact, event);
    this.requestUpdate();
  }

  private getLastSeen(): { duration: string; title: string } | null {
    const lastSeenOn = this.currentContact?.last_seen_on;
    if (!lastSeenOn || !this.store) {
      return null;
    }

    // unparseable values and zero-value times (e.g. go's zero time for a
    // contact that has never been seen) mean there's no last seen to show
    const lastSeen = DateTime.fromISO(lastSeenOn);
    if (!lastSeen.isValid || lastSeen.year <= 1) {
      return null;
    }

    // recent activity speaks for itself in the chat - only surface last
    // seen once the contact has been quiet for at least an hour
    const minutes = DateTime.now().diff(lastSeen, 'minutes').minutes;
    if (minutes < 60) {
      return null;
    }

    return {
      duration: this.store.getShortDuration(lastSeen),
      title: lastSeen.toLocaleString(DateTime.DATETIME_SHORT)
    };
  }

  private handleTypingEvent(event: TypingEvent) {
    // our own publications are echoed back to us - ignore them
    if (event._user && this.userUuid && event._user.uuid === this.userUuid) {
      return;
    }

    // the wire event is handed to every subscriber on this channel, so render
    // into our own copy rather than parsing its date in place
    const typing = {
      ...this.copyWireEvent(event),
      created_on: new Date(event.created_on)
    } as RenderedTypingEvent;
    this.resolveUserAvatar(typing);

    if (event.type === Events.TYPING_STARTED) {
      this.chat.setTyping(typing);
    } else {
      this.chat.clearTyping(typing);
    }
  }

  /**
   * Fired as the agent edits the compose box. Composing (any text present)
   * keeps typing_started pulses going on the contact's history channel;
   * emptying the box (including via a send) publishes typing_stopped.
   */
  private handleComposeChanged(evt: CustomEvent) {
    // temba-compose's ContentChanged detail is its langValues map keyed by
    // language, and it drops a language entry when that value empties. Derive
    // composing across all languages so this doesn't hinge on a hardcoded key.
    const composing = Object.values(evt.detail || {}).some((v: any) =>
      v?.text?.trim()
    );
    if (composing) {
      this.startTyping();
    } else {
      this.stopTyping();
    }
  }

  private getTypingPayload(type: string) {
    const payload: any = { type };
    if (this.lastIncomingMsgExternalId) {
      payload.msg_external_id = this.lastIncomingMsgExternalId;
    }
    return payload;
  }

  private startTyping() {
    if (this.typingDisabled || this.typingPulse || !this.currentContact) {
      return;
    }

    // publications are only allowed on the contact-level channel
    this.typingChannel = `history:${this.currentContact.uuid}`;
    this.sendTypingPulse();
    this.typingPulse = window.setInterval(
      () => this.sendTypingPulse(),
      TYPING_PULSE_INTERVAL
    );
  }

  private sendTypingPulse() {
    // the interval can fire once after clearTypingPulse() nulled the channel
    if (!this.typingChannel) {
      return;
    }
    const channel = this.typingChannel;
    publishToSocket(channel, this.getTypingPayload('typing_started')).catch(
      (error: any) => {
        // a temporary server error just costs us this pulse - a denial means
        // something is genuinely wrong with this conversation, so silently
        // stop pulsing for it. The handler runs async, so don't clobber a
        // fresh conversation's state with an error for a stale one.
        if (!error?.temporary && this.isCurrentTypingChannel(channel)) {
          this.typingDisabled = true;
          this.clearTypingPulse();
        }
      }
    );
  }

  // whether the channel belongs to the contact currently being viewed
  private isCurrentTypingChannel(channel: string) {
    return channel === `history:${this.currentContact?.uuid}`;
  }

  private clearTypingPulse() {
    if (this.typingPulse) {
      window.clearInterval(this.typingPulse);
      this.typingPulse = null;
    }
    this.typingChannel = null;
  }

  private stopTyping() {
    if (!this.typingPulse) {
      return;
    }

    const channel = this.typingChannel;
    this.clearTypingPulse();
    publishToSocket(channel, this.getTypingPayload('typing_stopped')).catch(
      (error: any) => {
        // on a contact switch this stop targets the old conversation - a
        // denial for it must not disable typing for the new one
        if (!error?.temporary && this.isCurrentTypingChannel(channel)) {
          this.typingDisabled = true;
        }
      }
    );
  }

  private reset() {
    if (this.chat) {
      this.chat.reset();
    }
    this.ticket = null;
    this.beforeUUID = null;
    this.afterUUID = null;
    this.fetchingMissed = false;

    // let the old conversation know we stopped composing and start the new
    // one with a clean typing slate
    this.stopTyping();
    this.typingDisabled = false;
    this.lastIncomingMsgOn = null;
    this.lastIncomingMsgExternalId = null;

    const compose = this.shadowRoot.querySelector('temba-compose') as Compose;
    if (compose) {
      compose.reset();
    }
  }

  /**
   * Clears the state of the current search - its query, results and the
   * flags driving the search bar. Opening a fresh search keeps whatever
   * lastSearchedQuery was, so its results can be re-run; closing or
   * starting a new one drops it too.
   */
  private resetSearchState(query = '', clearLastSearched = false) {
    this.searchQuery = query;
    this.searchResults = [];
    this.searchIndex = -1;
    this.searchLoading = false;
    this.searchNoResults = false;
    if (clearLastSearched) {
      this.lastSearchedQuery = '';
    }
  }

  /** Focuses the search input once the search bar has rendered. */
  private focusSearchInput() {
    window.setTimeout(() => {
      const input = this.shadowRoot.querySelector('.search-input') as any;
      if (input) {
        input.focus();
      }
    }, 50);
  }

  private handleSearchToggle() {
    // an opening or closing search supersedes any hand-off still waiting
    // on a contact to load
    this.pendingSearch = null;

    if (this.searchMode) {
      this.handleSearchClose();
    } else {
      this.searchMode = true;
      this.resetSearchState();
      this.focusSearchInput();
    }
  }

  /** Drops any search positioning — highlights, block flags, paging
   * anchors — and reloads the history at its normal, most-recent view. */
  private restoreUnsearchedView() {
    const chat = this.chat;
    if (!chat) {
      return;
    }

    chat.searchHighlight = null;
    chat.highlightMessageUuid = null;
    chat.reset();
    this.blockFetching = false;
    this.blockFetchingNewer = false;
    this.fetchingNewer = false;
    this.beforeUUID = null;
    this.afterUUID = null;
    this.fetchPreviousMessages();
  }

  private handleSearchClose() {
    // supersede any in-flight match navigation right away — its chain
    // must not re-assert highlights over the restored view below
    this.searchGeneration++;
    // and a hand-off waiting on a contact must not reopen search behind
    // the user once it lands
    this.pendingSearch = null;
    this.searchClosing = true;
    window.setTimeout(() => {
      this.searchClosing = false;
      this.searchMode = false;
      // if a hand-off forced the search bar onto a conversation the host
      // had opted out of, put the host's choice back
      if (this.forcedShowSearch) {
        this.forcedShowSearch = false;
        this.showSearch = false;
      }
      this.resetSearchState('', true);
      this.restoreUnsearchedView();
    }, 150);
  }

  private handleSearchInput(e: Event) {
    const input = e.target as HTMLInputElement;
    this.searchQuery = input.value;

    // the user typing their own query supersedes any hand-off still
    // waiting on a contact to load
    this.pendingSearch = null;

    // any edit away from the searched query invalidates its results —
    // drop them and put the history back at its unsearched view rather
    // than staying parked at a stale match; backspacing to nothing is
    // just an empty search. Clearing lastSearchedQuery also means
    // retyping the same query and hitting Enter re-runs the search.
    if (this.searchQuery.trim() !== this.lastSearchedQuery) {
      // only reload the view when a search had actually run — while
      // typing a fresh query the history is already showing it
      const hadSearch = this.lastSearchedQuery !== '';
      this.searchGeneration++;
      this.searchResults = [];
      this.searchIndex = -1;
      this.searchNoResults = false;
      this.lastSearchedQuery = '';
      if (hadSearch) {
        this.restoreUnsearchedView();
      }
    }
  }

  // tracks the query that produced the current searchResults
  private lastSearchedQuery = '';

  // a search requested (e.g. from the cross-ticket search modal) before the
  // contact had loaded — executed once that contact and the chat are ready
  private pendingSearch: {
    query: string;
    event: SearchResult;
    contactUuid: string;
  } = null;

  // whether startSearch turned showSearch on for a hand-off, so closing the
  // search can restore the host's opt-out
  private forcedShowSearch = false;

  /**
   * Opens search mode and executes the given query, landing on the given
   * event — which is inserted into the results if the endpoint's matches
   * don't reach back far enough to include it. Safe to call before the
   * contact has finished loading — the search runs once it has.
   */
  public startSearch(query: string, event: SearchResult = null): void {
    if (!query || !query.trim()) {
      return;
    }
    this.searchMode = true;
    // hosts only turn search on for some conversations (e.g. once a contact
    // has been seen), but a hand-off always needs the bar - it carries the
    // match stepper and the only way back out of the searched view. Track
    // when we forced it so closing the search restores the host's choice
    if (!this.showSearch) {
      this.showSearch = true;
      this.forcedShowSearch = true;
    }
    this.resetSearchState(query, true);
    // the contact the host has asked us to show, which may still be
    // loading — the search belongs to it and nobody else
    this.pendingSearch = {
      query: query.trim(),
      event,
      contactUuid: this.contact
    };
    this.focusSearchInput();
    this.tryPendingSearch();
  }

  private tryPendingSearch(): void {
    const pending = this.pendingSearch;
    if (!pending || !this.currentContact || !this.chat) {
      return;
    }

    // the search was requested for a specific contact — hold it while that
    // contact is still loading, but drop it once the host has moved on to
    // another one rather than running it against the wrong history
    if (
      pending.contactUuid &&
      pending.contactUuid !== this.currentContact.uuid
    ) {
      if (pending.contactUuid !== this.contact) {
        this.pendingSearch = null;
      }
      return;
    }

    // executeSearch declines while another search is still in flight — keep
    // the hand-off queued in that case so a later update can run it rather
    // than dropping it on the floor
    this.searchQuery = pending.query;
    if (this.executeSearch(pending.event)) {
      this.pendingSearch = null;
    }
  }

  // bumped whenever the current search is superseded (new search, query
  // edit, close) — navigateToResult's async fade/load chain captures the
  // value at entry and bails at each step once it goes stale, so a chain
  // already in flight can't re-assert highlights or scroll position over
  // a view the user has since moved on from
  private searchGeneration = 0;

  private handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const currentQuery = this.searchQuery.trim();
      if (currentQuery !== this.lastSearchedQuery) {
        this.executeSearch();
      } else if (e.shiftKey) {
        this.handleSearchPrev();
      } else {
        this.handleSearchNext();
      }
    } else if (e.key === 'Escape') {
      this.handleSearchClose();
      e.preventDefault();
    }
  }

  /** Runs the current query, returning whether it was actually started. */
  private executeSearch(targetEvent: SearchResult = null): boolean {
    const query = this.searchQuery.trim();
    if (!query || !this.currentContact || this.searchLoading) {
      return false;
    }

    // a fresh search supersedes any navigation still in flight
    this.searchGeneration++;
    this.searchLoading = true;
    this.searchResults = [];
    this.searchIndex = -1;
    this.searchNoResults = false;
    this.lastSearchedQuery = query;
    if (this.chat) {
      this.chat.searchHighlight = null;
      this.chat.highlightMessageUuid = null;
      this.chat.reset();
    }

    // the chat always shows the contact's full history — even when viewing
    // a ticket — so search always covers all of the contact's messages
    const url = `/contact/chat_search/${this.currentContact.uuid}/?text=${encodeURIComponent(query)}`;

    getUrl(url)
      .then((response: WebResponse) => {
        this.searchLoading = false;
        // ignore a response the user has already moved past — editing the
        // query (handleSearchInput clears lastSearchedQuery) or closing search
        // (handleSearchClose flips searchMode off) can land before a slow
        // response; applying it here would repopulate results for and scroll to
        // a superseded query.
        if (this.lastSearchedQuery !== query || !this.searchMode) {
          return;
        }
        // the stepper walks newest → oldest ("older match" steps forward
        // through the list), so order the results newest-first here rather
        // than depending on the endpoint's ordering (uuid v7 sorts
        // chronologically, matching the uuid comparisons used elsewhere)
        const results = ((response.json.results || []) as SearchResult[]).sort(
          (a, b) => b.uuid.toLowerCase().localeCompare(a.uuid.toLowerCase())
        );

        // the endpoint caps how many matches it returns, so the event we
        // were handed off may not be among them — splice it into its own
        // spot in the ordering so the hand-off always lands on it
        if (targetEvent && !results.some((r) => r.uuid === targetEvent.uuid)) {
          const older = results.findIndex(
            (r) =>
              r.uuid
                .toLowerCase()
                .localeCompare(targetEvent.uuid.toLowerCase()) < 0
          );
          results.splice(older === -1 ? results.length : older, 0, targetEvent);
        }
        this.searchResults = results;

        if (this.searchResults.length > 0) {
          this.searchNoResults = false;
          const targetIndex = targetEvent
            ? this.searchResults.findIndex((r) => r.uuid === targetEvent.uuid)
            : -1;
          const index = targetIndex !== -1 ? targetIndex : 0;
          this.searchIndex = index;
          this.navigateToResult(index);
        } else {
          this.searchNoResults = true;
          this.searchIndex = -1;
        }
      })
      .catch(() => {
        this.searchLoading = false;
        if (this.lastSearchedQuery !== query || !this.searchMode) {
          return;
        }
        this.searchResults = [];
        this.searchIndex = -1;
        this.searchNoResults = false;
      });

    return true;
  }

  private navigateToResult(index: number) {
    if (index < 0 || index >= this.searchResults.length) {
      return;
    }

    this.searchIndex = index;
    const result = this.searchResults[index];

    const FADE_MS = 120;

    if (!this.chat) {
      return;
    }

    const endpoint = this.getEndpoint();
    if (!endpoint) {
      return;
    }

    // the chain below spans fade timers and fetches — capture the current
    // generation so each step can bail if the search is superseded
    // (closed, edited, or re-run) while it's still in flight
    const generation = this.searchGeneration;
    const stale = () => generation !== this.searchGeneration;

    // highlight the query that produced these results, not the current input
    // text — a draft edit mid-navigation must not mislabel the highlights.
    this.chat.searchHighlight = this.lastSearchedQuery;

    // start fetches immediately (in parallel with fade-out)
    const beforePromise = fetchContactHistory(
      endpoint,
      this.currentTicket?.uuid,
      result.uuid,
      null
    );
    const afterPromise = fetchContactHistory(
      endpoint,
      this.currentTicket?.uuid,
      null,
      result.uuid
    );

    // fade out, then hide completely before swapping content
    this.chat.style.opacity = '0';

    window.setTimeout(() => {
      // superseded while fading out — leave the view to whatever
      // superseded us and just undo our fade
      if (stale()) {
        this.chat.style.opacity = '1';
        return;
      }

      // fully hidden (including scrollbar) during content swap
      this.chat.style.visibility = 'hidden';
      this.chat.reset();
      this.blockFetching = false;
      this.blockFetchingNewer = false;
      this.fetchingNewer = false;
      this.beforeUUID = null;
      this.afterUUID = null;

      const matchedEvent: ContactEvent = {
        ...result,
        created_on: new Date(result.created_on)
      };

      let navigationCompleted = false;
      Promise.all([beforePromise, afterPromise])
        .then(([beforePage, afterPage]) => {
          // superseded while the pages were loading — the finally below
          // restores visibility since navigationCompleted is still false
          if (stale()) {
            return;
          }

          const afterMessages = this.createMessages(afterPage);
          afterMessages.reverse();

          const beforeMessages = this.createMessages(beforePage);
          beforeMessages.reverse();

          const matchPage = {
            events: [matchedEvent],
            next: null
          } as ContactHistoryPage;
          const matchMessages = this.createMessages(matchPage);
          matchMessages.reverse();

          if (beforePage.next) {
            this.beforeUUID = beforePage.next;
          } else if (beforeMessages.length > 0) {
            const oldestBefore =
              beforePage.events[beforePage.events.length - 1];
            this.beforeUUID = oldestBefore.uuid;
          } else {
            this.blockFetching = true;
            const allEvents = [...afterMessages, ...matchMessages];
            if (allEvents.length > 0) {
              const oldest = allEvents[allEvents.length - 1];
              this.chat.setEndOfHistory(new Date(oldest.created_on));
            }
          }

          // synchronously load all messages (no internal timeouts)
          const allMessages = [
            ...beforeMessages,
            ...matchMessages,
            ...afterMessages
          ];
          this.chat.loadMessages(allMessages);

          // wait for Lit to render the DOM, then position scroll, then reveal
          // uses setTimeout instead of requestAnimationFrame for test compatibility
          navigationCompleted = true;
          this.chat.updateComplete.then(() => {
            window.setTimeout(() => {
              if (!this.chat) return;

              // superseded after the messages rendered — don't re-assert
              // the highlight or scroll over the restored view, but do
              // undo our hide (navigationCompleted is already true, so
              // the finally won't)
              if (stale()) {
                this.chat.style.visibility = 'visible';
                this.chat.style.opacity = '1';
                return;
              }

              // position internal scroll only — never use scrollIntoView
              // which can move ancestor containers
              this.chat.highlightMessageUuid = result.uuid;
              const scroll = this.chat.shadowRoot?.querySelector(
                '.scroll'
              ) as HTMLElement;
              const row = this.chat.shadowRoot?.querySelector(
                `.row[data-uuid="${result.uuid}"]`
              ) as HTMLElement;
              if (scroll && row) {
                // calculate position to center the row within the scroll area
                // column-reverse: scrollTop=0 is bottom, negative is up
                const scrollRect = scroll.getBoundingClientRect();
                const rowRect = row.getBoundingClientRect();
                const rowCenter = rowRect.top + rowRect.height / 2;
                const scrollCenter = scrollRect.top + scrollRect.height / 2;
                const offset = rowCenter - scrollCenter;
                scroll.scrollTop = scroll.scrollTop + offset;
              } else {
                // fallback: just go to bottom
                if (scroll) {
                  scroll.scrollTop = 0;
                }
              }

              // let scroll settle, then fade in
              window.setTimeout(() => {
                if (this.chat) {
                  this.chat.style.visibility = 'visible';
                  this.chat.style.opacity = '0';
                  window.setTimeout(() => {
                    if (this.chat) {
                      this.chat.style.opacity = '1';
                    }
                  }, 16);
                }
              }, 16);
            }, 16);
          });
        })
        .catch(() => {
          // superseded — whatever superseded us already owns the reload
          if (stale()) {
            return;
          }
          this.blockFetching = false;
          this.blockFetchingNewer = false;
          this.fetchingNewer = false;
          this.beforeUUID = null;
          this.afterUUID = null;
          this.fetchPreviousMessages();
        })
        .finally(() => {
          if (!navigationCompleted && this.chat) {
            this.chat.style.visibility = 'visible';
            this.chat.style.opacity = '1';
          }
        });
    }, FADE_MS);
  }

  private handleSearchPrev() {
    if (this.searchResults.length === 0) {
      return;
    }
    const newIndex =
      this.searchIndex <= 0
        ? this.searchResults.length - 1
        : this.searchIndex - 1;
    this.navigateToResult(newIndex);
  }

  private handleSearchNext() {
    if (this.searchResults.length === 0) {
      return;
    }
    const newIndex =
      this.searchIndex >= this.searchResults.length - 1
        ? 0
        : this.searchIndex + 1;
    this.navigateToResult(newIndex);
  }

  private handleInterrupt() {
    this.fireCustomEvent(CustomEventType.Interrupt, {
      contact: this.currentContact
    });
  }

  private handleRetry() {
    const compose = this.shadowRoot.querySelector('temba-compose') as Compose;
    compose.triggerSend();
  }

  private handleSend(evt: CustomEvent) {
    this.errorMessage = null;
    const composeEle = evt.currentTarget as Compose;
    const compose = evt.detail.langValues['und'] as ComposeValue;

    const payload = {
      contact: this.currentContact.uuid
    };

    const text = compose.text;
    if (text && text.length > 0) {
      payload['text'] = text;
    }
    const attachments = compose.attachments;
    if (attachments && attachments.length > 0) {
      const attachment_uuids = attachments.map((attachment) => attachment.uuid);
      payload['attachments'] = attachment_uuids;
    }

    if (this.currentTicket) {
      payload['ticket'] = this.currentTicket.uuid;
    }

    const genericError = msg('Send failed, please try again.');
    postJSON(`/contact/chat/${this.currentContact.uuid}/`, payload)
      .then((response) => {
        if (response.status < 400) {
          const event = response.json.event;
          event.created_on = new Date(event.created_on);
          this.resolveUserAvatar(event);
          this.chat.addMessages([event], null, true);
          composeEle.reset();
          this.fireCustomEvent(CustomEventType.MessageSent, {
            msg: payload,
            response
          });
        } else if (response.json?.['error']) {
          // the server says why it refused (e.g. the workspace can't send),
          // which resending won't change
          this.errorMessage = response.json['error'];
          this.errorRetryable = false;
        } else {
          this.errorMessage = genericError;
          this.errorRetryable = true;
        }
      })
      .catch(() => {
        this.errorMessage = genericError;
        this.errorRetryable = true;
      });
  }

  private getEndpoint() {
    if (this.contact) {
      return `/contact/chat/${this.contact}/`;
    }
    return null;
  }

  public prerender(event: ContactEvent) {
    // use the unified renderEvent function with isSimulation = false
    const rendered = renderEvent(event, false);

    if (rendered) {
      event._rendered = {
        html: rendered,
        type: MessageType.Inline
      };
    }
  }

  /**
   * Keeps the store's avatar cache fresh from server-hydrated user refs and
   * fills in refs that arrive without one - events published over sockets
   * carry only a user's uuid and name. Ticket assignment events carry a
   * second user ref (the assignee) whose avatar feeds the event's hover
   * tooltip.
   */
  /**
   * A copy of a wire event we can parse and resolve into. The event object is
   * handed to every subscriber on the channel, and resolveUserAvatar writes an
   * avatar onto the user objects hanging off it, so a shallow spread isn't
   * enough on its own - those ride through it aliased.
   */
  private copyWireEvent(event: any): any {
    const copy = { ...event };
    if (copy._user) {
      copy._user = { ...copy._user };
    }
    if (copy.assignee) {
      copy.assignee = { ...copy.assignee };
    }
    return copy;
  }

  private resolveUserAvatar(event: any) {
    for (const user of [event._user, event.assignee]) {
      if (user && user.uuid && this.store) {
        if (user.avatar) {
          this.store.setUserAvatar(user.uuid, user.avatar);
        } else {
          user.avatar = this.store.getUserAvatar(user.uuid);
        }
      }
    }
  }

  private createMessages(page: ContactHistoryPage): ContactEvent[] {
    if (page.events) {
      const messages: ContactEvent[] = [];
      page.events.forEach((event) => {
        this.resolveUserAvatar(event);
        // track the UUID of the newest event for polling
        if (
          !this.afterUUID ||
          event.uuid.toLowerCase() > this.afterUUID.toLowerCase()
        ) {
          this.afterUUID = event.uuid;
        }

        // convert to dates
        event.created_on = new Date(event.created_on);

        // track the contact's most recent incoming message for the external
        // id our typing publications carry
        if (event.type === 'msg_received') {
          if (
            !this.lastIncomingMsgOn ||
            event.created_on > this.lastIncomingMsgOn
          ) {
            this.lastIncomingMsgOn = event.created_on;
            this.lastIncomingMsgExternalId =
              (event as MsgEvent).msg?.external_id || null;
          }
        }

        if (
          event.type === 'msg_created' ||
          event.type === 'msg_received' ||
          event.type === 'ivr_created' ||
          event.type === 'ticket_note_added'
        ) {
          // Notes render as chat-style bubbles (see Chat.ts), so push them
          // through directly rather than prerendering into an inline event.
          messages.push(event);
        } else {
          this.prerender(event);
          if (event._rendered) {
            messages.push(event);
          }
        }
      });

      // remove any messages we don't recognize
      return messages.filter((msg) => !!msg);
    }
    return [];
  }

  /**
   * Fetches any events newer than the last one we've seen. New events
   * normally arrive over the socket, so this is only needed to cover gaps -
   * events published between our initial history fetch and the subscription
   * becoming active, or while a dropped connection was reconnecting.
   */
  private fetchMissedEvents() {
    // we are already working on it or in search mode
    if (this.fetchingMissed || this.searchMode) {
      return;
    }

    const chat = this.chat;
    if (this.currentContact && this.afterUUID) {
      this.fetchingMissed = true;
      const endpoint = this.getEndpoint();
      if (!endpoint) {
        this.fetchingMissed = false;
        return;
      }

      const fetchContact = this.currentContact.uuid;
      const fetchTicket = this.currentTicket?.uuid;

      fetchContactHistory(endpoint, fetchTicket, null, this.afterUUID).then(
        (page: ContactHistoryPage) => {
          this.fetchingMissed = false;

          // things may have changed while we were fetching
          if (
            this.searchMode ||
            fetchContact !== this.currentContact?.uuid ||
            fetchTicket !== this.currentTicket?.uuid
          ) {
            return;
          }

          const messages = this.createMessages(page);
          messages.reverse();
          chat.addMessages(messages, null, true);
        }
      );
    }
  }

  private fetchPreviousMessages() {
    const chat = this.chat;
    const contactChat = this;
    if (!chat || chat.fetching || contactChat.blockFetching) {
      return;
    }

    chat.fetching = true;
    if (this.currentContact) {
      const endpoint = this.getEndpoint();
      if (!endpoint) {
        // nothing to fetch — don't leave the chat wedged as fetching
        chat.fetching = false;
        return;
      }

      // initialize anchor UUID if not set (first fetch)
      if (!this.beforeUUID && !this.afterUUID) {
        // generate a UUID v7 for current time as the anchor
        const anchorUUID = generateUUIDv7();
        this.beforeUUID = anchorUUID;
        this.afterUUID = anchorUUID;
      }

      const requestedBefore = this.beforeUUID;
      fetchContactHistory(
        endpoint,
        this.currentTicket?.uuid,
        this.beforeUUID,
        null
      ).then((page: ContactHistoryPage) => {
        // the view was repositioned while this page was in flight (e.g. a
        // search navigated to a match and re-anchored the history) — drop
        // it rather than stacking the old view's messages on the new one
        if (this.beforeUUID !== requestedBefore) {
          chat.fetching = false;
          return;
        }

        const messages = this.createMessages(page);
        messages.reverse();

        if (messages.length === 0) {
          contactChat.blockFetching = true;
        } else if (page.next) {
          // update beforeUUID for next fetch of older messages
          this.beforeUUID = page.next;
        } else {
          // no more history, mark end and show oldest event date
          contactChat.blockFetching = true;
          if (page.events && page.events.length > 0) {
            const oldestEvent = page.events[page.events.length - 1];
            chat.setEndOfHistory(new Date(oldestEvent.created_on));
          }
        }

        chat.addMessages(messages);
      });
    }
  }

  private fetchComplete() {
    if (this.chat) {
      this.chat.fetching = false;
    }
    this.fetchingNewer = false;
  }

  private blockFetchingNewer = false;
  private fetchingNewer = false;

  private fetchNewerMessages() {
    if (
      !this.searchMode ||
      !this.afterUUID ||
      !this.chat ||
      this.fetchingNewer ||
      this.blockFetchingNewer
    ) {
      return;
    }

    this.fetchingNewer = true;
    const endpoint = this.getEndpoint();
    if (!endpoint) {
      this.fetchingNewer = false;
      return;
    }

    fetchContactHistory(
      endpoint,
      this.currentTicket?.uuid,
      null,
      this.afterUUID
    )
      .then((page: ContactHistoryPage) => {
        if (!this.chat) {
          this.fetchingNewer = false;
          return;
        }

        const messages = this.createMessages(page);
        messages.reverse();

        if (messages.length === 0) {
          this.blockFetchingNewer = true;
          this.fetchingNewer = false;
          return;
        }

        // maintainScroll=true keeps the user's visual position stable
        // so they must actively scroll down to trigger the next fetch
        // fetchingNewer is reset in fetchComplete after scroll settles
        this.chat.addMessages(messages, null, true, true);
      })
      .catch(() => {
        this.fetchingNewer = false;
      });
  }

  private getTembaCompose(): TemplateResult {
    if (this.currentTicket) {
      if (this.currentContact && this.currentContact.status !== 'active') {
        //no chatbox for archived, blocked, or stopped contacts
        return null;
      } else {
        if (!this.currentTicket.closed_on) {
          // hide compose if agent can't reply to unassigned tickets
          if (
            this.disableReply &&
            (!this.currentTicket.assignee ||
              this.currentTicket.assignee.email !== this.agent)
          ) {
            return null;
          }
          //chatbox for active contacts with an open ticket
          return this.getCompose();
        } else {
          return null;
        }
      }
    }

    if (this.currentContact && this.currentContact.status !== 'active') {
      //no chatbox for archived, blocked, or stopped contacts
      return null;
    } else {
      //chatbox for active contacts
      return this.getCompose();
    }
  }

  private getCompose(): TemplateResult {
    return html`<div class="chat-box">
      <div class="compose">
        <temba-compose
          attachments
          counter
          autogrow
          shortcuts
          min-height="75"
          @temba-submitted=${this.handleSend.bind(this)}
          @temba-content-changed=${this.handleComposeChanged.bind(this)}
        >
        </temba-compose>
        ${this.errorMessage
          ? html` <div class="error-gutter">
              <div class="error-message">${this.errorMessage}</div>
              ${this.errorRetryable
                ? html`<temba-button
                    name=${msg('Retry')}
                    @click=${this.handleRetry}
                  ></temba-button>`
                : null}
            </div>`
          : null}
      </div>
    </div>`;
  }

  private handleAssignmentChanged(evt: CustomEvent) {
    const picker = evt.currentTarget as UserPicker;
    this.assignTicket(picker.selected ? picker.selected.email : null);
  }

  private handleTopicChanged(evt: CustomEvent) {
    const select = evt.target as Select<any>;
    const topic = select.values[0];

    if (this.currentTicket.topic.uuid !== topic.uuid) {
      postJSON(`/api/v2/ticket_actions.json`, {
        tickets: [this.currentTicket.uuid],
        action: 'change_topic',
        topic: topic.uuid
      })
        .then(() => {
          this.refreshTicket();
        })
        .catch((response: any) => {
          console.error(response);
        });
    }
  }

  public assignTicket(email: string) {
    if (this.disableAssign) {
      return;
    }

    // if its already assigned to use, it's a noop
    if (
      (this.currentTicket.assignee &&
        this.currentTicket.assignee.email === email) ||
      (this.currentTicket.assignee === null && email === null)
    ) {
      return;
    }

    postJSON(`/api/v2/ticket_actions.json`, {
      tickets: [this.currentTicket.uuid],
      action: 'assign',
      assignee: email
    })
      .then(() => {
        this.refreshTicket();
      })
      .catch((response: any) => {
        console.error(response);
      });
    return true;
  }

  public refreshTicket() {
    if (this.currentTicket) {
      fetchResults(`/api/v2/tickets.json?uuid=${this.currentTicket.uuid}`).then(
        (values) => {
          if (values.length > 0) {
            this.fireCustomEvent(CustomEventType.TicketUpdated, {
              ticket: values[0],
              previous: this.currentTicket
            });
            this.currentTicket = values[0];
          }
        }
      );
    }
  }

  private handleReopen() {
    const uuid = this.currentTicket.uuid;
    postJSON(`/api/v2/ticket_actions.json`, {
      tickets: [uuid],
      action: 'reopen'
    })
      .then(() => {
        this.refreshTicket();
      })
      .catch((response: any) => {
        console.error(response);
      });
  }

  private handleClose() {
    const uuid = this.currentTicket.uuid;
    postJSON(`/api/v2/ticket_actions.json`, {
      tickets: [uuid],
      action: 'close'
    })
      .then(() => {
        this.refreshTicket();
      })
      .catch((response: any) => {
        console.error(response);
      });
  }

  /** The search bar rendered above the chat card while searching —
   * mirrors the list pages' searchbar: a bare input on a sunken strip
   * with an ↵-to-search hint + run icon while a draft is pending, and
   * a pager-style match stepper once results are in. */
  private renderSearchBar(): TemplateResult {
    const trimmed = this.searchQuery.trim();
    const pendingDraft = !!trimmed && trimmed !== this.lastSearchedQuery;
    return html`<div class="searchbar ${this.searchClosing ? 'closing' : ''}">
      <input
        class="search-input"
        type="text"
        placeholder="Search messages"
        aria-label="Search messages"
        .value=${this.searchQuery}
        @input=${this.handleSearchInput}
        @keydown=${this.handleSearchKeydown}
        @focus=${() => (this.searchFocused = true)}
        @blur=${() => (this.searchFocused = false)}
      />
      ${this.searchLoading
        ? html`<temba-loading size="8"></temba-loading>`
        : pendingDraft
          ? html`<span class="search-hint">
                <span class="enter-key">&#x21B5;</span> to search
              </span>
              <temba-icon
                class="search-go"
                name=${Icon.search}
                size="1.1"
                clickable
                title="Search"
                aria-label="Run search"
                @click=${() => this.executeSearch()}
              ></temba-icon>`
          : this.searchResults.length > 0
            ? html`<div class="match-pager">
                <span class="pager-status"
                  >${formatCount(this.searchIndex + 1)} of
                  ${formatCount(this.searchResults.length)}</span
                >
                <span
                  class="page-btn ${this.searchFocused &&
                  trimmed === this.lastSearchedQuery
                    ? 'enter-target'
                    : ''}"
                  @click=${this.handleSearchNext}
                  title="Older match (Enter)"
                  aria-label="Older match"
                >
                  <temba-icon name=${Icon.up} size="1"></temba-icon>
                </span>
                <span
                  class="page-btn"
                  @click=${this.handleSearchPrev}
                  title="Newer match (Shift+Enter)"
                  aria-label="Newer match"
                >
                  <temba-icon name=${Icon.down} size="1"></temba-icon>
                </span>
              </div>`
            : null}
      <temba-icon
        class="search-cancel"
        name=${Icon.close}
        size="1.1"
        clickable
        title="Close search (Escape)"
        aria-label="Close search"
        @click=${this.handleSearchClose}
      ></temba-icon>
    </div>`;
  }

  public render(): TemplateResult {
    const inFlow = this.currentContact && this.currentContact.flow;
    const lastSeen = this.getLastSeen();

    const inTicket = this.currentTicket;
    const ticketClosed = this.currentTicket && this.currentTicket.closed_on;

    return html`${this.currentContact && this.showSearch && this.searchMode
        ? this.renderSearchBar()
        : null}
      <div class="chat-wrapper ${inFlow ? 'in-flow' : ''}">
        ${this.currentContact
          ? html`<div class="chat-container">
                ${this.showSearch && !this.searchMode
                  ? html`<button
                      class="search-toggle"
                      @click=${this.handleSearchToggle}
                      title="Search messages"
                    >
                      <temba-icon name=${Icon.search} size="0.95"></temba-icon>
                      Search
                    </button>`
                  : null}
                <temba-chat
                  @temba-scroll-threshold=${this.fetchPreviousMessages}
                  @temba-scroll-threshold-bottom=${this.fetchNewerMessages}
                  @temba-fetch-complete=${this.fetchComplete}
                  avatar=${this.avatar}
                  contactName=${this.currentContact?.name ?? nothing}
                  contactUuid=${this.currentContact?.uuid ?? nothing}
                  agent
                  avatars
                  .showMessageLogsAfter=${this.showMessageLogsAfter}
                >
                </temba-chat>
                ${this.searchNoResults
                  ? html`<div class="search-no-results">
                      No results found for
                      <strong>${this.lastSearchedQuery}</strong>
                    </div>`
                  : null}
              </div>
              ${inTicket || inFlow || lastSeen
                ? html`<div class="status-area">
                    ${inTicket
                      ? html`<div class="ticket-controls">
                          <temba-user-picker
                            all-label=${msg('Unassigned')}
                            all-icon=${Icon.contact}
                            up
                            value=${this.currentTicket.assignee?.email || ''}
                            @change=${this.handleAssignmentChanged}
                            ?disabled=${ticketClosed || this.disableAssign}
                          ></temba-user-picker>

                          <temba-select
                            style="margin:0 0.5em; flex-grow:1"
                            endpoint="/api/v2/topics.json"
                            searchable
                            valuekey="uuid"
                            .values=${[this.currentTicket.topic]}
                            @change=${this.handleTopicChanged}
                            ?disabled=${ticketClosed}
                          ></temba-select>

                          ${this.currentTicket.closed_on
                            ? html`
                                <temba-button
                                  name=${msg('Reopen')}
                                  small
                                  @click=${this.handleReopen}
                                ></temba-button>
                              `
                            : html`
                                <temba-button
                                  name=${msg('Close')}
                                  destructive
                                  small
                                  @click=${this.handleClose}
                                ></temba-button>
                              `}
                        </div>`
                      : null}
                    ${inFlow || lastSeen
                      ? html`<div class="contact-status">
                          ${lastSeen
                            ? html`<div
                                class="last-seen"
                                title=${lastSeen.title}
                              >
                                ${msg(str`Last seen ${lastSeen.duration}`)}
                              </div>`
                            : null}
                          ${inFlow
                            ? html`<div class="current-flow">
                                <a
                                  class="flow-link"
                                  href="/flow/editor/${this.currentContact.flow
                                    .uuid}/"
                                  onclick="goto(event, this)"
                                  title=${this.currentContact.flow.name}
                                >
                                  <temba-icon name="flow"></temba-icon>
                                  <div class="flow-name">
                                    ${this.currentContact.flow.name}
                                  </div>
                                </a>
                                ${this.showInterrupt
                                  ? html`<temba-button
                                      small
                                      light
                                      name=${msg('Interrupt')}
                                      @click=${this.handleInterrupt}
                                    ></temba-button>`
                                  : null}
                              </div>`
                            : null}
                        </div>`
                      : null}
                  </div>`
                : null}
              ${this.getTembaCompose()}`
          : null}
      </div>`;
  }
}
export const closeTicket = (uuid: string): Promise<WebResponse> => {
  const formData = new FormData();
  formData.append('status', 'C');
  return postUrl(`/ticket/update/${uuid}/?_format=json`, formData);
};
export const fetchContact = (endpoint: string): Promise<Contact> => {
  return new Promise<Contact>((resolve, reject) => {
    fetchResults(endpoint).then((contacts: Contact[]) => {
      if (contacts && contacts.length === 1) {
        resolve(contacts[0]);
      } else {
        reject('No contact found');
      }
    });
  });
};
export const fetchContactHistory = (
  endpoint: string,
  ticket: string = undefined,
  before: string = undefined,
  after: string = undefined
): Promise<ContactHistoryPage> => {
  return new Promise<ContactHistoryPage>((resolve) => {
    const emptyPage: ContactHistoryPage = {
      events: [],
      next: null
    };
    const controller = new AbortController();
    pendingRequests.push(controller);
    const clearController = () => {
      pendingRequests = pendingRequests.filter(
        (pendingController: AbortController) => pendingController !== controller
      );
    };

    let url = endpoint;
    const params = [];

    if (before) {
      params.push(`before=${before}`);
    }

    if (after) {
      params.push(`after=${after}`);
    }

    if (ticket) {
      params.push(`ticket=${ticket}`);
    }

    if (params.length > 0) {
      url += (url.includes('?') ? '&' : '?') + params.join('&');
    }

    getUrl(url, controller)
      .then((response: WebResponse) => {
        clearController();
        const page = response.json as ContactHistoryPage;
        resolve(page || emptyPage);
      })
      .catch(() => {
        clearController();
        resolve(emptyPage);
      });
  });
};
export const getDisplayName = (user: User) => {
  if (!user) {
    return 'Somebody';
  }

  if ((user as NamedUser).name) {
    return (user as NamedUser).name;
  }

  if (user.first_name && user.last_name) {
    return `${user.first_name} ${user.last_name}`;
  }

  if (user.first_name) {
    return user.first_name;
  }

  return user.email;
};
export let pendingRequests: AbortController[] = [];
