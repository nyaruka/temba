import { html, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { Icon } from '../Icons';

export { detailDialogStyles } from '../styles/detailDialog';

/** What a detail dialog shows for the item it's open on. */
export interface DetailDialogContent {
  /** The header's name line. */
  title: unknown;
  /** A muted line under the name, e.g. when the item was created. */
  subtitle?: unknown;
  /** The header's actions (see renderDetailButton). The actions group is
   * left out entirely when this is null or undefined. */
  actions?: unknown;
  /** Anything else for the header, after the actions and before the
   * close, e.g. a status pill. */
  trailing?: unknown;
  body: unknown;
}

/** An action button for a detail dialog's header. */
export const renderDetailButton = (
  label: unknown,
  onClick: () => void,
  destructive = false
): TemplateResult => html`
  <button
    type="button"
    class="menu-button ${destructive ? 'destructive' : ''}"
    @click=${onClick}
  >
    ${label}
  </button>
`;

/**
 * The large flat dialog that stands in for an item's read page: a header
 * with the item's name, actions and a close, over a scrolling body. It's
 * open whenever there's content. Every way it closes (the ✕, Escape or a
 * click outside) calls onClose, which must clear the host's open state or
 * the next open is a no-op change and the dialog never reopens. Styled by
 * detailDialogStyles.
 */
export const renderDetailDialog = (
  content: DetailDialogContent | null,
  onClose: () => void
): TemplateResult => html`
  <temba-dialog
    size="xlarge"
    variant="flat"
    primaryButtonName=""
    cancelButtonName=""
    hideOnClick
    ?open=${!!content}
    @temba-dialog-hidden=${onClose}
    @keyup=${(e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    }}
  >
    ${content
      ? html`
          <div class="detail">
            <div class="detail-header">
              <div class="detail-title">
                <div class="detail-name">${content.title}</div>
                ${content.subtitle
                  ? html`<div class="detail-subtitle">${content.subtitle}</div>`
                  : null}
              </div>
              ${content.actions != null
                ? html`<div class="detail-actions">${content.actions}</div>`
                : null}
              ${content.trailing ?? null}
              <div
                class="detail-close"
                role="button"
                tabindex="0"
                aria-label=${msg('Close')}
                @click=${onClose}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClose();
                  }
                }}
              >
                <temba-icon name=${Icon.close} size="1.4"></temba-icon>
              </div>
            </div>
            <div class="detail-body">${content.body}</div>
          </div>
        `
      : null}
  </temba-dialog>
`;
