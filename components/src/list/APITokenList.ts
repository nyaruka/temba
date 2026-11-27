import { css, html, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { ContentList, ContentListColumn } from './ContentList';
import { Icon } from '../Icons';
import { APIToken, CustomEventType } from '../interfaces';

/**
 * The user's API tokens for the workspace, oldest first. Each row shows
 * the start of the key (the full key is only shown once, when the token is
 * created), when it was created and when it was last used, and a delete
 * button which fires `temba-apitoken-delete` for the host to confirm in a
 * modal. Rows don't navigate anywhere, and there are too few tokens to
 * need search.
 */
export class APITokenList extends ContentList<APIToken> {
  static get styles() {
    return css`
      ${ContentList.styles}
      .key {
        font-family: var(--font-mono, 'Roboto Mono', monospace);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .actions-cell temba-icon {
        flex: 0 0 auto;
        --icon-color: var(--text-3);
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

  protected defaultEmptyMessage(): string {
    return msg('No API tokens');
  }

  constructor() {
    super();
    this.valueKey = 'id';
    this.searchable = false;
    this.minTableWidth = '520px';
  }

  /** Also re-pulls the content menu, since creating or deleting a token
   * changes whether another can be created. */
  public refresh(): void {
    super.refresh();
    const header = this.shadowRoot?.querySelector('temba-page-header') as any;
    header?.refresh();
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

  private handleDelete(item: APIToken, event: MouseEvent): void {
    event.stopPropagation();
    this.fireCustomEvent(CustomEventType.APITokenDelete, { item });
  }

  protected renderCell(
    item: APIToken,
    column: ContentListColumn
  ): TemplateResult | string {
    switch (column.key) {
      case 'key':
        return html`<span class="key">${item.prefix}…</span>`;
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
