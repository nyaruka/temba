import {
  LitElement,
  PropertyValueMap,
  TemplateResult,
  css,
  html,
  nothing
} from 'lit';
import { property } from 'lit/decorators.js';
import { msg } from '@lit/localize';
import { Centrifuge } from 'centrifuge';
import { getCookie, setCookie } from '../utils';
import { Chat, MsgEvent } from '../display/Chat';
import { QuickReply } from '../interfaces';
import {
  ConnectionState,
  SocketManager,
  SocketProvider,
  SocketSubscription,
  getSocketConnectionState,
  onSocketConnectionState,
  onSocketDenied,
  publishToSocket,
  recheckSocket,
  subscribeToSocket
} from '../live/SocketService';

/**
 * The webchat widget - a website visitor's side of a conversation on a
 * WebChat channel.
 *
 * The conversation is owned by courier, which serves the channel's public
 * endpoints under /c/wch/<channel-uuid>/ on the platform host:
 *
 *   POST start    - mints a chat id and creates the contact behind it
 *   POST receive  - a message from the visitor: {chat_id, text, attachments}
 *   GET  history  - a page of the conversation, newest first: ?chat_id&before
 *   POST upload   - a file to attach to a later message: multipart chat_id, file
 *
 * Outgoing messages - from flows and agents - reach the visitor live over the
 * realtime socket chat:<channel-uuid>:<chat-id>, which the platform's subscribe
 * proxy authorizes by possession of the chat id alone. The id is the visitor's
 * only credential, so it's kept in a cookie on the embedding site and never
 * displayed. Publishes are dropped while the visitor doesn't have the socket
 * open, so on every resubscribe the widget fetches the latest history page to
 * recover anything it missed.
 *
 * The `host` attribute is the platform host (e.g. https://app.textit.com); it
 * defaults to the embedding page's own origin, which is what the demo page and
 * the platform's own pages want.
 */

// the visitor's chat id for a channel is remembered on the embedding site
const CHAT_COOKIE_PREFIX = 'temba-chat-';

// what courier's receive endpoint accepts on a single message
const MAX_ATTACHMENTS = 10;

/**
 * A message as the chat sees it - published to the chat socket for each
 * outgoing message and returned by the history endpoint for both directions.
 */
export interface ChatMsgEvent {
  type: 'msg_in' | 'msg_out';
  created_on: string;
  msg_uuid: string;
  text: string;
  attachments?: string[];
  quick_replies?: QuickReply[];
  // who sent a reply, when it was a user rather than a flow
  user?: { uuid: string; name: string; avatar?: string };
}

interface HistoryResponse {
  events: ChatMsgEvent[];
  // the cursor to the page before this one, absent on the last page
  next?: string;
}

interface WebResult {
  status: number;
  json: any;
}

// the visitor's own messages are the contact's (msg_received) and everything
// sent to them is a reply (msg_created), which is how temba-chat sides them.
// A reply sent by a user shows them by name and avatar, as the app does; one
// from a flow gets the widget's avatar when it has one and the chat's default
// otherwise.
const toMsgEvent = (event: ChatMsgEvent, avatar?: string): MsgEvent => {
  const reply = event.type === 'msg_out';
  let user = undefined;
  if (reply && event.user) {
    user = { ...event.user, email: '' };
  } else if (reply && avatar) {
    user = { uuid: '', name: '', email: '', avatar };
  }
  return {
    uuid: event.msg_uuid,
    type: reply ? 'msg_created' : 'msg_received',
    created_on: new Date(event.created_on),
    _user: user,
    msg: {
      text: event.text,
      attachments: event.attachments || [],
      quick_replies: event.quick_replies || [],
      channel: undefined,
      urn: '',
      direction: event.type === 'msg_in' ? 'in' : 'out',
      type: 'text'
    }
  };
};

// the widget only offers text quick replies, which is all courier sends it
const quickRepliesOf = (event: ChatMsgEvent): string[] => {
  if (!event || event.type !== 'msg_out') {
    return [];
  }
  return (event.quick_replies || [])
    .filter((reply) => (!reply.type || reply.type === 'text') && reply.text)
    .map((reply) => reply.text);
};

// an attachment is content-type:url, shown by its file name and type
const attachmentParts = (attachment: string) => {
  const idx = attachment.indexOf(':');
  const contentType = idx > 0 ? attachment.substring(0, idx) : '';
  const url = idx > 0 ? attachment.substring(idx + 1) : attachment;
  const name = decodeURIComponent(url.split('?')[0].split('/').pop() || '');
  let icon = 'attachment';
  if (contentType.startsWith('image/')) {
    icon = 'attachment_image';
  } else if (contentType.startsWith('audio/')) {
    icon = 'attachment_audio';
  } else if (contentType.startsWith('video/')) {
    icon = 'attachment_video';
  } else if (contentType) {
    icon = 'attachment_document';
  }
  return { contentType, url, name, icon };
};

export class WebChat extends LitElement {
  static get styles() {
    return css`
      :host {
        /* the accent is themeable: a page can hand the widget its own, else it
           follows the app's chat blue where the theme provides it */
        --color-primary: var(--webchat-primary, var(--color-message, #3c92dd));
        --curvature: 0.6em;
        --webchat-ink: #1f2430;
        --webchat-muted: #6b7280;
        --webchat-surface: #ffffff;
        --webchat-footer: #f4f6f9;
        --webchat-line: rgba(31, 36, 48, 0.08);
        --webchat-online: #22c55e;
        --webchat-away: #f59e0b;
        --webchat-offline: #9ca3af;
        --webchat-width: 24rem;
        --webchat-height: 38rem;
        --toggle-speed: 180ms;
        --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);

        display: block;
        position: fixed;
        right: 0;
        bottom: 0;
        z-index: 10000;
        font-family: var(
          --font-family,
          'Inter',
          system-ui,
          -apple-system,
          'Segoe UI',
          Roboto,
          sans-serif
        );
        font-size: var(--font-size, 14px);
        font-weight: 400;
        color: var(--webchat-ink);
        line-height: 1.4;
      }

      button {
        font: inherit;
      }

      /* the launcher: a disc in the accent that the panel grows out of */
      .launcher {
        position: absolute;
        right: 1.25rem;
        bottom: 1.25rem;
        width: 3.5rem;
        height: 3.5rem;
        border-radius: 50%;
        border: 0;
        padding: 0;
        background: var(--color-primary);
        color: #fff;
        cursor: pointer;
        display: grid;
        place-items: center;
        box-shadow:
          0 10px 30px color-mix(in srgb, var(--color-primary) 35%, transparent),
          0 2px 6px rgba(16, 24, 40, 0.18);
        transition:
          transform var(--toggle-speed) var(--ease-out),
          box-shadow var(--toggle-speed) var(--ease-out);
      }

      .launcher:hover {
        transform: translateY(-2px);
        box-shadow:
          0 14px 34px color-mix(in srgb, var(--color-primary) 40%, transparent),
          0 3px 8px rgba(16, 24, 40, 0.2);
      }

      .launcher:focus-visible,
      .close:focus-visible,
      .icon-button:focus-visible,
      .quick-reply:focus-visible,
      .link:focus-visible {
        outline: 3px solid color-mix(in srgb, var(--color-primary) 40%, white);
        outline-offset: 2px;
      }

      .launcher.with-avatar {
        background-size: cover;
        background-position: center;
      }

      .open .launcher.with-avatar {
        background-image: none !important;
      }

      .launcher .glyph {
        grid-area: 1 / 1;
        transition:
          opacity var(--toggle-speed) var(--ease-out),
          transform var(--toggle-speed) var(--ease-out);
      }

      .launcher .glyph.chat-glyph {
        opacity: 1;
        transform: none;
      }

      .launcher.with-avatar .glyph.chat-glyph {
        opacity: 0;
      }

      .launcher .glyph.close-glyph {
        opacity: 0;
        transform: rotate(-90deg) scale(0.5);
      }

      .open .launcher .glyph.chat-glyph {
        opacity: 0;
        transform: rotate(90deg) scale(0.5);
      }

      .open .launcher .glyph.close-glyph {
        opacity: 1;
        transform: none;
      }

      .badge {
        position: absolute;
        top: -0.25rem;
        right: -0.25rem;
        min-width: 1.4rem;
        height: 1.4rem;
        padding: 0 0.3rem;
        border-radius: 999px;
        background: #ef4444;
        color: #fff;
        font-size: 0.8em;
        font-weight: 600;
        line-height: 1;
        display: grid;
        place-items: center;
        border: 2px solid #fff;
        box-sizing: border-box;
      }

      /* the panel */
      .panel {
        position: absolute;
        right: 1.25rem;
        bottom: 5.5rem;
        width: var(--webchat-width);
        height: var(--webchat-height);
        max-width: calc(100vw - 2.5rem);
        max-height: calc(100vh - 7rem);
        display: flex;
        flex-direction: column;
        background: var(--webchat-surface);
        border-radius: 18px;
        overflow: hidden;
        box-shadow:
          0 24px 60px rgba(16, 24, 40, 0.18),
          0 2px 8px rgba(16, 24, 40, 0.08);
        transform-origin: bottom right;
        transform: scale(0.92) translateY(0.5rem);
        opacity: 0;
        pointer-events: none;
        transition:
          transform var(--toggle-speed) var(--ease-out),
          opacity var(--toggle-speed) ease;
      }

      .open .panel {
        transform: none;
        opacity: 1;
        pointer-events: auto;
      }

      @media (max-width: 480px) {
        .panel {
          right: 0;
          bottom: 0;
          width: 100vw;
          height: 100dvh;
          max-width: none;
          max-height: none;
          border-radius: 0;
        }

        .open .launcher {
          display: none;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .launcher,
        .launcher .glyph,
        .panel,
        .send {
          transition: none;
        }
      }

      /* the header says who you're talking to and whether you're connected */
      .header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.85rem 0.85rem 0.85rem 1rem;
        border-bottom: 1px solid var(--webchat-line);
      }

      .identity {
        width: 2.5rem;
        height: 2.5rem;
        flex-shrink: 0;
        border-radius: 50%;
        background: color-mix(in srgb, var(--color-primary) 14%, white);
        color: var(--color-primary);
        display: grid;
        place-items: center;
        background-size: cover;
        background-position: center;
      }

      .titles {
        flex: 1;
        min-width: 0;
      }

      .title {
        font-weight: 600;
        font-size: 1.05em;
        line-height: 1.25;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .presence {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        margin-top: 0.15rem;
        font-size: 0.85em;
        color: var(--webchat-muted);
      }

      .presence .dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        background: var(--webchat-online);
      }

      .presence.connecting .dot {
        background: var(--webchat-away);
      }

      .presence.disconnected .dot {
        background: var(--webchat-offline);
      }

      .close,
      .icon-button {
        width: 2.1rem;
        height: 2.1rem;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: var(--webchat-muted);
        cursor: pointer;
        display: grid;
        place-items: center;
        flex-shrink: 0;
        transition:
          background var(--toggle-speed) ease,
          color var(--toggle-speed) ease;
      }

      .close:hover,
      .icon-button:hover:not(:disabled) {
        background: var(--webchat-footer);
        color: var(--webchat-ink);
      }

      .icon-button:disabled {
        opacity: 0.5;
        cursor: default;
      }

      /* the conversation */
      .body {
        position: relative;
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }

      temba-chat {
        flex-grow: 1;
        min-height: 0;
        --color-chat-out: var(--color-primary);
        --chat-top-padding: 1em;
        --chat-bottom-padding: 1em;
      }

      .empty {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        padding: 2rem;
        text-align: center;
        color: var(--webchat-muted);
        pointer-events: none;
      }

      .empty .identity {
        width: 3.25rem;
        height: 3.25rem;
      }

      .banner {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        font-size: 0.9em;
      }

      .banner.error {
        background: #fef2f2;
        color: #b42318;
      }

      .banner.offline {
        background: var(--webchat-footer);
        color: var(--webchat-muted);
      }

      .link {
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--color-primary);
        text-decoration: underline;
        cursor: pointer;
      }

      /* the composer */
      .footer {
        background: var(--webchat-footer);
        border-top: 1px solid var(--webchat-line);
        padding: 0.65rem 0.75rem 0.75rem;
      }

      .quick-replies {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 0.4rem;
        padding: 0 0.25rem 0.6rem;
      }

      .quick-reply {
        padding: 0.35rem 0.85rem;
        border-radius: 999px;
        border: 1px solid var(--color-primary);
        background: var(--webchat-surface);
        color: var(--color-primary);
        font-size: 0.9em;
        cursor: pointer;
        transition:
          background var(--toggle-speed) ease,
          color var(--toggle-speed) ease;
      }

      .quick-reply:hover:not(:disabled) {
        background: var(--color-primary);
        color: #fff;
      }

      .quick-reply:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .attachments {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        padding: 0 0.25rem 0.6rem;
      }

      .attachment {
        display: flex;
        align-items: center;
        gap: 0.4em;
        max-width: 100%;
        padding: 0.3em 0.5em 0.3em 0.7em;
        border-radius: 999px;
        background: var(--webchat-surface);
        border: 1px solid var(--webchat-line);
        color: var(--webchat-ink);
        font-size: 0.85em;
      }

      .attachment .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 12em;
      }

      .attachment .remove {
        color: var(--webchat-muted);
        cursor: pointer;
      }

      .attachment .remove:hover {
        color: var(--webchat-ink);
      }

      .composer {
        display: flex;
        align-items: center;
        gap: 0.15rem;
        background: var(--webchat-surface);
        border: 1px solid var(--webchat-line);
        border-radius: 999px;
        padding: 0.2rem 0.25rem 0.2rem 0.35rem;
        box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
        transition:
          border-color var(--toggle-speed) ease,
          box-shadow var(--toggle-speed) ease;
      }

      .composer:focus-within {
        border-color: color-mix(in srgb, var(--color-primary) 55%, white);
        box-shadow: 0 0 0 3px
          color-mix(in srgb, var(--color-primary) 18%, transparent);
      }

      /* inputs don't inherit the page font by default, and a browser's own
         UI font differs between environments */
      .input {
        flex: 1;
        min-width: 0;
        border: 0;
        background: transparent;
        font: inherit;
        color: var(--webchat-ink);
        padding: 0.5rem 0.25rem;
      }

      .input:focus {
        outline: none;
      }

      .input::placeholder {
        color: var(--webchat-muted);
        opacity: 0.8;
      }

      .input:disabled {
        background: transparent !important;
      }

      .file-input {
        display: none;
      }

      /* the send button wakes up when there's something to send */
      .send {
        background: var(--webchat-line);
        color: #fff;
        transform: scale(0.9);
        transition:
          background var(--toggle-speed) ease,
          transform var(--toggle-speed) var(--ease-out);
      }

      .pending .send {
        background: var(--color-primary);
        transform: none;
      }

      .pending .send:hover:not(:disabled) {
        background: color-mix(in srgb, var(--color-primary) 88%, black);
        color: #fff;
      }
    `;
  }

  // the uuid of the WebChat channel this widget chats on
  @property({ type: String })
  channel: string;

  // the platform host, e.g. https://app.textit.com - defaults to the
  // embedding page's origin
  @property({ type: String })
  host: string;

  // the visitor's chat on the channel, remembered in a cookie once started
  @property({ type: String, attribute: 'chat-id' })
  chatId: string;

  // is the chat widget open
  @property({ type: Boolean })
  open = false;

  // where the realtime connection is, once we've asked for one
  @property({ type: String })
  status: ConnectionState = ConnectionState.Disconnected;

  @property({ type: Boolean })
  hasPendingText = false;

  @property({ type: String })
  activeUserAvatar: string;

  // the text quick replies offered by the latest message to the visitor
  @property({ type: Array, attribute: false })
  quickReplies: string[] = [];

  // uploaded files waiting to go out with the next message
  @property({ type: Array, attribute: false })
  attachments: string[] = [];

  // replies that arrived while the panel was closed, shown on the launcher
  @property({ type: Number, attribute: false })
  unread = 0;

  // whether the conversation has anything in it yet
  @property({ type: Boolean, attribute: false })
  hasMessages = false;

  @property({ type: Boolean, attribute: false })
  sending = false;

  @property({ type: Boolean, attribute: false })
  uploading = false;

  // what last went wrong, shown until the next thing succeeds
  @property({ type: String, attribute: false })
  error: string = null;

  @property({ type: Boolean, attribute: false })
  blockHistoryFetching = false;

  private chat: Chat;
  private sockets: SocketProvider;

  // the connection of our own we open when the platform is another origin,
  // which we close again when we're done with it
  private ownSockets: SocketManager;
  private subscription: SocketSubscription;
  private connectionWatch: SocketSubscription;
  private connecting = false;
  private subscribedOnce = false;
  private fetchRequested: Date;

  // paging back through history: the cursor to the page before the oldest
  // one we have, and whether there is one
  private nextCursor: string = null;
  private endOfHistory = false;

  public firstUpdated(
    changed: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ): void {
    super.firstUpdated(changed);
    this.chat = this.shadowRoot.querySelector('temba-chat');

    // attachments open in a lightbox, which the embedding page won't have
    if (!document.querySelector('temba-lightbox')) {
      const lightbox = document.createElement('temba-lightbox');
      document.querySelector('body').appendChild(lightbox);
    }
  }

  public connectedCallback(): void {
    super.connectedCallback();

    // re-attached while open, so pick the conversation back up
    if (this.chat && this.open && !this.subscription) {
      this.connect();
    }
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this.teardown();
  }

  public updated(
    changed: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ): void {
    super.updated(changed);

    if (changed.has('open') && this.open) {
      this.unread = 0;
      if (!this.subscription) {
        this.connect();
      }
    }

    if (changed.has('status') && this.status === ConnectionState.Connected) {
      this.focusInput();
    }
  }

  /**
   * The platform host the widget talks to, without a trailing slash
   */
  private baseUrl(): string {
    let host = (this.host || '').trim();
    if (!host) {
      return window.location.origin;
    }
    if (!/^https?:\/\//i.test(host)) {
      host = `https://${host}`;
    }
    return host.replace(/\/+$/, '');
  }

  private endpoint(action: string, params: { [key: string]: string } = {}) {
    const url = new URL(`${this.baseUrl()}/c/wch/${this.channel}/${action}`);
    Object.keys(params).forEach((key) =>
      url.searchParams.set(key, params[key])
    );
    return url.toString();
  }

  // the widget runs on third-party sites, so these are plain cross-origin
  // requests: no cookies, and no headers beyond what courier's CORS preflight
  // allows
  private async request(url: string, init: RequestInit): Promise<WebResult> {
    const response = await fetch(url, init);
    let json: any = null;
    try {
      json = await response.json();
    } catch (err) {
      json = null;
    }
    return { status: response.status, json };
  }

  private getJSON(action: string, params: { [key: string]: string } = {}) {
    return this.request(this.endpoint(action, params), { method: 'GET' });
  }

  private postJSON(action: string, payload: any) {
    return this.request(this.endpoint(action), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  private postForm(action: string, form: FormData) {
    return this.request(this.endpoint(action), { method: 'POST', body: form });
  }

  private cookieName(): string {
    return `${CHAT_COOKIE_PREFIX}${this.channel}`;
  }

  private socketName(): string {
    return `chat:${this.channel}:${this.chatId}`;
  }

  /**
   * Opens a realtime connection of our own to the given websocket url - for
   * a platform on another origin, which the page's shared connection can't
   * reach. Exposed so tests can stand in a mock for it.
   */
  public createSocketManager(url: string): SocketManager {
    return new SocketManager(() => {
      const socket = new Centrifuge(url);
      socket.connect();
      return socket;
    });
  }

  /**
   * The realtime connection: the page's shared one when the platform is our
   * own origin, otherwise a connection of our own to the platform host.
   */
  private getSockets(): SocketProvider {
    if (!this.sockets) {
      const base = this.baseUrl();
      if (base !== window.location.origin) {
        const url = `${base.replace(/^http/i, 'ws')}/ws/connect`;
        this.ownSockets = this.createSocketManager(url);
        this.sockets = this.ownSockets;
      } else {
        this.sockets = {
          subscribe: subscribeToSocket,
          publish: publishToSocket,
          getConnectionState: getSocketConnectionState,
          onConnectionState: onSocketConnectionState,
          onDenied: onSocketDenied,
          recheck: recheckSocket
        };
      }
    }
    return this.sockets;
  }

  /**
   * Resumes the visitor's chat on the channel if they have one, otherwise
   * starts a new one, then subscribes to it.
   */
  public async connect(): Promise<void> {
    if (this.connecting || this.subscription || !this.channel) {
      return;
    }

    this.connecting = true;
    this.status = ConnectionState.Connecting;
    this.error = null;

    try {
      if (!this.chatId) {
        this.chatId = getCookie(this.cookieName());
      }

      // fetching an existing chat's history both validates the chat id and
      // gives us the conversation so far
      if (this.chatId && !(await this.loadHistory())) {
        this.chatId = null;
      }

      if (!this.chatId) {
        const { status, json } = await this.postJSON('start', {});
        if (status !== 200 || !json?.chat_id) {
          throw new Error(`unable to start chat: ${status}`);
        }
        this.chatId = json.chat_id;
        this.chat.reset();
        this.hasMessages = false;
        this.nextCursor = null;
        this.endOfHistory = true;
        this.quickReplies = [];
      }

      setCookie(this.cookieName(), this.chatId);
      this.subscribe();
    } catch (err) {
      this.status = ConnectionState.Disconnected;
      this.error = msg('Unable to connect to chat');
    } finally {
      this.connecting = false;
    }
  }

  private subscribe(): void {
    const sockets = this.getSockets();
    this.connectionWatch = sockets.onConnectionState((state) => {
      this.status = state;
    });
    this.subscription = sockets.subscribe(
      this.socketName(),
      (data: ChatMsgEvent) => this.handlePublication(data),
      () => this.handleSubscribed()
    );
  }

  private teardown(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
    if (this.connectionWatch) {
      this.connectionWatch.unsubscribe();
      this.connectionWatch = null;
    }
    if (this.ownSockets) {
      this.ownSockets.disconnect();
      this.ownSockets = null;
      this.sockets = null;
    }
    this.subscribedOnce = false;
  }

  private handleReconnect(): void {
    this.teardown();
    this.connect();
  }

  private handlePublication(event: ChatMsgEvent): void {
    if (!event || event.type !== 'msg_out') {
      return;
    }
    this.chat.addMessages(
      [toMsgEvent(event, this.activeUserAvatar)],
      null,
      true
    );
    this.hasMessages = true;
    if (!this.open) {
      this.unread++;
    }
    this.quickReplies = quickRepliesOf(event);
  }

  private handleSubscribed(): void {
    // the first subscribe follows our initial history load, but a resubscribe
    // means the connection dropped and publishes were lost while it was down
    if (!this.subscribedOnce) {
      this.subscribedOnce = true;
      return;
    }

    this.fetchHistory()
      .then((page) => {
        if (page) {
          const events = [...page.events].reverse();

          // replies we haven't shown yet count as unread like live ones do
          const missed = events.filter(
            (e) =>
              e.type === 'msg_out' &&
              !this.chat.messageExists({ uuid: e.msg_uuid } as MsgEvent)
          );
          if (!this.open) {
            this.unread += missed.length;
          }

          this.chat.addMessages(
            events.map((e) => toMsgEvent(e, this.activeUserAvatar)),
            null,
            true
          );
          this.hasMessages = this.hasMessages || events.length > 0;
          this.quickReplies = quickRepliesOf(page.events[0]);
        }
      })
      .catch(() => {
        // the socket is back either way, and the next publish is live
      });
  }

  /**
   * Fetches a page of history, newest first, before the given message. Null
   * means the chat id is no longer valid.
   */
  private async fetchHistory(before?: string): Promise<HistoryResponse> {
    const params = { chat_id: this.chatId };
    if (before) {
      params['before'] = before;
    }
    const { status, json } = await this.getJSON('history', params);
    if (status === 400) {
      return null;
    }
    if (status !== 200) {
      throw new Error(`error fetching history: ${status}`);
    }
    return { events: json?.events || [], next: json?.next };
  }

  private async loadHistory(): Promise<boolean> {
    const page = await this.fetchHistory();
    if (!page) {
      return false;
    }

    this.chat.reset();
    const events = [...page.events].reverse();
    this.chat.addMessages(
      events.map((e) => toMsgEvent(e, this.activeUserAvatar))
    );
    this.hasMessages = events.length > 0;
    this.setCursor(page, events);
    this.quickReplies = quickRepliesOf(page.events[0]);
    return true;
  }

  private setCursor(page: HistoryResponse, events: ChatMsgEvent[]): void {
    this.nextCursor = page.next || null;
    this.endOfHistory = !page.next;
    if (this.endOfHistory && events.length > 0) {
      this.chat.setEndOfHistory(new Date(events[0].created_on));
    }
  }

  public fetchPreviousMessages(): void {
    if (
      this.blockHistoryFetching ||
      this.endOfHistory ||
      !this.nextCursor ||
      !this.chatId
    ) {
      return;
    }

    this.blockHistoryFetching = true;
    this.chat.fetching = true;
    this.fetchRequested = new Date();

    this.fetchHistory(this.nextCursor)
      .then((page) => {
        if (!page) {
          this.chat.fetching = false;
          this.blockHistoryFetching = false;
          return;
        }
        const events = [...page.events].reverse();
        this.setCursor(page, events);
        this.chat.addMessages(
          events.map((e) => toMsgEvent(e, this.activeUserAvatar)),
          this.fetchRequested
        );
      })
      .catch(() => {
        this.chat.fetching = false;
        this.blockHistoryFetching = false;
      });
  }

  public fetchComplete(): void {
    this.blockHistoryFetching = false;
  }

  private focusInput(): void {
    const input = this.shadowRoot.querySelector('.input') as HTMLInputElement;
    if (input) {
      input.focus();
    }
  }

  public openChat(): void {
    this.open = true;
  }

  private toggleChat(): void {
    this.open = !this.open;
  }

  public handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.sendPendingMessage();
    }
  }

  public handleInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.hasPendingText = input.value.trim().length > 0;
  }

  private handleClickInputPanel(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.focusInput();
  }

  private async sendPendingMessage(): Promise<void> {
    const input = this.shadowRoot.querySelector('.input') as HTMLInputElement;
    const text = (input?.value || '').trim();
    const attachments = [...this.attachments];

    if (this.sending || (!text && attachments.length === 0)) {
      return;
    }

    if (input) {
      input.value = '';
    }
    this.hasPendingText = false;
    this.attachments = [];

    const sent = await this.sendMessage(text, attachments);
    if (!sent) {
      // give them back what they wrote
      if (input && !input.value) {
        input.value = text;
        this.hasPendingText = text.length > 0;
      }
      this.attachments = [...attachments, ...this.attachments];
    }

    // either way they're still typing to us
    await this.updateComplete;
    this.focusInput();
  }

  /**
   * Sends a message from the visitor. Their own messages aren't echoed over
   * the socket, so it's added to the chat from the response, which carries
   * the uuid the platform gave it.
   */
  public async sendMessage(
    text: string,
    attachments: string[] = []
  ): Promise<boolean> {
    if (!this.chatId || this.sending) {
      return false;
    }

    this.sending = true;
    this.error = null;

    try {
      const { status, json } = await this.postJSON('receive', {
        chat_id: this.chatId,
        text,
        attachments
      });
      // courier answers an accepted message with its uuid - one it refused
      // (e.g. a workspace at its contact limit) comes back accepted-looking
      // but with nothing in data
      const uuid = json?.data?.[0]?.msg_uuid;
      if (status !== 200 || !uuid) {
        throw new Error(`error sending message: ${status}`);
      }

      this.chat.addMessages(
        [
          {
            uuid,
            type: 'msg_received',
            created_on: new Date(),
            msg: {
              text,
              attachments,
              quick_replies: [],
              channel: undefined,
              urn: '',
              direction: 'in',
              type: 'text'
            }
          } as MsgEvent
        ],
        null,
        true
      );

      // a reply spends the quick replies that prompted it
      this.quickReplies = [];
      this.hasMessages = true;
      return true;
    } catch (err) {
      this.error = msg('Your message could not be sent');
      return false;
    } finally {
      this.sending = false;
    }
  }

  private handleQuickReply(text: string): void {
    this.sendMessage(text);
  }

  private handleAttachClick(event: MouseEvent): void {
    event.stopPropagation();
    const input = this.shadowRoot.querySelector(
      '.file-input'
    ) as HTMLInputElement;
    if (input) {
      input.click();
    }
  }

  private handleFilesChanged(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    this.uploadFiles(files);
  }

  /**
   * Uploads files to attach to the visitor's next message
   */
  public async uploadFiles(files: File[]): Promise<void> {
    if (!this.chatId || files.length === 0 || this.uploading) {
      return;
    }

    this.uploading = true;
    this.error = null;

    try {
      for (const file of files) {
        if (this.attachments.length >= MAX_ATTACHMENTS) {
          this.error = msg('Too many attachments');
          break;
        }

        const form = new FormData();
        form.append('chat_id', this.chatId);
        form.append('file', file);

        const { status, json } = await this.postForm('upload', form);
        if (status === 200 && json?.attachment) {
          this.attachments = [...this.attachments, json.attachment];
        } else if (status === 413) {
          this.error = msg('File is too large');
        } else if (status === 400) {
          this.error = msg('File type not supported');
        } else {
          this.error = msg('Unable to upload file');
        }
      }
    } catch (err) {
      this.error = msg('Unable to upload file');
    } finally {
      this.uploading = false;
    }
  }

  private removeAttachment(attachment: string): void {
    this.attachments = this.attachments.filter((a) => a !== attachment);
  }

  private renderAttachments(): TemplateResult {
    if (this.attachments.length === 0) {
      return null;
    }
    return html`<div class="attachments">
      ${this.attachments.map((attachment) => {
        const parts = attachmentParts(attachment);
        return html`<div class="attachment" title=${parts.name}>
          <temba-icon name=${parts.icon} size="1"></temba-icon>
          <div class="name">${parts.name}</div>
          <temba-icon
            class="remove"
            name="close"
            size="1"
            clickable
            @click=${() => this.removeAttachment(attachment)}
          ></temba-icon>
        </div>`;
      })}
    </div>`;
  }

  private renderQuickReplies(): TemplateResult {
    if (this.quickReplies.length === 0) {
      return null;
    }
    return html`<div class="quick-replies">
      ${this.quickReplies.map(
        (reply) =>
          html`<button
            class="quick-reply"
            ?disabled=${this.sending}
            @click=${() => this.handleQuickReply(reply)}
          >
            ${reply}
          </button>`
      )}
    </div>`;
  }

  private renderPresence(): TemplateResult {
    let label = msg('Connected');
    if (this.status === ConnectionState.Connecting) {
      label = msg('Connecting');
    } else if (this.status === ConnectionState.Disconnected) {
      label = msg('Offline');
    }
    return html`<div class="presence ${this.status}">
      <span class="dot"></span>${label}
    </div>`;
  }

  private renderIdentity(): TemplateResult {
    const avatar = this.activeUserAvatar;
    return html`<div
      class="identity"
      style=${avatar ? `background-image:url(${avatar})` : nothing}
    >
      ${avatar
        ? null
        : html`<temba-icon name="webchat" size="1.35"></temba-icon>`}
    </div>`;
  }

  private renderBanners(): TemplateResult {
    return html`${this.error
      ? html`<div class="banner error">${this.error}</div>`
      : null}
    ${this.status === ConnectionState.Disconnected
      ? html`<div class="banner offline">
          <span>${msg('The chat is not connected.')}</span>
          <button class="link reconnect" @click=${this.handleReconnect}>
            ${msg('Reconnect')}
          </button>
        </div>`
      : null}`;
  }

  private renderFooter(): TemplateResult {
    const connected = this.status === ConnectionState.Connected;
    const pending = this.hasPendingText || this.attachments.length > 0;
    return html`<div class="footer">
      ${this.renderQuickReplies()} ${this.renderAttachments()}
      <div
        class="composer ${pending ? 'pending' : ''} ${this.uploading
          ? 'uploading'
          : ''}"
        @click=${this.handleClickInputPanel}
      >
        <input
          class="file-input"
          type="file"
          multiple
          accept="image/*,audio/*,video/*,application/pdf"
          @change=${this.handleFilesChanged}
        />
        <button
          class="icon-button attach"
          aria-label=${msg('Add an attachment')}
          ?disabled=${!connected || this.uploading}
          @click=${this.handleAttachClick}
        >
          <temba-icon
            name=${this.uploading ? 'progress_spinner' : 'attachment'}
            size="1.15"
            ?spin=${this.uploading}
          ></temba-icon>
        </button>
        <input
          class="input"
          type="text"
          placeholder=${msg('Write a message')}
          aria-label=${msg('Message')}
          ?disabled=${!connected}
          @input=${this.handleInput}
          @keydown=${this.handleKeyDown}
        />
        <button
          class="icon-button send"
          aria-label=${msg('Send')}
          ?disabled=${!connected || !pending || this.sending}
          @click=${this.sendPendingMessage}
        >
          <temba-icon name="send" size="1.05"></temba-icon>
        </button>
      </div>
    </div>`;
  }

  public render(): TemplateResult {
    const avatar = this.activeUserAvatar;
    return html`
      <div class="widget ${this.open ? 'open' : ''}">
        <section
          class="panel"
          role="dialog"
          aria-label=${msg('Chat')}
          aria-hidden=${this.open ? 'false' : 'true'}
        >
          <header class="header">
            ${this.renderIdentity()}
            <div class="titles">
              <div class="title"><slot name="header">${msg('Chat')}</slot></div>
              ${this.renderPresence()}
            </div>
            <button
              class="close"
              aria-label=${msg('Close chat')}
              @click=${this.toggleChat}
            >
              <temba-icon name="close" size="1.2"></temba-icon>
            </button>
          </header>

          <div class="body">
            <temba-chat
              avatars
              .showTimestamps=${false}
              @temba-scroll-threshold=${this.fetchPreviousMessages}
              @temba-fetch-complete=${this.fetchComplete}
            ></temba-chat>
            ${!this.hasMessages && this.status === ConnectionState.Connected
              ? html`<div class="empty">
                  ${this.renderIdentity()}
                  <div>${msg("Send a message and we'll reply here.")}</div>
                </div>`
              : null}
          </div>

          ${this.renderBanners()} ${this.renderFooter()}
        </section>

        <button
          class="launcher ${avatar ? 'with-avatar' : ''}"
          aria-label=${this.open ? msg('Close chat') : msg('Open chat')}
          style=${avatar ? `background-image:url(${avatar})` : nothing}
          @click=${this.toggleChat}
        >
          <temba-icon
            class="glyph chat-glyph"
            name="webchat"
            size="1.6"
          ></temba-icon>
          <temba-icon
            class="glyph close-glyph"
            name="close"
            size="1.4"
          ></temba-icon>
          ${this.unread > 0 && !this.open
            ? html`<span class="badge">${this.unread}</span>`
            : null}
        </button>
      </div>
    `;
  }
}
