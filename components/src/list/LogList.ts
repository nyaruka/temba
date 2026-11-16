import { css, html, TemplateResult } from 'lit';
import { msg, str } from '@lit/localize';
import { SplitList } from './SplitList';
import { formatCount } from '../utils';

/**
 * A log as served by the internal endpoints that list them, e.g. a channel's
 * logs or its template syncs
 */
export interface LogItem {
  uuid: string;
  /** the kind of log, e.g. "Message Send" */
  type_display: string;
  is_error: boolean;
  elapsed_ms: number;
  created_on: string;
  /** the log's page */
  url: string;
}

/**
 * Logs, newest first, beside the one selected. Each row is the kind of
 * interaction, marked when it errored, how long it took and when.
 */
export class LogList extends SplitList<LogItem> {
  static get styles() {
    return css`
      ${SplitList.styles}

      .dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--success, #23864a);
      }

      .row.bad .dot {
        background: var(--danger, #c2343b);
      }

      .main {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      .title {
        overflow: hidden;
        font-weight: var(--w-medium, 500);
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .detail-line {
        overflow: hidden;
        color: var(--text-3, #6b7280);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .row.bad .detail-line {
        color: var(--danger, #c2343b);
      }

      .when {
        color: var(--text-3, #6b7280);
        font-size: 12px;
        white-space: nowrap;
      }
    `;
  }

  protected defaultEmptyMessage(): string {
    return msg('No logs');
  }

  protected getItemUrl(item: LogItem): string {
    return item.url;
  }

  protected getItemClass(item: LogItem): string {
    return item.is_error ? 'bad' : '';
  }

  protected getItemTitle(item: LogItem): string {
    return item.type_display;
  }

  protected renderItem(item: LogItem): TemplateResult {
    const ms = formatCount(item.elapsed_ms);
    return html`
      <span
        class="dot"
        aria-label=${item.is_error ? msg('Error') : msg('OK')}
      ></span>
      <span class="main">
        <span class="title">${item.type_display}</span>
        <span class="detail-line"
          >${item.is_error
            ? msg(str`Failed after ${ms} ms`)
            : msg(str`Took ${ms} ms`)}</span
        >
      </span>
      <span class="when"
        ><temba-date value=${item.created_on} display="relative"></temba-date
      ></span>
    `;
  }
}
