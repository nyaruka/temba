import { css, html, PropertyValues, TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { msg } from '@lit/localize';
import { RefreshOutcome, TembaList } from './TembaList';
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

// the least time between the end of one refresh driven by tickets_changed and
// the start of the next, so however many events a busy workspace publishes,
// each open list makes at most one fetch per window, and never two at once
export const TICKETS_REFRESH_THROTTLE = 3000;

// the most changed tickets read in one refresh - the folder view reads no more,
// so a backlog bigger than this reloads the list instead
export const TICKETS_REFRESH_BATCH = 100;

// after a failed refresh the window doubles each time, up to this
export const TICKETS_REFRESH_MAX_BACKOFF = 60000;

// a refresh that hasn't ended after this long is taken to have been lost, so
// it can't hold up the ones after it forever
const TICKETS_REFRESH_STALE = 30000;

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

  // a random delay of up to this many ms before each refresh, so every list
  // open in the workspace doesn't fetch at the same moment for the same event
  public refreshJitter = 500;

  private ticketsWatch: RealtimeSubscription = null;
  private subscribedOnce = false;
  private refreshTimer: number = null;
  private lastRefreshAt = 0;
  private refreshAfterLoad = false;

  // when the refresh in flight started, or 0 if there isn't one, and how many
  // in a row have failed
  private refreshingSince = 0;
  private refreshFailures = 0;

  // a hidden page leaves its changes to read when it's next looked at
  private refreshWhenVisible = false;

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

      // the list loads from scratch, which reads everything we'd heard of, and
      // cancels any refresh in flight - which might never have started, if it
      // was asked for in the same update
      this.refreshingSince = 0;
      this.refreshAfterLoad = false;
      this.changedTickets.clear();
      this.reloadNeeded = false;
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

  protected handleRefreshEnded(scope: Set<any>, outcome: RefreshOutcome): void {
    // a refresh our own scheduling didn't start, say a direct refresh()
    if (!this.refreshingSince) {
      return;
    }
    this.refreshEnded(outcome);
    if (outcome === 'merged' && scope) {
      scope.forEach((uuid) => this.changedTickets.delete(uuid));
    }
    this.scheduleRefresh();
  }

  private refreshEnded(outcome: RefreshOutcome) {
    // the next is scheduled from now, not from when this one went stale
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.refreshingSince = 0;
    this.lastRefreshAt = Date.now();
    if (outcome === 'merged') {
      this.refreshFailures = 0;
    } else if (outcome === 'failed') {
      this.refreshFailures++;
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

  private handleVisibilityChange = () => {
    if (!this.isPageHidden() && this.refreshWhenVisible) {
      this.refreshWhenVisible = false;
      this.scheduleRefresh();
    }
  };

  protected isPageHidden(): boolean {
    return document.visibilityState === 'hidden';
  }

  public connectedCallback() {
    super.connectedCallback();
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
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
    document.removeEventListener(
      'visibilitychange',
      this.handleVisibilityChange
    );
    if (this.ticketsWatch) {
      this.ticketsWatch.unsubscribe();
      this.ticketsWatch = null;
    }
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.subscribedOnce = false;
    this.refreshAfterLoad = false;
    this.refreshWhenVisible = false;
    this.refreshingSince = 0;
    this.refreshFailures = 0;
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
   * into one trailing refresh, which reads every ticket we heard changed in
   * the meantime. Refreshes never overlap - the next waits out the window from
   * the end of the last, which a failure doubles - so a firehose of events
   * costs each list one fetch per window, and a struggling server no more.
   */
  private scheduleRefresh() {
    if (this.refreshTimer || !this.refreshOwed()) {
      return;
    }

    const backoff = Math.min(
      TICKETS_REFRESH_THROTTLE * 2 ** this.refreshFailures,
      TICKETS_REFRESH_MAX_BACKOFF
    );
    const wait =
      Math.max(0, this.lastRefreshAt + backoff - Date.now()) +
      Math.random() * this.refreshJitter;

    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.startRefresh();
    }, wait);
  }

  private refreshOwed(): boolean {
    return this.reloadNeeded || this.changedTickets.size > 0;
  }

  private startRefresh() {
    // one at a time - the one in flight schedules the next when it ends, or
    // if it never does, we try again once it's taken too long
    if (this.refreshingSince) {
      const stale = this.refreshingSince + TICKETS_REFRESH_STALE - Date.now();
      if (stale > 0) {
        this.refreshTimer = window.setTimeout(() => {
          this.refreshTimer = null;
          this.startRefresh();
        }, stale);
        return;
      }
    }

    // a refresh aborts whatever is in flight, which mid-load would be the
    // page fetch itself, so wait for that and refresh after it instead
    if (this.loading) {
      this.refreshAfterLoad = true;
      return;
    }

    if (this.isPageHidden()) {
      this.refreshWhenVisible = true;
      return;
    }

    // more changed than one refresh can read, so read the list again instead
    if (this.changedTickets.size > TICKETS_REFRESH_BATCH) {
      this.reloadNeeded = true;
    }

    const startedAt = Date.now();
    this.refreshingSince = startedAt;
    if (this.reloadNeeded) {
      this.reloadNeeded = false;
      this.changedTickets.clear();
      this.reload().then((outcome) => {
        // a load from a new endpoint took over from this one, and owns the list
        if (this.refreshingSince !== startedAt) {
          return;
        }
        // a reload that failed owes the whole list again
        if (outcome === 'failed') {
          this.reloadNeeded = true;
        }
        this.refreshEnded(outcome);
        this.scheduleRefresh();
      });
    } else if (this.changedTickets.size > 0) {
      this.refresh();
    } else {
      this.refreshingSince = 0;
    }
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
