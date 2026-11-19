import { css, html, PropertyValues, TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { msg } from '@lit/localize';
import { TembaList } from './TembaList';
import { Contact, CustomEventType } from '../interfaces';
import { Icon } from '../Icons';
import { ResultsPage } from '../utils';
import {
  RealtimeSubscription,
  subscribeToOrganizationTickets
} from '../live/Realtime';

// a ticket's last activity in ms, or 0 if it's unparseable, so a single bad
// timestamp can't poison a refresh cursor with NaN
const parseActivity = (item: Contact): number => {
  const activity = new Date(item.ticket?.last_activity_on).getTime();
  return isNaN(activity) ? 0 : activity;
};

// the least time between two refreshes driven by tickets_changed, so a busy
// workspace costs each open list at most one fetch per window
export const TICKETS_REFRESH_THROTTLE = 3000;

// the most changed tickets read in one refresh - the folder view reads no more
export const TICKETS_REFRESH_BATCH = 100;

export class TicketList extends TembaList {
  // the current user's email, so their own messages read as You
  @property({ type: String })
  agent = '';

  // who an automated message, e.g. from a flow, is shown as being from
  @property({ type: String })
  workspace = '';

  // leave the assignee off each row, for a folder where it's the same on
  // every row, e.g. the user's own tickets
  @property({ type: Boolean })
  hideAssignee = false;

  // refreshed when the workspace says its tickets changed, not on an interval,
  // over a socket held only while the list is on the page
  protected pollingEnabled = false;

  private ticketsWatch: RealtimeSubscription = null;
  private subscribedOnce = false;
  private refreshTimer: number = null;
  private lastRefreshAt = 0;
  private refreshAfterLoad = false;

  // tickets we've heard changed and have yet to read again, and whether we
  // heard of changes we can't name, so have to reload the whole list
  private changedTickets = new Set<string>();
  private reloadNeeded = false;

  static get styles() {
    return css`
      ${super.styles}
      :host {
        --options-empty-message-align: center;
        /* names and messages don't wrap - as a flex item, don't let their
           full width hold the list wider than its column */
        min-width: 0;
      }
      /* a full-bleed list of flat rows, ruled off from each other edge to
         edge, filling the column's own panel */
      temba-options {
        --options-block-shadow: none;
        --temba-options-block-radius: 0;
        --temba-options-block-padding: 0;
        --temba-options-block-gap: 0;
        --temba-options-block-option-radius: 0;
        --temba-options-row-separator-inset: 0;
        --temba-options-row-separator: 1px solid var(--border);
        --temba-options-focused-separator-display: block;
        /* a selected row is tinted, its text keeps its own colors */
        --temba-options-option-focus-text: var(--text-1);
      }
    `;
  }

  protected defaultEmptyMessage(): string {
    return msg('No tickets');
  }

  // newest: most recent activity first, with closed tickets below the open
  // ones. oldest: open tickets only, least recent activity first. The endpoint
  // must ask the server for the same order.
  @property({ type: String })
  order = 'newest';

  // the newest activity we know of (in ms), including tickets we fetched but
  // don't show - an oldest first list that's only partly loaded leaves out
  // everything newer than its last row
  private activityCursor = 0;

  public willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has('endpoint')) {
      this.activityCursor = 0;
      this.count = null;
    }
    super.willUpdate(changedProperties);
  }

  /**
   * Reading the tickets we heard changed returns those still in our folder,
   * which says that any others have left it - say moved to another topic.
   */
  protected getRefreshScope(): Set<any> {
    const batch = this.getRefreshBatch();
    return batch.length > 0 ? new Set(batch) : null;
  }

  protected handleRefreshed(scope: Set<any>): void {
    if (!scope) {
      return;
    }
    scope.forEach((uuid) => this.changedTickets.delete(uuid));

    // more changed than one refresh reads
    if (this.changedTickets.size > 0) {
      this.scheduleRefresh();
    }
  }

  private getRefreshBatch(): string[] {
    return [...this.changedTickets].slice(0, TICKETS_REFRESH_BATCH);
  }

  public getRefreshEndpoint() {
    if (!this.endpoint) {
      return this.endpoint;
    }

    const separator = this.endpoint.includes('?') ? '&' : '?';
    const batch = this.getRefreshBatch();
    if (batch.length > 0) {
      return (
        this.endpoint +
        separator +
        'tickets=' +
        batch.map(encodeURIComponent).join(',')
      );
    }

    // open tickets sort above closed ones, so the newest activity can be
    // anywhere in the list, not just the top
    const lastActivity = this.items.reduce(
      (newest, item) => Math.max(newest, parseActivity(item)),
      this.activityCursor
    );

    if (lastActivity > 0) {
      return this.endpoint + separator + 'after=' + lastActivity * 1000;
    }
    return this.endpoint;
  }

  /**
   * Updates a ticket's row with changes made to it here, keeping the row where
   * it is even if the ticket no longer belongs in this folder, say one the
   * user claimed by replying to it from the unassigned folder.
   */
  public holdTicket(ticket: any): Promise<void> {
    const contact = this.items.find(
      (item: Contact) => item.ticket?.uuid === ticket?.uuid
    );
    if (!contact) {
      return Promise.resolve();
    }

    const updated = { ...contact, ticket: { ...contact.ticket, ...ticket } };
    return this.store.resolveUsers([updated], ['ticket.assignee']).then(() => {
      this.holdItem(updated);
    });
  }

  protected handleFirstPage(page: ResultsPage): void {
    // the server's clock when it read the page, so polls start from there
    // rather than from the newest ticket we happened to load
    const now = new Date(page.data?.now).getTime();
    this.activityCursor = isNaN(now) ? 0 : now;
  }

  // how many open tickets the list's folder has, as the server last told us,
  // and its wording of that in the user's language - they're for the page to
  // show, so a change is announced with an event
  @property({ type: Number, attribute: false })
  count: number = null;

  @property({ type: String, attribute: false })
  countLabel: string = null;

  protected handleCurrentPage(page: ResultsPage): void {
    const count = page.data?.count;
    if (typeof count === 'number' && count !== this.count) {
      this.count = count;
      this.countLabel = page.data.count_label || String(count);
      this.fireCustomEvent(CustomEventType.CountChanged, {
        count,
        label: this.countLabel
      });
    }
  }

  protected keepItem(item: Contact): boolean {
    if (this.order !== 'oldest') {
      return true;
    }
    if (item.ticket.closed_on) {
      return false;
    }

    // until the list is fully loaded, a ticket that now sorts past our last
    // row arrives with a later page instead
    const last = this.items[this.items.length - 1];
    return !this.nextPage || !last || this.compareItems(item, last) <= 0;
  }

  public connectedCallback() {
    super.connectedCallback();
    this.ticketsWatch = subscribeToOrganizationTickets(
      (event) => {
        if (event?.type === 'tickets_changed') {
          // the event names the tickets that changed, unless there were too
          // many to name
          if (event.tickets) {
            event.tickets.forEach((uuid) => this.changedTickets.add(uuid));
          } else {
            this.reloadNeeded = true;
          }
          this.scheduleRefresh();
        }
      },
      () => this.handleSubscribed()
    );
  }

  public disconnectedCallback() {
    super.disconnectedCallback();
    if (this.ticketsWatch) {
      this.ticketsWatch.unsubscribe();
      this.ticketsWatch = null;
    }
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.subscribedOnce = false;
    this.refreshAfterLoad = false;
    this.changedTickets.clear();
    this.reloadNeeded = false;
  }

  public updated(changed: Map<string, any>): void {
    super.updated(changed);
    if (changed.has('loading') && !this.loading && this.refreshAfterLoad) {
      this.refreshAfterLoad = false;
      this.scheduleRefresh();
    }
  }

  /**
   * Fires on every (re)subscribe. The initial fetch covers the first, so only
   * a resubscribe - after a dropped connection - reloads, to catch up on
   * anything that changed while we couldn't hear about it.
   */
  private handleSubscribed() {
    if (this.subscribedOnce) {
      this.reloadNeeded = true;
      this.scheduleRefresh();
    }
    this.subscribedOnce = true;
  }

  /**
   * Refreshes on the leading edge, then coalesces anything else that arrives
   * within the throttle window into one trailing refresh, which reads every
   * ticket we heard changed in the meantime.
   */
  private scheduleRefresh() {
    if (this.refreshTimer) {
      return;
    }

    const wait = Math.max(
      0,
      this.lastRefreshAt + TICKETS_REFRESH_THROTTLE - Date.now()
    );

    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;

      // a refresh aborts whatever is in flight, which mid-load would be the
      // page fetch itself, so wait for that and refresh after it instead
      if (this.loading) {
        this.refreshAfterLoad = true;
        return;
      }

      this.lastRefreshAt = Date.now();
      if (this.reloadNeeded) {
        this.reloadNeeded = false;
        this.changedTickets.clear();
        this.reload();
      } else if (this.changedTickets.size > 0) {
        this.refresh();
      }
    }, wait);
  }

  protected sanitizeResults(results: any[]): Promise<any[]> {
    results.forEach((item) => {
      this.activityCursor = Math.max(this.activityCursor, parseActivity(item));
    });

    return new Promise<any[]>((resolve) => {
      const contacts: Contact[] = results as Contact[];
      this.store.resolveUsers(contacts, ['ticket.assignee']).then(() => {
        resolve(contacts);
      });
    });
  }

  constructor() {
    super();

    this.valueKey = 'ticket.uuid';
    // the refresh feed is served oldest first - the inherited reverseRefresh
    // keeps mostRecentItem meaning the newest fetched item (compareItems
    // re-sorts the merged list immediately anyway)

    this.compareItems = (a: Contact, b: Contact): number => {
      const aClosed = !!a.ticket.closed_on;
      const bClosed = !!b.ticket.closed_on;
      if (aClosed !== bClosed) {
        return aClosed ? 1 : -1;
      }
      const aActivity = new Date(a.ticket.last_activity_on).getTime();
      const bActivity = new Date(b.ticket.last_activity_on).getTime();
      return this.order === 'oldest'
        ? aActivity - bActivity
        : bActivity - aActivity;
    };
    // each row is the contact, who the ticket is assigned to and the last
    // message, with how long since the ticket's last activity in a rail on
    // the right. A closed ticket keeps the same row, marked closed in place
    // of the time - so closing one never changes the row's shape
    this.renderOption = (contact: Contact): TemplateResult => {
      const ticket = contact.ticket;
      const closed = !!ticket.closed_on;

      // contacts go by their first name, or their URN in full when they have
      // no name, since part of one would mean nothing
      const contactName = contact.first_name || contact.name;
      const assignee =
        ticket.assignee && !this.hideAssignee
          ? ticket.assignee.email === this.agent
            ? msg('You')
            : ticket.assignee.first_name || ticket.assignee.email
          : null;

      const lastMsg = contact.last_msg;
      const body = !lastMsg
        ? null
        : lastMsg.text
          ? html`${lastMsg.text}`
          : lastMsg.attachments?.length
            ? html`<temba-icon
                  name=${Icon.attachment}
                  size="0.9"
                  style="display:inline-block; vertical-align:-2px; margin-right:0.2em;"
                ></temba-icon
                >${msg('Attachment')}`
            : html`<i>${msg('Unsupported Message')}</i>`;

      // a message of ours says who sent it - the contact's own don't need to
      const sender = lastMsg?.sender;
      const from =
        lastMsg?.direction === 'O'
          ? sender
            ? sender.email === this.agent
              ? msg('You')
              : sender.first_name || sender.email
            : this.workspace
          : null;

      // closed is a check in a circle, centred where the age would be, with
      // how it closed in words for screen readers and on hover - a solid
      // green disc when it was resolved, a light dashed ring when it expired
      // from going idle, closed but not by anyone
      const expired = ticket.outcome === 'idle';
      const outcome = expired ? msg('Expired') : msg('Resolved');
      const rail = closed
        ? html`<span
            title=${outcome}
            aria-label=${outcome}
            role="img"
            style="display:flex; align-items:center; justify-content:center; box-sizing:border-box; width:20px; height:20px; border-radius:50%; ${expired
              ? 'border:1px dashed var(--text-4); --icon-color:var(--text-3);'
              : 'background:var(--success); --icon-color:#fff;'}"
            ><temba-icon name=${Icon.tickets_closed} size="0.75"></temba-icon
          ></span>`
        : html`<temba-date
            value=${ticket.last_activity_on}
            display="age"
            style="font-weight:600; --temba-date-age-size:14px;"
          ></temba-date>`;

      return html`
        <div
          style="display:grid; grid-template-columns:34px minmax(0,1fr) 54px; column-gap:12px; align-items:center; min-height:2.6em;"
        >
          <temba-contact-avatar
            name=${contact.first_name ? contact.name : ''}
            scheme=${contact.scheme || ''}
          ></temba-contact-avatar>
          <div style="min-width:0;">
            <div
              style="display:flex; align-items:center; gap:4px; min-width:0; line-height:1.5; white-space:nowrap;"
            >
              <span
                style="min-width:0; overflow:hidden; text-overflow:ellipsis; font-weight:600; color:var(--text-1);"
                >${contactName}</span
              >
              ${assignee
                ? html`<temba-icon
                      name=${Icon.arrow_right}
                      size="0.8"
                      style="flex-shrink:0; --icon-color:var(--text-3);"
                    ></temba-icon
                    ><span
                      style="flex-shrink:0; max-width:45%; overflow:hidden; text-overflow:ellipsis; color:var(--text-3);"
                      >${assignee}</span
                    >`
                : null}
            </div>
            ${body
              ? html`<div
                  style="font-size:0.9em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--text-2);"
                >
                  ${from
                    ? html`<span style="color:var(--text-3);">${from}: </span>`
                    : null}${body}
                </div>`
              : null}
          </div>
          <div
            style="align-self:stretch; display:flex; align-items:${closed
              ? 'center'
              : 'flex-end'}; justify-content:flex-end; border-left:1px solid var(--border);"
          >
            ${rail}
          </div>
        </div>
      `;
    };
  }
}
