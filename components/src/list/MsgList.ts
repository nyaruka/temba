import { html, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { ContentList, ContentListColumn } from './ContentList';
import { Icon } from '../Icons';
import { Msg } from '../interfaces';

/**
 * Message CRUDL list — drop-in replacement for the rapidpro
 * `msgs/msg_list.html` table. Reverse-chronological; the message
 * cell carries the body text with its attachment thumbnails right
 * after it and the flow / label pills pushed to the trailing edge,
 * with a timedate timestamp closing the row.
 */
export class MsgList extends ContentList<Msg> {
  protected defaultEmptyMessage(): string {
    return msg('No messages');
  }

  protected defaultSearchPlaceholder(): string {
    return msg('Search messages');
  }

  constructor() {
    super();
    // Messages page 100 at a time, matching rapidpro's msg list.
    this.pageSize = 100;
    // Auto layout so the Contact / Sent columns size to their content
    // (no stranded width on the short Sent value), while the Message
    // column is a `grow` column — under auto layout it claims zero
    // intrinsic width and ellipsis-truncates against the leftover space
    // rather than stretching the table. minTableWidth lets the list
    // scroll horizontally once the container is too narrow to keep the
    // columns usable, rather than clipping anything.
    this.minTableWidth = '640px';
    this.bulkActions = [
      {
        key: 'label',
        get label() {
          return msg('Label');
        },
        icon: Icon.label,
        labelsEndpoint: '/api/v2/labels.json'
      },
      // Archive trails the reversible actions; Delete, when offered,
      // always goes last.
      {
        key: 'archive',
        get label() {
          return msg('Archive');
        },
        icon: Icon.archive
      },
      {
        key: 'delete',
        get label() {
          return msg('Delete');
        },
        icon: Icon.delete,
        destructive: true
      }
    ];
  }

  protected buildColumns(): ContentListColumn[] {
    return [
      {
        key: 'contact',
        label: msg('Contact'),
        width: '130px',
        pinned: true,
        resizable: true
      },
      { key: 'text', label: msg('Message'), grow: true },
      // Sent is deliberately not resizable: it's the last column, so its
      // only possible handle would sit on the table's outer edge (Message
      // is the grow column and owns the boundary between them).
      {
        key: 'created_on',
        label: msg('Sent'),
        align: 'right'
      }
    ];
  }

  /** Rows navigate to the message's contact. Returning the href here
   * also marks the row `clickable`, so it carries the pointer cursor on
   * hover. */
  protected getRowHref(item: Msg): string | null {
    const uuid = item.contact?.uuid;
    return uuid ? `/contact/read/${uuid}/` : null;
  }

  protected renderCell(
    item: Msg,
    column: ContentListColumn
  ): TemplateResult | string {
    switch (column.key) {
      case 'contact': {
        const contact = item.contact || {};
        return contact.name || contact.urn || '';
      }
      case 'text':
        return this.renderMessageCell(
          this.renderMessageText(item),
          item.attachments,
          this.renderPills(item)
        );
      case 'created_on':
        return this.renderDateWithLog(item, 'msg');
      default:
        return super.renderCell(item, column);
    }
  }

  /** The message body — plain text, or an opt-in pill when an
   * opt-in request carries no text of its own. */
  private renderMessageText(item: Msg): TemplateResult | string {
    const isOptin = item.msg_type === 'optin' || item.type === 'optin';
    if (!item.text && isOptin) {
      return this.renderStatusPill('pending', 'opt-in request');
    }
    return item.text || '';
  }

  /** Flow + label pills for a row, pushed to the trailing edge of
   * the message cell, or '' when the row carries none. The flow pill
   * opens its editor and each label pill opens that label's filtered
   * message view — matching the rapidpro msg list. `clickable` gives
   * the hover affordance; `goto` routes the click through the SPA and
   * stops propagation so the row's own contact navigation doesn't also
   * fire. */
  private renderPills(item: Msg): TemplateResult | string {
    const labels = item.labels || [];
    if (!item.flow && !labels.length) return '';
    return html`
      <div class="cell-pills">
        ${item.flow
          ? html`<temba-label
              type="flow"
              icon=${Icon.flow}
              href="/flow/editor/${item.flow.uuid}/"
              onclick="goto(event)"
              clickable
              >${item.flow.name}</temba-label
            >`
          : null}
        ${labels.map(
          (l) => html`
            <temba-label
              type="label"
              icon=${Icon.label}
              href="/msg/filter/${l.uuid}/"
              onclick="goto(event)"
              clickable
              >${l.name}</temba-label
            >
          `
        )}
      </div>
    `;
  }
}
