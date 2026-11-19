import { css, html, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { property, state } from 'lit/decorators.js';
import { Icon } from '../Icons';
import { CustomEventType, Shortcut } from '../interfaces';
import { ContentList, ContentListColumn } from './ContentList';
import {
  buttonChrome,
  buttonChromeActive,
  buttonChromeDestructive,
  buttonChromeDestructiveHover,
  buttonChromeHover
} from '../styles/buttonChrome';

/**
 * Shortcut management list used by the Tickets knowledge page. This is
 * intentionally separate from `temba-shortcuts`, which is the compact picker
 * shown while composing a ticket reply.
 */
export class ShortcutContentList extends ContentList<Shortcut> {
  static get styles() {
    return css`
      ${ContentList.styles}

      tr.row {
        cursor: pointer;
      }

      .table-frame {
        margin-left: -20px;
      }

      tr.header th:first-child,
      tr.row td:first-child {
        padding-left: 20px;
      }

      tr.header th:last-child,
      tr.row td:last-child {
        padding-right: 20px;
      }

      .shortcut-name {
        font-weight: var(--w-medium);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .shortcut-text {
        color: var(--text-2);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .detail {
        display: flex;
        flex-direction: column;
      }

      .detail-header {
        align-items: center;
        border-bottom: 1px solid var(--border);
        display: flex;
        gap: 12px;
        padding: 1em;
      }

      .detail-title-block {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }

      .detail-title {
        color: var(--text-1);
        font-size: 15.5px;
        font-weight: var(--w-semibold);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .detail-meta {
        color: var(--text-3);
        font-size: 0.9em;
      }

      .detail-actions {
        align-items: center;
        display: flex;
        flex-shrink: 0;
        gap: 8px;
      }

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

      .detail-close {
        align-items: center;
        border-radius: var(--r-sm);
        color: var(--text-3);
        cursor: pointer;
        display: inline-flex;
        flex-shrink: 0;
        height: 28px;
        justify-content: center;
        user-select: none;
        width: 28px;
      }

      .detail-close:hover {
        background: var(--sunken);
        color: var(--text-1);
      }

      .detail-close temba-icon {
        --icon-color: currentColor;
      }

      .detail-body {
        max-height: calc(100vh - 300px);
        overflow-y: auto;
        padding: 1.25em 1.75em;
      }

      .detail-response {
        background: color-mix(in srgb, var(--sunken) 45%, var(--surface));
        border: 1px solid var(--border);
        border-radius: var(--r);
        color: var(--text-1);
        line-height: 1.5;
        padding: 0.9em 1em 1em;
      }

      /* pre-wrap lives on the text node's own element so the template's
         indentation around the interpolation isn't rendered as leading
         whitespace */
      .detail-text {
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      .detail-section-title {
        color: var(--text-3);
        font-size: 0.75em;
        font-weight: var(--w-semibold);
        letter-spacing: 0.05em;
        margin-bottom: 0.6em;
        text-transform: uppercase;
      }
    `;
  }

  @property({ type: Boolean })
  editable = false;

  @property({ type: Boolean })
  deletable = false;

  @state()
  private detailShortcut: Shortcut = null;

  protected defaultEmptyMessage(): string {
    return msg('No shortcuts');
  }

  protected defaultSearchPlaceholder(): string {
    return msg('Search shortcuts');
  }

  protected buildColumns(): ContentListColumn[] {
    return [
      {
        key: 'name',
        label: msg('Name'),
        minWidth: '140px',
        maxWidth: '240px'
      },
      { key: 'text', label: msg('Text'), minWidth: '240px', grow: true }
    ];
  }

  public connectedCallback(): void {
    super.connectedCallback();
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
    const shortcut = event.detail?.item as Shortcut;
    if (shortcut) {
      this.detailShortcut = shortcut;
    }
  };

  private handleDetailClosed = (): void => {
    this.detailShortcut = null;
  };

  private handleEditClicked(): void {
    const shortcut = this.detailShortcut;
    this.detailShortcut = null;
    this.fireCustomEvent(CustomEventType.ShortcutEdit, { item: shortcut });
  }

  private handleDeleteClicked(): void {
    const shortcut = this.detailShortcut;
    this.detailShortcut = null;
    this.fireCustomEvent(CustomEventType.ShortcutDelete, { item: shortcut });
  }

  private handleActivationKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.handleDetailClosed();
    }
  }

  protected renderCell(
    shortcut: Shortcut,
    column: ContentListColumn
  ): TemplateResult | string {
    switch (column.key) {
      case 'name':
        return html`<span class="shortcut-name" title=${shortcut.name || ''}
          >${shortcut.name || ''}</span
        >`;
      case 'text':
        return html`<span class="shortcut-text" title=${shortcut.text || ''}
          >${shortcut.text || ''}</span
        >`;
      default:
        return super.renderCell(shortcut, column);
    }
  }

  private renderDetail(): TemplateResult {
    const shortcut = this.detailShortcut;

    return html`
      <temba-dialog
        size="xlarge"
        variant="flat"
        primaryButtonName=""
        cancelButtonName=""
        hideOnClick
        ?open=${!!shortcut}
        @temba-dialog-hidden=${this.handleDetailClosed}
        @keyup=${(event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            this.handleDetailClosed();
          }
        }}
      >
        ${shortcut
          ? html`
              <div class="detail">
                <div class="detail-header">
                  <div class="detail-title-block">
                    <div class="detail-title">${shortcut.name}</div>
                    ${shortcut.modified_on
                      ? html`<div class="detail-meta">
                          Modified
                          <temba-date
                            value=${shortcut.modified_on}
                            display="datetime"
                          ></temba-date>
                        </div>`
                      : null}
                  </div>
                  ${this.editable || this.deletable
                    ? html`<div class="detail-actions">
                        ${this.editable
                          ? html`<button
                              type="button"
                              class="menu-button"
                              @click=${this.handleEditClicked}
                            >
                              Edit
                            </button>`
                          : null}
                        ${this.deletable
                          ? html`<button
                              type="button"
                              class="menu-button destructive"
                              @click=${this.handleDeleteClicked}
                            >
                              Delete
                            </button>`
                          : null}
                      </div>`
                    : null}
                  <div
                    class="detail-close"
                    role="button"
                    tabindex="0"
                    aria-label="Close"
                    @click=${this.handleDetailClosed}
                    @keydown=${this.handleActivationKey}
                  >
                    <temba-icon name=${Icon.close} size="1.4"></temba-icon>
                  </div>
                </div>
                <div class="detail-body">
                  <div class="detail-response">
                    <div class="detail-section-title">${msg('Response')}</div>
                    <div class="detail-text">${shortcut.text}</div>
                  </div>
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
