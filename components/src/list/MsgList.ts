import { css, html, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { ContentList, ContentListColumn } from './ContentList';
import { Icon } from '../Icons';
import { Msg } from '../interfaces';
import { attachmentAsString } from '../utils';

/**
 * Message CRUDL list — drop-in replacement for the rapidpro
 * `msgs/msg_list.html` table. Reverse-chronological; the message
 * cell carries the body text with its attachment thumbnails right
 * after it and the flow / label pills pushed to the trailing edge,
 * with a timedate timestamp closing the row.
 */
export class MsgList extends ContentList<Msg> {
  static get styles() {
    return css`
      ${ContentList.styles}
      /* The message cell holds the body text on the leading edge, with
         its attachment thumbnails and the flow / label pills grouped
         and pushed to the trailing edge. The text sizes to content and
         ellipsizes when squeezed — resolved per row, so a busy row
         doesn't widen a column for all of them. */
      .msg-cell {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .msg-text {
        flex: 0 1 auto;
        /* A small floor so the message keeps a few words even on a
           row whose meta is wide — the message yields most of its
           width to the attachments and pills before they clip. */
        min-width: 80px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* Attachment thumbnails, immediately after the message text. */
      .msg-attachments {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      /* Flow + label pills, pushed to the trailing edge of the cell. */
      .cell-pills {
        flex: 0 0 auto;
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      /* Attachment thumbnails are sized well below the 44px row so
         they never grow its height — a small square preview rather
         than the chat history's full-size thumbnail. --thumb-icon-
         padding shrinks temba-thumbnail's non-image fallback (the
         document/video icon box) to match. The max-height clamp is
         a backstop for any type that still carries its own larger
         intrinsic size (e.g. a location map). */
      .msg-thumb {
        --thumb-size: 24px;
        --thumb-padding: 2px;
        --thumb-icon-padding: 4px;
        max-height: 36px;
        overflow: hidden;
      }
      /* Sent cell — the date with an optional channel-log icon to
         its right. The cell stays right-aligned (the column's own
         alignment) and uses a flex row so the icon sits flush
         against the date with a small gap. */
      .sent-cell {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
      }
    `;
  }

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
        return this.renderMessageCell(item);
      case 'created_on':
        return this.renderSentCell(item);
      default:
        return super.renderCell(item, column);
    }
  }

  /** The message cell — body text on the leading edge with its
   * attachment thumbnails immediately after it, and the flow / label
   * pills pushed to the trailing edge. Each piece sizes to content, so
   * the split is resolved independently for every row. A message with
   * no text renders no text span at all — otherwise its min-width
   * would strand an attachment-only row's thumbnails away from the
   * leading edge. */
  private renderMessageCell(item: Msg): TemplateResult {
    const text = this.renderMessageText(item);
    return html`
      <div class="msg-cell">
        ${text ? html`<span class="msg-text">${text}</span>` : ''}
        ${this.renderAttachments(item)}${this.renderPills(item)}
      </div>
    `;
  }

  /** The sent cell — timedate timestamp with the channel-log icon to
   * its right when the host page has enabled log links. */
  private renderSentCell(item: Msg): TemplateResult | string {
    if (!item.created_on) return '';
    return html`
      <div class="sent-cell">
        <temba-date value=${item.created_on} display="timedate"></temba-date>
        ${this.renderChannelLogLink(item, 'msg')}
      </div>
    `;
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

  /** Attachment thumbnails for a row, immediately after the message
   * text, or '' when the row carries none. */
  private renderAttachments(item: Msg): TemplateResult | string {
    const attachments = item.attachments || [];
    if (!attachments.length) return '';
    return html`
      <div class="msg-attachments">
        ${attachments.map(
          (a) => html`
            <temba-thumbnail
              class="msg-thumb"
              attachment=${attachmentAsString(a)}
            ></temba-thumbnail>
          `
        )}
      </div>
    `;
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
