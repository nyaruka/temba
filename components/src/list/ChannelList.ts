import { css, html, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { property } from 'lit/decorators.js';
import { ContentList, ContentListColumn } from './ContentList';
import { formatCount } from '../utils';
import { renderSparkline, sparklineStyles } from './sparkline';
import { channelLogoStyles, renderChannelLogo } from '../channels/ChannelLogo';

/** A channel as served by the internal channels endpoint */
export interface ChannelItem {
  uuid: string;
  name: string;
  /** the channel type's code, e.g. "TG" */
  type: string;
  address: string;
  is_enabled: boolean;
  /** whether the channel sends slowly - null when it doesn't */
  speed: 'slow' | 'very_slow' | null;
  /** whether the channel is working, as its read page's status card shows it */
  health: ChannelHealth;
  received: number;
  sent: number;
  /** daily incoming and outgoing counts, and the percentage of text messages sent which failed, oldest first */
  activity: { in: number[]; out: number[]; failed: number[] };
}

/** A channel's health - its tone is empty when the channel is disabled */
export interface ChannelHealth {
  tone: 'good' | 'warn' | 'bad' | '';
  value: string;
  note: string;
  cause: string | null;
}

/**
 * Channel CRUDL list. Each row leads with the channel type's full color
 * logo, then name, status, address, received / sent counts and an activity
 * sparkline of all messages, or for a channel whose status is down to its
 * failures, of the share that failed, in red. The status is the
 * channel's health as a light and a word, like its read page's status card,
 * except that a healthy channel which sends slowly says so instead.
 */
export class ChannelList extends ContentList<ChannelItem> {
  /** help URLs keyed by topic (see get_channel_help_links) */
  @property({ type: Object, attribute: false })
  helpLinks: Record<string, string> = {};

  static get styles() {
    return css`
      ${ContentList.styles}
      ${sparklineStyles}
      ${channelLogoStyles}
      .channel-name {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      /* a provider badge, and its ring, hang off the logo's corner - the name ellipsizes itself, so the cell needn't
         clip to do it */
      .cell-inner:has(> .channel-name) {
        overflow: visible;
      }
      tr.row.disabled .cell {
        color: var(--text-3);
      }
      tr.row.disabled .channel-logo {
        filter: grayscale(1);
        opacity: 0.55;
      }
      .address {
        color: var(--text-2);
        font-variant-numeric: tabular-nums;
      }
      /* the period tip around a sparkline hugs it, so only the sparkline shows it */
      td temba-tip {
        display: inline-block;
        vertical-align: middle;
      }
      .failing .sparkline .line {
        stroke: var(--danger);
      }
      .failing .sparkline .area {
        fill: var(--danger-bg);
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-weight: var(--w-medium);
        text-decoration: none;
        white-space: nowrap;
      }
      a.status:hover {
        text-decoration: underline;
      }
      /* the tone shows as a light beside the word, as on the dashboard's status card */
      .status::before {
        content: '';
        flex: none;
        width: 7px;
        height: 7px;
        /* the cell clips what overflows it, so the halo needs room of its own */
        margin-left: 3px;
        border-radius: 999px;
        background: var(--tone);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone) 20%, transparent);
      }
      .status.good {
        --tone: var(--success);
        color: var(--success);
      }
      /* the light takes the dashboard card's brighter amber, as warning text reads as brown at that size */
      .status.warn {
        --tone: #dd8a0c;
        color: var(--warning);
      }
      .status.bad {
        --tone: var(--danger);
        color: var(--danger);
      }
      .status.off {
        --tone: var(--text-3);
        color: var(--text-3);
        font-weight: normal;
      }
      .status.off::before {
        box-shadow: none;
      }
    `;
  }

  protected defaultEmptyMessage(): string {
    return msg('No channels');
  }

  protected defaultSearchPlaceholder(): string {
    return msg('Search channels');
  }

  constructor() {
    super();
    this.minTableWidth = '640px';
  }

  /** The counts and sparkline are of the last 14 days, which hovering them says */
  private get periodTip(): string {
    return msg('Last 14 days');
  }

  protected buildColumns(): ContentListColumn[] {
    const columns: ContentListColumn[] = [
      {
        key: 'name',
        label: msg('Name'),
        minWidth: '180px',
        maxWidth: '320px',
        pinned: true
      }
    ];

    columns.push(
      { key: 'status', label: msg('Status'), minWidth: '110px' },
      { key: 'address', label: msg('Address'), minWidth: '120px', grow: true },
      {
        key: 'received',
        label: msg('Received'),
        minWidth: '72px',
        align: 'right',
        tip: this.periodTip
      },
      {
        key: 'sent',
        label: msg('Sent'),
        minWidth: '72px',
        align: 'right',
        tip: this.periodTip
      },
      {
        key: 'activity',
        label: msg('Activity'),
        width: '120px',
        align: 'right',
        tip: this.periodTip
      }
    );
    return columns;
  }

  protected getRowHref(item: ChannelItem): string | null {
    return item?.uuid ? `/channels/channel/read/${item.uuid}/` : null;
  }

  protected getRowClass(item: ChannelItem): string {
    return item.is_enabled ? '' : 'disabled';
  }

  /** A help link opens on its own rather than also opening the row */
  private stopRowClick(event: MouseEvent): void {
    event.stopPropagation();
  }

  private renderHelpLink(
    url: string,
    cls: string,
    content: TemplateResult | string,
    title: string
  ): TemplateResult {
    if (!url) {
      return html`<span class=${cls} title=${title}>${content}</span>`;
    }
    return html`<a
      class=${cls}
      href=${url}
      target="_blank"
      rel="noopener"
      title=${title}
      @click=${this.stopRowClick}
      >${content}</a
    >`;
  }

  private renderPeriodTip(content: TemplateResult): TemplateResult {
    return html`<temba-tip text=${this.periodTip} position="top"
      >${content}</temba-tip
    >`;
  }

  private renderStatus(item: ChannelItem): TemplateResult {
    if (!item.is_enabled) {
      return this.renderHelpLink(
        this.helpLinks?.['channels.disabling'],
        'status off',
        item.health?.value || msg('Disabled'),
        item.health?.note || ''
      );
    }

    // slowness is only worth pointing out when nothing else is wrong, and in amber however slow, as red is kept for
    // problems with its health
    if (item.health?.tone === 'good' && item.speed) {
      const verySlow = item.speed === 'very_slow';
      return this.renderHelpLink(
        this.helpLinks?.['channels.throughput'] || this.helpLinks?.['channels'],
        'status warn',
        verySlow ? msg('Very slow') : msg('Slow'),
        verySlow
          ? msg('Sends very slowly, so large broadcasts can take hours.')
          : msg('Sends slowly, so large broadcasts take longer.')
      );
    }

    return html`<span
      class="status ${item.health?.tone || ''}"
      title=${item.health?.note || ''}
      >${item.health?.value || ''}</span
    >`;
  }

  protected renderCell(
    item: ChannelItem,
    column: ContentListColumn
  ): TemplateResult | string {
    switch (column.key) {
      case 'name':
        return html`<span class="channel-name"
          >${renderChannelLogo(item.type, item.name, 24)}<span
            class="item-name"
            title=${item.name || ''}
            >${item.name || ''}</span
          ></span
        >`;
      case 'status':
        return this.renderStatus(item);
      case 'address':
        return html`<span class="address">${item.address || ''}</span>`;
      case 'received':
        return html`<span class="num"
          >${formatCount(item.received ?? 0)}</span
        >`;
      case 'sent':
        return html`<span class="num">${formatCount(item.sent ?? 0)}</span>`;
      case 'activity': {
        // a channel whose status is down to its failures shows how much of what it sent failed
        const failed = item.activity?.failed || [];
        if (item.health?.cause === 'failing' && failed.some((v) => v > 0)) {
          return this.renderPeriodTip(
            html`<span class="failing">${renderSparkline(failed)}</span>`
          );
        }

        // and otherwise all its messages - like flows, a channel with nothing in the window shows no sparkline
        const sent = item.activity?.out || [];
        const received = item.activity?.in || [];
        const total = sent.map((v, i) => v + (received[i] || 0));
        if (!total.some((v) => v > 0)) {
          return '';
        }
        return this.renderPeriodTip(renderSparkline(total));
      }
      default:
        return super.renderCell(item, column);
    }
  }
}
