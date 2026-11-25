import { css, html, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { state } from 'lit/decorators.js';
import { ContentList, ContentListColumn } from './ContentList';
import { Icon } from '../Icons';
import { APIToken, CustomEventType } from '../interfaces';

/**
 * The user's API tokens for the workspace, oldest first. Each row shows
 * the key with a button to copy it, when it was created and when it was
 * last used, and a delete button which fires `temba-apitoken-delete` for
 * the host to confirm in a modal. Rows don't navigate anywhere, and there
 * are too few tokens to need search.
 */
export class APITokenList extends ContentList<APIToken> {
  static get styles() {
    return css`
      ${ContentList.styles}
      .key-cell {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .key {
        font-family: var(--font-mono, 'Roboto Mono', monospace);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .key-cell temba-icon,
      .actions-cell temba-icon {
        flex: 0 0 auto;
        --icon-color: var(--text-3);
      }
      .key-cell temba-icon.copied {
        --icon-color: var(--success);
      }
      .actions-cell {
        display: flex;
        justify-content: flex-end;
      }
      .actions-cell temba-icon:hover {
        --icon-color: var(--danger);
      }
    `;
  }

  /** The key most recently copied, shown with a check for a moment. */
  @state()
  private copiedKey: string = null;

  private copiedTimer: number = null;

  protected defaultEmptyMessage(): string {
    return msg('No API tokens');
  }

  constructor() {
    super();
    this.valueKey = 'key';
    this.searchable = false;
    this.minTableWidth = '520px';
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearTimeout(this.copiedTimer);
  }

  protected buildColumns(): ContentListColumn[] {
    return [
      {
        key: 'key',
        label: msg('Key'),
        grow: true,
        minWidth: '200px',
        pinned: true
      },
      { key: 'created_on', label: msg('Created'), align: 'right' },
      { key: 'last_used_on', label: msg('Last Used'), align: 'right' },
      { key: 'actions', label: '', align: 'right', width: '40px' }
    ];
  }

  protected getRowIcon(_item: APIToken): string | null {
    return Icon.user_token;
  }

  private handleCopy(item: APIToken, event: MouseEvent): void {
    event.stopPropagation();
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(item.key).then(() => {
      this.copiedKey = item.key;
      window.clearTimeout(this.copiedTimer);
      this.copiedTimer = window.setTimeout(() => {
        this.copiedKey = null;
      }, 1500);
    });
  }

  private handleDelete(item: APIToken, event: MouseEvent): void {
    event.stopPropagation();
    this.fireCustomEvent(CustomEventType.APITokenDelete, { item });
  }

  protected renderCell(
    item: APIToken,
    column: ContentListColumn
  ): TemplateResult | string {
    switch (column.key) {
      case 'key': {
        const copied = this.copiedKey === item.key;
        return html`<div class="key-cell">
          <span class="key">${item.key}</span>
          <temba-icon
            class=${copied ? 'copied' : ''}
            name=${copied ? Icon.check : Icon.copy}
            size="0.95"
            clickable
            aria-label=${msg('Copy')}
            title=${msg('Copy')}
            @click=${(e: MouseEvent) => this.handleCopy(item, e)}
          ></temba-icon>
        </div>`;
      }
      case 'created_on':
        return item.created_on
          ? html`<temba-date
              value=${item.created_on}
              display="timedate"
            ></temba-date>`
          : '';
      case 'last_used_on':
        return item.last_used_on
          ? html`<temba-date
              value=${item.last_used_on}
              display="timedate"
            ></temba-date>`
          : msg('Never');
      case 'actions':
        return html`<div class="actions-cell">
          <temba-icon
            name=${Icon.delete}
            size="0.95"
            clickable
            aria-label=${msg('Delete')}
            title=${msg('Delete')}
            @click=${(e: MouseEvent) => this.handleDelete(item, e)}
          ></temba-icon>
        </div>`;
      default:
        return super.renderCell(item, column);
    }
  }
}
