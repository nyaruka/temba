import { css, html, PropertyValues, TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { msg } from '@lit/localize';
import { TembaList } from './TembaList';
import { Contact, CustomEventType } from '../interfaces';
import { Icon } from '../Icons';
import { ResultsPage } from '../utils';

// a ticket's last activity in ms, or 0 if it's unparseable, so a single bad
// timestamp can't poison a refresh cursor with NaN
const parseActivity = (item: Contact): number => {
  const activity = new Date(item.ticket?.last_activity_on).getTime();
  return isNaN(activity) ? 0 : activity;
};

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

  public getRefreshEndpoint() {
    // open tickets sort above closed ones, so the newest activity can be
    // anywhere in the list, not just the top
    const lastActivity = this.items.reduce(
      (newest, item) => Math.max(newest, parseActivity(item)),
      this.activityCursor
    );

    if (lastActivity > 0) {
      const separator = this.endpoint.includes('?') ? '&' : '?';
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

      // closed is a mark where the age would be, with how it closed in words
      // for screen readers and on hover - a check in the success tone when
      // it was resolved, a clock switched off when it expired from going idle
      const expired = ticket.outcome === 'idle';
      const outcome = expired ? msg('Expired') : msg('Resolved');
      const rail = closed
        ? html`<temba-icon
            name=${expired ? Icon.ticket_expired : Icon.tickets_closed}
            size=${expired ? '1.1' : '1.2'}
            title=${outcome}
            aria-label=${outcome}
            style="--icon-color:${expired
              ? 'var(--text-3)'
              : 'var(--success)'};"
          ></temba-icon>`
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
            style="align-self:stretch; display:flex; align-items:flex-end; justify-content:flex-end; border-left:1px solid var(--border);"
          >
            ${rail}
          </div>
        </div>
      `;
    };
  }
}
