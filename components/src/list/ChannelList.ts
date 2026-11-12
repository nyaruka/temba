import { css, html, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { property } from 'lit/decorators.js';
import { ContentList, ContentListColumn } from './ContentList';
import { Icon } from '../Icons';
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
  received: number;
  sent: number;
  /** daily incoming and outgoing counts, oldest first */
  activity: { in: number[]; out: number[] };
}

/**
 * Channel CRUDL list. Each row leads with the channel type's full color
 * logo, then name, a badge for a channel that sends slowly, address,
 * received / sent counts and an activity sparkline of sent (with the fill)
 * and received messages. The badge column is only there when a channel on
 * the page has a badge, so the badges line up without reserving space for
 * nothing.
 */
export class ChannelList extends ContentList<ChannelItem> {
  /** help URLs keyed by topic (see get_channel_help_links) */
  @property({ type: Object, attribute: false })
  helpLinks: Record<string, string> = {};

  /** whether any channel on the current page has a speed badge */
  private hasSpeedBadges = false;

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
      .channel-name .name {
        font-weight: var(--w-medium);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .channel-name .disabled {
        color: var(--text-3);
        font-size: 12px;
        text-decoration: none;
        flex: none;
      }
      a.disabled:hover {
        text-decoration: underline;
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
      .num {
        font-variant-numeric: tabular-nums;
        color: inherit;
      }
      .speed {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        height: 20px;
        padding: 0 7px;
        border-radius: 999px;
        border: 1px solid;
        font-size: 11.5px;
        font-weight: var(--w-medium);
        text-decoration: none;
        white-space: nowrap;
      }
      .speed temba-icon {
        --icon-color: currentColor;
        /* the snail is wide and short, so it can be drawn bigger without making the pill taller */
        margin: -3px 0;
      }
      .speed.slow {
        color: var(--warning);
        background: var(--warning-bg);
        border-color: var(--warning-border);
      }
      .speed.very_slow {
        color: var(--danger);
        background: var(--danger-bg);
        border-color: var(--danger-border);
        font-weight: var(--w-semibold);
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
    this.valueKey = 'uuid';
    this.minTableWidth = '640px';
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

    if (this.hasSpeedBadges) {
      columns.push({ key: 'speed', label: '', minWidth: '24px' });
    }

    columns.push(
      { key: 'address', label: msg('Address'), minWidth: '120px', grow: true },
      {
        key: 'received',
        label: msg('Received'),
        minWidth: '72px',
        align: 'right'
      },
      { key: 'sent', label: msg('Sent'), minWidth: '72px', align: 'right' },
      {
        key: 'activity',
        label: msg('Activity'),
        width: '120px',
        align: 'right'
      }
    );
    return columns;
  }

  protected prepareItems(items: ChannelItem[]): ChannelItem[] {
    const hasSpeedBadges = items.some((item) => !!item.speed);
    if (hasSpeedBadges !== this.hasSpeedBadges) {
      this.hasSpeedBadges = hasSpeedBadges;
      this.refreshColumns();
    }
    return items;
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

  private renderSpeed(item: ChannelItem): TemplateResult | string {
    if (!item.speed) {
      return '';
    }
    const url =
      this.helpLinks?.['channels.throughput'] || this.helpLinks?.['channels'];
    const verySlow = item.speed === 'very_slow';
    return this.renderHelpLink(
      url,
      `speed ${item.speed}`,
      html`<temba-icon
          name=${verySlow ? Icon.channel_very_slow : Icon.channel_slow}
          size=${verySlow ? '1.4' : '1.05'}
        ></temba-icon
        >${verySlow ? msg('Very slow') : msg('Slow')}`,
      verySlow
        ? msg('Sends very slowly, so large broadcasts can take hours.')
        : msg('Sends slowly, so large broadcasts take longer.')
    );
  }

  protected renderCell(
    item: ChannelItem,
    column: ContentListColumn
  ): TemplateResult | string {
    switch (column.key) {
      case 'name':
        return html`<span class="channel-name"
          >${renderChannelLogo(item.type, item.name, 24)}<span
            class="name"
            title=${item.name || ''}
            >${item.name || ''}</span
          >${item.is_enabled
            ? null
            : this.renderHelpLink(
                this.helpLinks?.['channels.disabling'],
                'disabled',
                msg('Disabled'),
                ''
              )}</span
        >`;
      case 'speed':
        return this.renderSpeed(item);
      case 'address':
        return html`<span class="address">${item.address || ''}</span>`;
      case 'received':
        return html`<span class="num"
          >${formatCount(item.received ?? 0)}</span
        >`;
      case 'sent':
        return html`<span class="num">${formatCount(item.sent ?? 0)}</span>`;
      case 'activity': {
        // like flows, a channel with nothing in the window shows no sparkline
        const sent = item.activity?.out || [];
        const received = item.activity?.in || [];
        if (![...sent, ...received].some((v) => v > 0)) {
          return '';
        }
        return renderSparkline(sent, received);
      }
      default:
        return super.renderCell(item, column);
    }
  }
}
