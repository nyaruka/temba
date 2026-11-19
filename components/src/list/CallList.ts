import { css, html, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { ContentList, ContentListColumn } from './ContentList';
import { Icon } from '../Icons';
import { Call } from '../interfaces';
import { formatDuration } from '../utils';

/** Call status → status-pill kind. */
const STATUS_KINDS: { [status: string]: string } = {
  pending: 'pending',
  queued: 'pending',
  wired: 'pending',
  in_progress: 'pending',
  completed: 'active',
  errored: 'warning',
  failed: 'error'
};

/** Localized label for a call status slug. Resolved at render time so
 * a locale change re-renders it. */
const statusLabel = (status: string): string => {
  switch (status) {
    case 'pending':
      return msg('Pending');
    case 'queued':
      return msg('Queued');
    case 'wired':
      return msg('Wired');
    case 'in_progress':
      return msg('In Progress');
    case 'completed':
      return msg('Complete');
    case 'errored':
      return msg('Errored');
    case 'failed':
      return msg('Failed');
    default:
      return status || '';
  }
};

/** Localized label for why an errored / failed call didn't connect. */
const errorReasonLabel = (reason: string): string => {
  switch (reason) {
    case 'provider':
      return msg('Provider');
    case 'busy':
      return msg('Busy');
    case 'no_answer':
      return msg('No Answer');
    case 'machine':
      return msg('Answering Machine');
    case 'suspended':
      return msg('Workspace suspended');
    default:
      return reason || '';
  }
};

/**
 * Call CRUDL list — drop-in replacement for the rapidpro
 * `ivr/call_list.html` table. Reverse-chronological; each row leads
 * with an icon for the call's direction, then the contact, the
 * call's status, how long it lasted, and when it was made with a
 * channel-log link when the host enables them. Rows navigate to the contact. The
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
    `;
  }

  protected defaultEmptyMessage(): string {
    return msg('No calls');
  }

  constructor() {
    super();
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
      case 'status': {
        // an errored or failed call carries the reason, e.g. "Errored (No Answer)"
        const label = item.error_reason
          ? `${statusLabel(item.status)} (${errorReasonLabel(item.error_reason)})`
          : statusLabel(item.status);
        return this.renderStatusPill(
          STATUS_KINDS[item.status] || 'neutral',
          label
        );
      }
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

  /** The created cell — timedate timestamp with the channel-log icon
   * to its right when the host page has enabled log links. */
  private renderCreatedCell(item: Call): TemplateResult | string {
    if (!item.created_on) return '';
    return html`
      <div class="created-cell">
        <temba-date value=${item.created_on} display="timedate"></temba-date>
        ${this.renderChannelLogLink(item, 'call')}
      </div>
    `;
  }
}
