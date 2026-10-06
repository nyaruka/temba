import { css, html, PropertyValues, TemplateResult } from 'lit';
import { msg, str } from '@lit/localize';
import { TembaList } from './TembaList';
import { Options } from '../display/Options';
import { Icon } from '../Icons';
import { CustomEventType, Notification } from '../interfaces';
import {
  RealtimeSubscription,
  subscribeToNotifications
} from '../live/Realtime';
import { deleteRequest, formatCount } from '../utils';

export class NotificationList extends TembaList {
  reverseRefresh = false;

  // fed by socket publications instead of interval polling
  protected pollingEnabled = false;

  private realtimeSubscription: RealtimeSubscription = null;

  // publications that arrived before the initial fetch completed - a direct
  // prepend would be clobbered when the fetch lands, so they wait for it
  private pendingPubs: Notification[] = [];
  private fetchedOnce = false;
  private subscribedOnce = false;
  static get styles() {
    return css`
      :host {
        --option-hover-bg: #f9f9f9;
        --options-empty-message-align: center;
      }

      .header {
        padding: 0.25em 1em;
        background: #f9f9f9;
        border-top-left-radius: var(--curvature);
        border-top-right-radius: var(--curvature);
        display: flex;
        color: #999;
        border-bottom: 1px solid #f3f3f3;
      }

      .header temba-icon {
        margin-right: 0.35em;
      }

      .footer {
        background: #f9f9f9;
      }

      .title {
        font-weight: normal;
      }
    `;
  }

  protected defaultEmptyMessage(): string {
    return msg('No notifications');
  }

  constructor() {
    super();
    this.valueKey = 'url';
    // set in the constructor, not as a class field - a field would shadow the
    // reactive accessor under define semantics (see lit class-field-shadowing)
    this.internalFocusDisabled = true;
    this.renderOption = (notification: Notification): TemplateResult => {
      let icon = null;
      let body = null;
      const color = '#333';

      if (notification.type === 'incident:started') {
        if (notification.incident.type === 'org:flagged') {
          icon = Icon.incidents;
          body = msg(
            'Your workspace was flagged, please contact support for assistance.'
          );
        } else if (notification.incident.type === 'org:suspended') {
          icon = Icon.incidents;
          body = msg(
            'Your workspace was suspended, please contact support for assistance.'
          );
        } else if (notification.incident.type === 'channel:disconnected') {
          icon = Icon.channel;
          body = msg('Your android channel is not connected');
        } else if (notification.incident.type === 'channel:templates_failed') {
          icon = Icon.channel;
          body = msg('Your WhatsApp channel templates failed syncing');
        } else if (notification.incident.type === 'webhooks:unhealthy') {
          icon = Icon.webhook;
          body = msg('Your webhook calls are not working properly.');
        } else {
          // incident types registered outside of this project show their title
          icon = Icon.incidents;
          body = notification.incident.title;
        }
      } else if (notification.type === 'import:finished') {
        if (notification.import.type === 'contact') {
          icon = Icon.contact_import;
          body = msg(
            str`Imported ${formatCount(notification.import.num_records)} contacts`
          );
        }
      } else if (notification.type === 'export:finished') {
        if (notification.export.type === 'contact') {
          icon = Icon.contact_export;
          body = msg(
            str`Exported ${formatCount(notification.export.num_records)} contacts`
          );
        } else if (notification.export.type === 'message') {
          icon = Icon.message_export;
          body = msg(
            str`Exported ${formatCount(notification.export.num_records)} messages`
          );
        } else if (notification.export.type === 'results') {
          icon = Icon.results_export;
          body = msg('Exported flow results');
        } else if (notification.export.type === 'ticket') {
          icon = Icon.tickets_export;
          body = msg(
            str`Exported ${formatCount(notification.export.num_records)} tickets`
          );
        } else if (notification.export.type === 'definition') {
          icon = Icon.definitions_export;
          body = msg('Exported definitions');
        }
      } else if (notification.type === 'tickets:activity') {
        icon = Icon.tickets;
        body = msg('New ticket activity');
      } else if (notification.type === 'tickets:opened') {
        icon = Icon.tickets;
        body = msg('New unassigned ticket');
      }
      return html`<div
        style="color:${color};display:flex;align-items:flex-start;flex-direction:row;font-weight:${notification.is_seen
          ? 400
          : 500}"
      >
        ${icon
          ? html`<div style="margin-right:0.6em">
              <temba-icon name="${icon}"></temba-icon>
            </div>`
          : null}
        <div style="display:flex;flex-direction:column">
          <div style="line-height:1.1em">${body}</div>
          <temba-date
            style="font-size:80%"
            value=${notification.created_on}
            display="duration"
          ></temba-date>
        </div>
      </div>`;
    };
  }

  public connectedCallback() {
    super.connectedCallback();
    this.realtimeSubscription = subscribeToNotifications(
      (notification) => this.handleNotification(notification),
      () => this.handleSubscribed()
    );
  }

  public disconnectedCallback() {
    super.disconnectedCallback();
    if (this.realtimeSubscription) {
      this.realtimeSubscription.unsubscribe();
      this.realtimeSubscription = null;
    }
  }

  public willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has('loading') && !this.loading) {
      this.fetchedOnce = true;
      const pending = this.pendingPubs;
      this.pendingPubs = [];
      pending.forEach((notification) => this.prependNotification(notification));
    }
  }

  private handleNotification(notification: Notification) {
    // ignore redeliveries of notifications we already have so e.g. the
    // menu's unseen badge only lights for genuinely new ones
    if (
      this.items.some((item) => item.url === notification.url) ||
      this.pendingPubs.some((item) => item.url === notification.url)
    ) {
      return;
    }

    // announce arrival, even mid-fetch - e.g. the menu's unseen badge
    this.fireCustomEvent(CustomEventType.NotificationReceived, {
      notification
    });

    if (this.loading || !this.fetchedOnce) {
      this.pendingPubs.push(notification);
    } else {
      this.prependNotification(notification);
    }
  }

  private prependNotification(notification: Notification) {
    // dedupe by url (our valueKey) and prepend
    this.items = [
      notification,
      ...this.items.filter((item) => item.url !== notification.url)
    ];
    this.mostRecentItem = notification;
  }

  /**
   * Fires on every (re)subscribe including after reconnects. The initial
   * endpoint fetch covers the first one regardless of which completes first,
   * so only refetch page one on resubscribes, to catch anything missed
   * while offline.
   */
  private handleSubscribed() {
    if (this.subscribedOnce && this.fetchedOnce) {
      this.refresh();
    }
    this.subscribedOnce = true;
  }

  // urls marked seen on the server but still shown bold for this viewing
  private seenUrls = new Set<string>();

  /**
   * Marks everything currently unseen as seen on the server, without any
   * refetching - the socket keeps our items current and seen state is fully
   * known here. Items stay bold for the current viewing and unbold on the
   * next call (e.g. the next popup open). Resolves false if the server
   * didn't record it, in which case nothing advances and the next call
   * retries.
   */
  public markSeen(): Promise<boolean> {
    // unbold whatever was marked seen last time
    if (this.seenUrls.size > 0) {
      this.items = this.items.map((item) =>
        this.seenUrls.has(item.url) ? { ...item, is_seen: true } : item
      );
    }

    const unseen = this.items.filter((item) => !item.is_seen);
    if (unseen.length === 0 || !this.endpoint) {
      return Promise.resolve(true);
    }

    // only advance our seen state if the server actually recorded it,
    // otherwise we'd unbold items the server still considers unseen
    return deleteRequest(this.endpoint)
      .then((response) => {
        if (!response.ok) {
          console.warn(
            `failed marking notifications seen (${response.status})`
          );
          return false;
        }
        this.seenUrls = new Set(unseen.map((item) => item.url));
        return true;
      })
      .catch((error) => {
        console.warn('failed marking notifications seen', error);
        return false;
      });
  }

  public renderHeader(): TemplateResult {
    return html`<div class="header">
      <temba-icon name="notification"></temba-icon>
      <div class="title">${msg('Notifications')}</div>
    </div>`;
  }

  public scrollToTop(): void {
    // scroll back to the top
    window.setTimeout(() => {
      const options = this.shadowRoot.querySelector('temba-options') as Options;
      options.scrollToTop();
    }, 1000);
  }
}
