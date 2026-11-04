import { css, html, PropertyValues, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { property, state } from 'lit/decorators.js';
import { ContentList, ContentListColumn } from './ContentList';
import { Icon } from '../Icons';
import { Broadcast, CustomEventType, ObjectReference } from '../interfaces';
import { attachmentAsString, formatCount } from '../utils';
import {
  buttonChrome,
  buttonChromeActive,
  buttonChromeDestructive,
  buttonChromeDestructiveHover,
  buttonChromeHover
} from '../styles/buttonChrome';

/** Placeholder shown in any cell whose value is empty. */
const EMPTY = '--';

/** Most recipient pills a row renders before folding the remainder
 * into a "+N" summary whose tooltip names everything. */
const MAX_PILLS = 2;

/** Row status → status-pill kind + label. Broadcasts sit at
 * `pending` until their (schedule's) fire time, move through
 * `queued` / `started` while mailroom creates messages, and land on
 * one of the terminal states. */
const STATUS_PILLS: { [status: string]: { kind: string; label: string } } = {
  pending: { kind: 'pending', label: 'Pending' },
  queued: { kind: 'pending', label: 'Sending' },
  started: { kind: 'pending', label: 'Sending' },
  completed: { kind: 'active', label: 'Sent' },
  failed: { kind: 'error', label: 'Failed' },
  interrupted: { kind: 'neutral', label: 'Interrupted' }
};

/**
 * Broadcast CRUDL list — drop-in replacement for the rapidpro
 * `msgs/broadcast_list.html` (sent) and `msgs/broadcast_scheduled.html`
 * (upcoming) cards, selected via the `mode` attribute. Every row is
 * one line: the message (text + attachment thumbnails + template
 * pill), who it goes to, and either the send column (count or
 * in-flight status) or the schedule columns. In place of a broadcast
 * read page, clicking a row opens a floating detail dialog — the same
 * pattern as the campaign read page's event details — with the full
 * message, recipients, schedule/delivery specifics, and (scheduled
 * mode, permission-gated) Edit / Delete actions that fire
 * `temba-selection` for the host to open its modals.
 */
export class BroadcastList extends ContentList<Broadcast> {
  static get styles() {
    return css`
      ${ContentList.styles}
      /* Rows are clickable (they open the detail dialog) but carry no
         href, so ContentList doesn't mark them .clickable — carry the
         affordance ourselves. */
      tr.row {
        cursor: pointer;
      }
      /* The message cell holds the body text on the leading edge with
         its attachment thumbnails right after it and the template
         pill pushed to the trailing edge — the msg-list treatment. */
      .msg-cell {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .msg-text {
        flex: 0 1 auto;
        min-width: 80px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .msg-attachments {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .cell-pills {
        flex: 0 0 auto;
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      /* Attachment thumbnails sized well under the row height — the
         same small square preview the message list uses. */
      .msg-thumb {
        --thumb-size: 24px;
        --thumb-padding: 2px;
        --thumb-icon-padding: 4px;
        max-height: 36px;
        overflow: hidden;
      }
      /* Recipient pills — a capped run with a "+N" summary. Pills
         never shrink (the cap bounds the row); the summary carries
         the hidden names in its tooltip. */
      .pills {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
      }
      .pills temba-label {
        flex: 0 0 auto;
      }
      .num {
        font-variant-numeric: tabular-nums;
        color: inherit;
      }
      /* In-flight send progress — a compact bare meter, right-aligned
         in the Messages cell. */
      .send-progress {
        width: 110px;
        margin-left: auto;
        --progress-min-height: 14px;
        --progress-bar-min-height: 6px;
        --progress-padding: 3px;
      }
      /* The detail's counterpart fills the status line's slack up to
         the message count on its right. */
      .detail-progress {
        flex: 1;
        --progress-min-height: 16px;
        --progress-bar-min-height: 6px;
        --progress-padding: 4px;
      }
      .muted {
        color: var(--text-3);
      }

      /* ---- detail dialog — the campaign-events detail treatment:
         page-like (no colored header bar), header and footer pinned
         with full-bleed rules, the body scrolling between them. */
      .detail {
        display: flex;
        flex-direction: column;
      }
      .detail-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 1em;
        border-bottom: 1px solid var(--border, #e4e7ec);
      }
      .detail-title {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .detail-name {
        font-size: 15.5px;
        font-weight: var(--w-semibold, 600);
        color: var(--text-1);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .detail-when {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.9em;
        color: var(--text-3, #7b8593);
      }
      .detail-actions {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      /* the status pill sits in the header just left of the close */
      .detail-header .status-pill {
        flex-shrink: 0;
      }
      /* match the page header's content-menu buttons so the dialog's
         actions read like page actions */
      .menu-button {
        ${buttonChrome}
      }
      .menu-button:hover {
        ${buttonChromeHover}
      }
      .menu-button:active {
        ${buttonChromeActive}
      }
      .menu-button.destructive {
        ${buttonChromeDestructive}
      }
      .menu-button.destructive:hover {
        ${buttonChromeDestructiveHover}
      }
      .detail-body {
        display: flex;
        flex-direction: column;
        gap: 1.25em;
        overflow-y: auto;
        max-height: calc(100vh - 300px);
        padding: 1.25em 1.75em;
      }
      /* the status line leads the body — schedule / delivery facts on
         the left, the labeled message count on the right */
      .detail-status-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .detail-status {
        /* take the row's slack so an in-flight progress bar can
           stretch to the message count on the right */
        flex: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.9em;
        color: var(--text-3, #7b8593);
      }
      .detail-count {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 0.35em;
        font-size: 0.85em;
        color: var(--text-3, #7b8593);
        --icon-color: var(--text-3, #7b8593);
      }
      /* the message itself, contained with a leading section label.
         Children hug their content so pills don't stretch the box. */
      .detail-message {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.6em;
        padding: 0.9em 1em 1em;
        /* pre-mixed fallback for browsers without color-mix() */
        background: #f9fafa;
        border: 1px solid var(--border, #e4e7ec);
        border-radius: var(--r);
        line-height: 1.5;
      }

      @supports (color: color-mix(in srgb, red, red)) {
        .detail-message {
          background: color-mix(
            in srgb,
            var(--sunken, #f1f3f5) 45%,
            var(--surface, #fff)
          );
        }
      }
      .detail-message temba-expression-highlight {
        align-self: stretch;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .detail-attachments {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .detail-attachments temba-thumbnail {
        --thumb-size: 48px;
      }
      .detail-section-title {
        font-size: 0.75em;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-3, #7b8593);
      }
      /* a section heading with a trailing fact on its right — the
         recipients title with the message count across from it */
      .detail-section-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .detail-pills {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      /* exclusions read as muted footnotes under the recipient pills */
      .detail-exclusions {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 0.85em;
        color: var(--text-3, #7b8593);
      }
      /* the close (✕) in the header's upper right - the square
         hover-wash button treatment (the pager buttons'), sitting
         just outboard of the action buttons */
      .detail-close {
        flex-shrink: 0;
        margin-left: -4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: var(--r-sm);
        color: var(--text-3, #7b8593);
        cursor: pointer;
        user-select: none;
      }
      .detail-close:hover {
        background: var(--sunken);
        color: var(--text-1);
      }
      .detail-close temba-icon {
        --icon-color: currentColor;
      }
    `;
  }

  /** Which broadcast list this is — `sent` (the results list) or
   * `scheduled` (broadcasts waiting to fire). Drives the trailing
   * columns and the detail dialog's specifics. */
  @property({ type: String })
  mode: 'sent' | 'scheduled' = 'sent';

  /** Whether the viewer may edit scheduled broadcasts — surfaces the
   * detail dialog's Edit action. Set by the host from its perms. */
  @property({ type: Boolean, attribute: 'can-edit' })
  canEdit = false;

  /** Whether the viewer may delete scheduled broadcasts — surfaces
   * the detail dialog's Delete action. */
  @property({ type: Boolean, attribute: 'can-delete' })
  canDelete = false;

  /** The broadcast whose detail dialog is open. */
  @state()
  private detailBroadcast: Broadcast = null;

  protected defaultEmptyMessage(): string {
    return msg('No broadcasts');
  }

  protected defaultSearchPlaceholder(): string {
    return msg('Search broadcasts');
  }

  constructor() {
    super();
    this.valueKey = 'uuid';
  }

  protected willUpdate(changes: PropertyValues): void {
    super.willUpdate(changes);
    if (changes.has('mode')) {
      this.refreshColumns();
    }
  }

  /** The leading columns are shared; the trailing ones swap between
   * the sent list's count/date and the scheduled list's repeat/next
   * fire. */
  protected buildColumns(): ContentListColumn[] {
    const leading: ContentListColumn[] = [
      { key: 'message', label: msg('Message'), grow: true, minWidth: '220px' },
      {
        key: 'recipients',
        label: msg('Recipients'),
        minWidth: '130px',
        maxWidth: '320px'
      }
    ];
    if (this.mode === 'scheduled') {
      return [
        ...leading,
        {
          key: 'schedule',
          label: msg('Schedule'),
          minWidth: '120px',
          maxWidth: '280px'
        },
        {
          key: 'next_fire',
          label: msg('Next Send'),
          sortable: true,
          minWidth: '96px',
          maxWidth: '170px',
          align: 'right'
        }
      ];
    }
    return [
      ...leading,
      {
        key: 'messages',
        label: msg('Messages'),
        minWidth: '80px',
        align: 'right'
      },
      {
        key: 'created_on',
        label: msg('Sent'),
        sortable: true,
        minWidth: '96px',
        maxWidth: '150px',
        align: 'right'
      }
    ];
  }

  protected getRowIcon(_item: Broadcast): string | null {
    return this.mode === 'scheduled' ? Icon.schedule : Icon.broadcast;
  }

  public connectedCallback(): void {
    super.connectedCallback();
    // In place of a broadcast read page, a row click opens the detail
    // dialog. ContentList fires RowClick on the host element, so we
    // can listen to ourselves rather than override its private click
    // handler; the event still bubbles on to outside listeners.
    this.addEventListener(
      CustomEventType.RowClick,
      this.handleRowClickEvent as EventListener
    );
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener(
      CustomEventType.RowClick,
      this.handleRowClickEvent as EventListener
    );
  }

  private handleRowClickEvent = (event: CustomEvent): void => {
    const item = event.detail?.item as Broadcast;
    if (item) {
      this.detailBroadcast = item;
    }
  };

  // closes arrive from the header ✕, our own @keyup ESC handler, and
  // mask clicks (which fire temba-dialog-hidden) - our open state must
  // reset on every path or the next open is a no-op change and the
  // dialog never reopens
  private handleDetailClosed = (): void => {
    this.detailBroadcast = null;
  };

  // edit / delete close the detail dialog before the host opens the
  // edit or delete-confirm modal in its place - modals never stack
  public handleEditClicked(): void {
    const broadcast = this.detailBroadcast;
    this.detailBroadcast = null;
    this.fireCustomEvent(CustomEventType.Selection, {
      action: 'edit_broadcast',
      broadcast
    });
  }

  public handleDeleteClicked(): void {
    const broadcast = this.detailBroadcast;
    this.detailBroadcast = null;
    this.fireCustomEvent(CustomEventType.Selection, {
      action: 'delete_broadcast',
      broadcast
    });
  }

  /** Navigate a recipient pill through the SPA, suppressing the
   * row's own click (which opens the detail dialog) — and closing the
   * dialog when clicked from inside it, since we're leaving the page.
   * Meta/ctrl-click opens a new tab and leaves the dialog alone. */
  private handlePillClick(href: string, event: MouseEvent): void {
    event.stopPropagation();
    // Guard the JSON-driven href against open-redirect, same as the
    // row-click path in ContentList.handleRowClick.
    if (!href || !this.isSafeHref(href)) return;
    if (event.metaKey || event.ctrlKey) {
      window.open(href, '_blank');
      return;
    }
    this.detailBroadcast = null;
    this.fireCustomEvent(CustomEventType.Redirected, { url: href });
  }

  /** Every way a broadcast addresses contacts, flattened to pills:
   * groups, contacts, a contact query, and raw URNs. Groups open the
   * group's contact list, contacts their read page, and the query the
   * contact list searched by it; raw URNs have no page of their own. */
  private getRecipientPills(item: Broadcast): TemplateResult[] {
    const pills: TemplateResult[] = [];
    for (const g of item.groups || []) {
      pills.push(
        html`<temba-label
          type="group"
          icon=${Icon.group_include}
          clickable
          @click=${(e: MouseEvent) =>
            this.handlePillClick(`/contact/group/${g.uuid}/`, e)}
          >${g.name}</temba-label
        >`
      );
    }
    for (const c of item.contacts || []) {
      pills.push(
        html`<temba-label
          type="contact"
          clickable
          @click=${(e: MouseEvent) =>
            this.handlePillClick(`/contact/read/${c.uuid}/`, e)}
          >${c.name}</temba-label
        >`
      );
    }
    if (item.query) {
      pills.push(
        html`<temba-label
          type="neutral"
          icon=${Icon.search}
          clickable
          @click=${(e: MouseEvent) =>
            this.handlePillClick(
              `/contact/?search=${encodeURIComponent(item.query)}`,
              e
            )}
          >${item.query}</temba-label
        >`
      );
    }
    for (const urn of item.urns || []) {
      pills.push(html`<temba-label type="contact">${urn}</temba-label>`);
    }
    return pills;
  }

  /** Plain-text names for the pills past the visible cap — the "+N"
   * summary's tooltip. */
  private getRecipientNames(item: Broadcast): string[] {
    return [
      ...(item.groups || []).map((g: ObjectReference) => g.name),
      ...(item.contacts || []).map((c: ObjectReference) => c.name),
      ...(item.query ? [item.query] : []),
      ...(item.urns || [])
    ];
  }

  private renderRecipients(item: Broadcast): TemplateResult | string {
    const pills = this.getRecipientPills(item);
    if (!pills.length) {
      return EMPTY;
    }
    const visible = pills.slice(0, MAX_PILLS);
    const hidden = this.getRecipientNames(item).slice(MAX_PILLS);
    return html`<span class="pills">
      ${visible}
      ${hidden.length
        ? html`<temba-label type="neutral" title=${hidden.join(', ')}
            >+${hidden.length}</temba-label
          >`
        : null}
    </span>`;
  }

  /** The message cell — body text with attachment thumbnails right
   * after it and the template pill pushed to the trailing edge. */
  private renderMessage(item: Broadcast): TemplateResult {
    const text = item.text || '';
    return html`
      <div class="msg-cell">
        ${text ? html`<span class="msg-text">${text}</span>` : ''}
        ${this.renderAttachmentThumbs(item)}${this.renderContentPills(item)}
      </div>
    `;
  }

  private renderAttachmentThumbs(item: Broadcast): TemplateResult | string {
    const attachments = item.attachments || [];
    if (!attachments.length) return '';
    return html`
      <div class="msg-attachments">
        ${attachments.map(
          (a) => html`
            <temba-thumbnail
              class="msg-thumb"
              attachment=${attachmentAsString(a)}
            ></temba-thumbnail>
          `
        )}
      </div>
    `;
  }

  /** Template pill — what the broadcast sends beyond (or instead of)
   * plain text. */
  private renderContentPills(item: Broadcast): TemplateResult | string {
    if (!item.template) return '';
    return html`
      <div class="cell-pills">
        <temba-label type="label" icon=${Icon.channel_wa}
          >${item.template.name}</temba-label
        >
      </div>
    `;
  }

  /** Whether the broadcast is mid-send with a resolved recipient
   * total — the state the progress bar can meaningfully render. Until
   * mailroom resolves the total (-1) the Sending pill stands in. */
  private isSending(item: Broadcast): boolean {
    const status = item.status || '';
    return (
      (status === 'queued' || status === 'started') &&
      (item.progress?.total ?? -1) > 0
    );
  }

  /** The sent list's Messages cell — the created-message count once
   * the broadcast has gone out, a live progress bar while its
   * messages are being created, or a status pill for the other
   * states. */
  private renderMessages(item: Broadcast): TemplateResult | string {
    const status = item.status || '';
    if (status === 'completed') {
      return html`<span class="num">${formatCount(item.msg_count ?? 0)}</span>`;
    }
    if (this.isSending(item)) {
      return html`<temba-progress
        class="send-progress"
        hidePercentage
        total=${item.progress.total}
        current=${item.progress.started || 0}
      ></temba-progress>`;
    }
    const pill = STATUS_PILLS[status];
    return pill ? this.renderStatusPill(pill.kind, pill.label) : EMPTY;
  }

  /** The scheduled list's Schedule cell — the server-rendered human
   * repeat ("each week on Monday"), or "Not scheduled" once the
   * schedule is exhausted or paused. */
  private renderSchedule(item: Broadcast): TemplateResult | string {
    if (!item.schedule?.next_fire) {
      return html`<span class="muted">${msg('Not scheduled')}</span>`;
    }
    return item.schedule.display || EMPTY;
  }

  protected renderCell(
    item: Broadcast,
    column: ContentListColumn
  ): TemplateResult | string {
    switch (column.key) {
      case 'message':
        return this.renderMessage(item);
      case 'recipients':
        return this.renderRecipients(item);
      case 'messages':
        return this.renderMessages(item);
      case 'schedule':
        return this.renderSchedule(item);
      case 'next_fire':
        return item.schedule?.next_fire
          ? html`<temba-date
              value=${item.schedule.next_fire}
              display="timedate"
            ></temba-date>`
          : EMPTY;
      case 'created_on':
        return item.created_on
          ? html`<temba-date
              value=${item.created_on}
              display="timedate"
            ></temba-date>`
          : EMPTY;
      default:
        return super.renderCell(item, column);
    }
  }

  /** The detail dialog's lead line — when the broadcast fires (and
   * how it repeats) for a scheduled broadcast, or its status for a
   * sent one. */
  private renderDetailStatus(broadcast: Broadcast): TemplateResult {
    if (this.mode === 'scheduled') {
      return html`
        <div class="detail-status">
          ${broadcast.schedule?.next_fire
            ? html`
                ${broadcast.schedule.display
                  ? html`<span>${broadcast.schedule.display}</span>`
                  : null}
                <span>${msg('starting')}</span>
                <temba-date
                  value=${broadcast.schedule.next_fire}
                  display="datetime"
                ></temba-date>
              `
            : html`<span>${msg('Not scheduled')}</span>`}
        </div>
      `;
    }
    // the status pill lives in the dialog header (see renderDetail);
    // here only an in-flight send renders, as a bar filling the line
    return html`
      <div class="detail-status">
        ${this.isSending(broadcast)
          ? html`<temba-progress
              class="detail-progress"
              hidePercentage
              total=${broadcast.progress.total}
              current=${broadcast.progress.started || 0}
            ></temba-progress>`
          : null}
      </div>
    `;
  }

  /** The status pill in the dialog header, just left of the close —
   * sent mode only, and only when the send isn't mid-flight (the
   * body's progress bar carries that state instead). */
  private renderHeaderStatus(broadcast: Broadcast): TemplateResult | null {
    if (this.mode !== 'sent' || this.isSending(broadcast)) {
      return null;
    }
    const pill = STATUS_PILLS[broadcast.status || ''];
    return pill ? this.renderStatusPill(pill.kind, pill.label) : null;
  }

  /** The labeled message count, across from the Recipients section
   * title — only meaningful once a sent broadcast has created
   * messages. */
  private renderDetailCount(broadcast: Broadcast): TemplateResult | string {
    if (this.mode !== 'sent' || broadcast.msg_count == null) {
      return '';
    }
    return html`
      <div class="detail-count">
        <temba-icon name=${Icon.message} size="0.9"></temba-icon>
        ${formatCount(broadcast.msg_count)} messages
      </div>
    `;
  }

  /** Dialog detail view for a broadcast, standing in for a read page
   * — the full message (text, attachments, quick replies, template),
   * everyone it addresses including exclusions, and the
   * schedule or delivery specifics in the header. */
  private renderDetail(): TemplateResult {
    const broadcast = this.detailBroadcast;
    const pills = broadcast ? this.getRecipientPills(broadcast) : [];
    const showActions =
      this.mode === 'scheduled' && (this.canEdit || this.canDelete);

    return html`
      <temba-dialog
        size="xlarge"
        variant="flat"
        primaryButtonName=""
        cancelButtonName=""
        hideOnClick
        ?open=${!!broadcast}
        @temba-dialog-hidden=${this.handleDetailClosed}
        @keyup=${(e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            this.handleDetailClosed();
          }
        }}
      >
        ${broadcast
          ? html`
              <div class="detail">
                <div class="detail-header">
                  <div class="detail-title">
                    <div class="detail-name">
                      ${this.mode === 'scheduled'
                        ? 'Scheduled Broadcast'
                        : 'Broadcast'}
                    </div>
                    ${broadcast.created_on || broadcast.created_by
                      ? html`<div class="detail-when">
                          ${broadcast.created_on
                            ? html`${this.mode === 'scheduled'
                                  ? 'Created'
                                  : 'Sent'}
                                <temba-date
                                  value=${broadcast.created_on}
                                  display="datetime"
                                ></temba-date>`
                            : null}
                          ${broadcast.created_by
                            ? html`<span>by ${broadcast.created_by}</span>`
                            : null}
                        </div>`
                      : null}
                  </div>
                  ${showActions
                    ? html`<div class="detail-actions">
                        ${this.canEdit
                          ? html`<button
                              class="menu-button"
                              @click=${this.handleEditClicked}
                            >
                              Edit
                            </button>`
                          : null}
                        ${this.canDelete
                          ? html`<button
                              class="menu-button destructive"
                              @click=${this.handleDeleteClicked}
                            >
                              Delete
                            </button>`
                          : null}
                      </div>`
                    : null}
                  ${this.renderHeaderStatus(broadcast)}
                  <div
                    class="detail-close"
                    role="button"
                    tabindex="0"
                    aria-label="Close"
                    @click=${this.handleDetailClosed}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this.handleDetailClosed();
                      }
                    }}
                  >
                    <temba-icon name=${Icon.close} size="1.4"></temba-icon>
                  </div>
                </div>

                <div class="detail-body">
                  ${this.mode === 'scheduled' || this.isSending(broadcast)
                    ? html`<div class="detail-status-row">
                        ${this.renderDetailStatus(broadcast)}
                      </div>`
                    : null}

                  <div class="detail-message">
                    <div class="detail-section-title">${msg('Message')}</div>
                    ${broadcast.text
                      ? html`<temba-expression-highlight
                          >${broadcast.text}</temba-expression-highlight
                        >`
                      : null}
                    ${broadcast.attachments?.length
                      ? html`<div class="detail-attachments">
                          ${broadcast.attachments.map(
                            (a) => html`
                              <temba-thumbnail
                                attachment=${attachmentAsString(a)}
                              ></temba-thumbnail>
                            `
                          )}
                        </div>`
                      : null}
                    ${broadcast.quick_replies?.length
                      ? html`<div class="detail-pills">
                          ${broadcast.quick_replies.map(
                            (reply) =>
                              html`<temba-label type="neutral"
                                >${typeof reply === 'string'
                                  ? reply
                                  : (reply.text ?? reply.type)}</temba-label
                              >`
                          )}
                        </div>`
                      : null}
                    ${this.renderContentPills(broadcast)}
                  </div>

                  ${pills.length ||
                  broadcast.exclusions?.length ||
                  broadcast.msg_count != null
                    ? html`
                        <div class="detail-section-row">
                          <div class="detail-section-title">
                            ${msg('Recipients')}
                          </div>
                          ${this.renderDetailCount(broadcast)}
                        </div>
                        <div class="detail-pills">${pills}</div>
                        ${broadcast.exclusions?.length
                          ? html`<div class="detail-exclusions">
                              ${broadcast.exclusions.map(
                                (line) => html`<div>${line}</div>`
                              )}
                            </div>`
                          : null}
                      `
                    : null}
                </div>
              </div>
            `
          : null}
      </temba-dialog>
    `;
  }

  public render(): TemplateResult {
    return html`${super.render()}${this.renderDetail()}`;
  }
}
