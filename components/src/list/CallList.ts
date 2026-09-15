import { css, html, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { ContentList, ContentListColumn } from './ContentList';
import { Icon } from '../Icons';
import { Call } from '../interfaces';
import { formatDuration } from '../utils';

/** Call status → status-pill kind. The pill's label is the server's
 * localized `status_display`, which folds in the error reason. */
const STATUS_KINDS: { [status: string]: string } = {
  pending: 'pending',
  queued: 'pending',
  wired: 'pending',
  in_progress: 'pending',
  completed: 'active',
  errored: 'warning',
  failed: 'error'
};

/**
 * Call CRUDL list — drop-in replacement for the rapidpro
 * `ivr/call_list.html` table. Reverse-chronological; each row leads
 * with an icon for the call's direction, then the contact, the
 * call's status, how long it lasted, and when it was made with an
 * optional channel-log link. Rows navigate to the contact. The
 * endpoint has no search, so the search box is hidden.
 */
export class CallList extends ContentList<Call> {
  static get styles() {
    return css`
      ${ContentList.styles}
      .contact-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .duration {
        font-variant-numeric: tabular-nums;
      }
      /* Created cell — the date with an optional channel-log icon to
         its right, matching the message list's sent cell. */
      .created-cell {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
      }
      .call-log {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        padding: 2px;
        border-radius: var(--r-sm);
        color: var(--text-3);
        text-decoration: none;
      }
      .call-log:hover {
        background: var(--sunken);
        color: var(--text-1);
      }
      .call-log temba-icon {
        --icon-color: currentColor;
      }
    `;
  }

  protected defaultEmptyMessage(): string {
    return msg('No calls');
  }

  constructor() {
    super();
    this.valueKey = 'uuid';
    this.searchable = false;
    this.minTableWidth = '520px';
  }

  protected buildColumns(): ContentListColumn[] {
    return [
      {
        key: 'contact',
        label: msg('Contact'),
        grow: true,
        minWidth: '160px',
        pinned: true
      },
      { key: 'status', label: msg('Status') },
      {
        key: 'duration',
        label: msg('Duration'),
        align: 'right'
      },
      {
        key: 'created_on',
        label: msg('Created'),
        align: 'right'
      }
    ];
  }

  /** Incoming calls lead with the incoming-call icon, outgoing ones
   * with the plain phone. */
  protected getRowIcon(item: Call): string | null {
    return item.direction === 'in' ? Icon.incoming_call : Icon.call;
  }

  /** Rows navigate to the call's contact. */
  protected getRowHref(item: Call): string | null {
    const uuid = item.contact?.uuid;
    return uuid ? `/contact/read/${uuid}/` : null;
  }

  protected renderCell(
    item: Call,
    column: ContentListColumn
  ): TemplateResult | string {
    switch (column.key) {
      case 'contact': {
        const name = item.contact?.name || '';
        return html`<span class="contact-name" title=${name}>${name}</span>`;
      }
      case 'status':
        return this.renderStatusPill(
          STATUS_KINDS[item.status] || 'neutral',
          item.status_display || item.status || ''
        );
      case 'duration':
        return html`<span class="duration"
          >${formatDuration(item.duration)}</span
        >`;
      case 'created_on':
        return this.renderCreatedCell(item);
      default:
        return super.renderCell(item, column);
    }
  }

  /** The created cell — timedate timestamp with an optional
   * channel-log icon to its right, rendered when the server includes
   * a logs_url on the row (permission- and retention-gated
   * server-side). stopPropagation keeps the row's contact navigation
   * from also firing when the icon is clicked. */
  private renderCreatedCell(item: Call): TemplateResult | string {
    if (!item.created_on) return '';
    return html`
      <div class="created-cell">
        <temba-date value=${item.created_on} display="timedate"></temba-date>
        ${item.logs_url && this.isSafeHref(item.logs_url)
          ? html`
              <a
                class="call-log"
                href=${item.logs_url}
                @click=${(e: MouseEvent) => e.stopPropagation()}
                aria-label="Channel log"
              >
                <temba-icon name=${Icon.log} size="0.95"></temba-icon>
              </a>
            `
          : ''}
      </div>
    `;
  }
}
