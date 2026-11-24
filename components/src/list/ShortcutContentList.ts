import { css, html, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { property } from 'lit/decorators.js';
import { CustomEventType, Shortcut } from '../interfaces';
import { ContentList, ContentListColumn } from './ContentList';
import { DetailDialogContent, renderDetailButton } from './detailDialog';

/**
 * Shortcut management list used by the Tickets knowledge page. This is
 * intentionally separate from `temba-shortcuts`, which is the compact picker
 * shown while composing a ticket reply.
 */
export class ShortcutContentList extends ContentList<Shortcut> {
  static get styles() {
    return css`
      ${ContentList.styles}

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

      .shortcut-text {
        color: var(--text-2);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .detail-close {
        margin-left: 0;
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
        margin-bottom: 0.6em;
      }
    `;
  }

  @property({ type: Boolean })
  editable = false;

  @property({ type: Boolean })
  deletable = false;

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

  protected get hasDetail(): boolean {
    return true;
  }

  private handleEditClicked(): void {
    this.fireCustomEvent(CustomEventType.ShortcutEdit, {
      item: this.closeDetail()
    });
  }

  private handleDeleteClicked(): void {
    this.fireCustomEvent(CustomEventType.ShortcutDelete, {
      item: this.closeDetail()
    });
  }

  protected renderCell(
    shortcut: Shortcut,
    column: ContentListColumn
  ): TemplateResult | string {
    switch (column.key) {
      case 'name':
        return html`<span class="item-name" title=${shortcut.name || ''}
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

  protected renderDetail(shortcut: Shortcut): DetailDialogContent {
    return {
      title: shortcut.name,
      subtitle: shortcut.modified_on
        ? html`<span
            >Modified
            <temba-date
              value=${shortcut.modified_on}
              display="datetime"
            ></temba-date
          ></span>`
        : null,
      actions:
        this.editable || this.deletable
          ? html`${this.editable
              ? renderDetailButton('Edit', () => this.handleEditClicked())
              : null}${this.deletable
              ? renderDetailButton(
                  'Delete',
                  () => this.handleDeleteClicked(),
                  true
                )
              : null}`
          : null,
      body: html`
        <div class="detail-response">
          <div class="detail-section-title">${msg('Response')}</div>
          <div class="detail-text">${shortcut.text}</div>
        </div>
      `
    };
  }
}
