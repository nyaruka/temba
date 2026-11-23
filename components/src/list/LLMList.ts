import { css, html, TemplateResult } from 'lit';
import { msg, str } from '@lit/localize';
import { property } from 'lit/decorators.js';
import { ContentList, ContentListColumn } from './ContentList';
import { Icon } from '../Icons';
import { CustomEventType, LLM } from '../interfaces';
import { formatCount } from '../utils';

/**
 * AI model CRUDL list — drop-in replacement for the rapidpro
 * `ai/llm_list.html` table. Each row leads with its provider's icon,
 * then the name, the provider's model, and how many flows use it.
 * Models open in an update modal rather than a page of their own, so
 * rows carry no href — the host listens for `temba-row-click` and
 * opens the modal itself, and likewise for the usages link
 * (`temba-llm-usages`). Deleting a model is done from its update modal.
 */
export class LLMList extends ContentList<LLM> {
  static get styles() {
    return css`
      ${ContentList.styles}
      .llm-name {
        font-weight: var(--w-medium);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .model {
        color: var(--text-2);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .usages {
        color: var(--accent);
        cursor: pointer;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .usages:hover {
        text-decoration: underline;
      }
    `;
  }

  /** whether rows open the update modal */
  @property({ type: Boolean })
  editable = false;

  protected defaultEmptyMessage(): string {
    return msg('No models');
  }

  constructor() {
    super();
    this.valueKey = 'uuid';
    this.searchable = false;
    this.minTableWidth = '480px';
  }

  protected buildColumns(): ContentListColumn[] {
    return [
      {
        key: 'name',
        label: msg('Name'),
        sortable: true,
        minWidth: '160px',
        maxWidth: '320px',
        pinned: true
      },
      { key: 'model', label: msg('Model'), minWidth: '140px', grow: true },
      {
        key: 'usages',
        label: msg('Usages'),
        sortable: true,
        minWidth: '72px',
        align: 'right'
      }
    ];
  }

  protected getRowIcon(item: LLM): string | null {
    return item.icon || Icon.ai;
  }

  protected isRowClickable(_item: LLM): boolean {
    return this.editable;
  }

  private handleUsagesClick(item: LLM, event: MouseEvent): void {
    // keep the click from also opening the update modal
    event.stopPropagation();
    this.fireCustomEvent(CustomEventType.LLMUsages, { item });
  }

  protected renderCell(
    item: LLM,
    column: ContentListColumn
  ): TemplateResult | string {
    switch (column.key) {
      case 'name':
        return html`<span class="llm-name" title=${item.name || ''}
          >${item.name || ''}</span
        >`;
      case 'model':
        return html`<span class="model" title=${item.model || ''}
          >${item.model || ''}</span
        >`;
      case 'usages': {
        if (!item.usages) return '';
        const count = formatCount(item.usages);
        return html`<span
          class="usages"
          @click=${(e: MouseEvent) => this.handleUsagesClick(item, e)}
          >${item.usages === 1
            ? msg(str`${count} use`)
            : msg(str`${count} uses`)}</span
        >`;
      }
      default:
        return super.renderCell(item, column);
    }
  }
}
