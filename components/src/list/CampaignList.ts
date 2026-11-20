import { css, html, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { ContentList, ContentListColumn } from './ContentList';
import { Icon } from '../Icons';
import { Campaign, CustomEventType, ObjectReference } from '../interfaces';
import { formatCount } from '../utils';

/**
 * Campaign CRUDL list — drop-in replacement for the rapidpro
 * `campaigns/campaign_list.html` table. Every row leads with the
 * campaign clock icon (from the styleguide's campaign list), then
 * name, the group pill the campaign schedules against, contact /
 * event counts, and the last-updated date.
 */
export class CampaignList extends ContentList<Campaign> {
  static get styles() {
    return css`
      ${ContentList.styles}
      .campaign-name {
        color: inherit;
        font-weight: var(--w-medium);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .num {
        font-variant-numeric: tabular-nums;
        color: inherit;
      }
    `;
  }

  protected defaultEmptyMessage(): string {
    return msg('No campaigns');
  }

  protected defaultSearchPlaceholder(): string {
    return msg('Search campaigns');
  }

  constructor() {
    super();
    this.bulkActions = [
      {
        key: 'archive',
        get label() {
          return msg('Archive');
        },
        icon: Icon.archive
      }
    ];
  }

  protected buildColumns(): ContentListColumn[] {
    return [
      {
        key: 'name',
        label: msg('Name'),
        sortable: true,
        minWidth: '160px',
        maxWidth: '280px',
        pinned: true
      },
      {
        key: 'group',
        label: msg('Group'),
        minWidth: '120px',
        maxWidth: '220px'
      },
      {
        key: 'contacts',
        label: msg('Contacts'),
        sortable: true,
        minWidth: '72px',
        align: 'right'
      },
      {
        key: 'events',
        label: msg('Events'),
        sortable: true,
        minWidth: '64px',
        align: 'right'
      },
      {
        key: 'modified_on',
        label: msg('Updated'),
        sortable: true,
        minWidth: '96px',
        maxWidth: '150px',
        align: 'right'
      }
    ];
  }

  protected getRowIcon(_item: Campaign): string | null {
    return Icon.campaign;
  }

  protected getRowHref(item: Campaign): string | null {
    return item?.uuid ? `/campaign/read/${item.uuid}/` : null;
  }

  /** Clicking the group pill opens that group's contact list rather
   * than falling through to the row click (which opens the campaign). */
  private handleGroupClick(group: ObjectReference, event: MouseEvent): void {
    // Stop the click from bubbling to the row's navigation handler.
    event.stopPropagation();
    if (!group?.uuid) return;
    const href = `/contact/group/${group.uuid}/`;
    // Guard the JSON-driven href against open-redirect, same as the
    // row-click path in ContentList.handleRowClick.
    if (!this.isSafeHref(href)) return;
    // Meta/ctrl-click opens a new tab, matching ordinary links and the
    // row-click behavior.
    if (event.metaKey || event.ctrlKey) {
      window.open(href, '_blank');
      return;
    }
    this.fireCustomEvent(CustomEventType.Redirected, { url: href });
  }

  protected renderCell(
    item: Campaign,
    column: ContentListColumn
  ): TemplateResult | string {
    switch (column.key) {
      case 'name':
        return html`<span class="campaign-name" title=${item.name || ''}
          >${item.name || ''}</span
        >`;
      case 'group':
        return item.group
          ? html`<temba-label
              type="group"
              icon=${Icon.group}
              clickable
              @click=${(e: MouseEvent) => this.handleGroupClick(item.group, e)}
              >${item.group.name}</temba-label
            >`
          : '';
      case 'events':
        return html`<span class="num">${formatCount(item.events ?? 0)}</span>`;
      case 'contacts':
        return html`<span class="num"
          >${formatCount(item.contacts ?? 0)}</span
        >`;
      case 'modified_on':
        return item.modified_on
          ? html`<temba-date
              value=${item.modified_on}
              display="timedate"
            ></temba-date>`
          : '';
      default:
        return super.renderCell(item, column);
    }
  }
}
