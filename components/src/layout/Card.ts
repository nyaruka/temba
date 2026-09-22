import { css, html, TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { designTokens } from '../styles/designTokens';
import { formatCount, getClasses } from '../utils';
import { Icon } from '../Icons';

/**
 * A collapsible card with a header showing an icon, label and optional
 * count badge. Designed to live inside a temba-card-stack where the header
 * doubles as the drag handle, but works standalone too. The body never
 * scrolls internally — cards grow to their content.
 */
export class Card extends RapidElement {
  static get styles() {
    return css`
      ${designTokens}

      :host {
        display: block;
        /* as a grid/flex item (cards flatten into the card stack's
           grid through its slots) the automatic minimum is
           min-content — allow shrinking so long unbreakable content
           inside ellipsizes instead of widening the card */
        min-width: 0;
      }

      /* an empty panel drops its card entirely — in tab (plain) mode the
         pane still renders so the tab keeps working */
      :host([empty]:not([plain])) {
        display: none;
      }

      /* The chrome lives on an inner frame rather than the host so
         document-level universal rules (e.g. tailwind's preflight
         border-color) can't override it. */
      .frame {
        background: var(--card-bg, var(--surface));
        border: 1px solid var(--card-border, var(--border-strong));
        border-radius: var(--r-sm);
        box-shadow: var(--shadow-2);
      }

      /* note variant — the sticky-note surface, header included */
      :host([variant='note']) .frame {
        background: var(--surface-note);
        border-color: var(--border-note);
      }

      .card-header {
        display: flex;
        align-items: center;
        padding: 8px 10px;
        cursor: pointer;
        user-select: none;
        border-radius: var(--r-sm);
      }

      .card-header temba-icon {
        --icon-color: var(--text-3);
      }

      .grip {
        margin-right: 0.5em;
        cursor: grab;
        --icon-color: var(--text-4);
      }

      .card-header:hover .grip {
        --icon-color: var(--text-3);
      }

      .label {
        display: flex;
        align-items: center;
        flex-grow: 1;
        /* lets a long title or description wrap or clip within the header rather than widen it */
        min-width: 0;
        font-size: 13px;
        font-weight: var(--w-medium);
        color: var(--text-2);
      }

      .label temba-icon {
        margin-right: 0.5em;
      }

      /* the title, with whatever the host says about the card beneath it - a column of its own so the icon stays
         beside the pair rather than above the second line */
      .label-text {
        flex: 1 1 auto;
        min-width: 0;
      }

      .count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        margin-right: 0.5em;
        border-radius: 999px;
        background: var(--accent-100);
        color: var(--accent-700);
        font-size: 11px;
        font-weight: var(--w-semibold);
        font-variant-numeric: tabular-nums;
      }

      .dot {
        height: 0.5em;
        width: 0.5em;
        margin-right: 0.5em;
        background: var(--accent-600);
        border-radius: 99px;
      }

      .toggle {
        transition: transform 200ms ease;
      }

      .toggle.collapsed {
        transform: rotate(-90deg);
      }

      /* Grid trick so collapse animates to natural content height without
         capping how tall an expanded card can grow. */
      .body {
        display: grid;
        grid-template-rows: 1fr;
        /* the implicit column track is auto-sized and would grow to
           the content's max-content (one long unbreakable line widens
           the card instead of ellipsizing) — pin it to the card width */
        grid-template-columns: minmax(0, 1fr);
        transition: grid-template-rows 200ms ease;
      }

      .body.collapsed {
        grid-template-rows: 0fr;
      }

      .inner {
        min-height: 0;
        overflow: hidden;
      }

      /* once fully expanded, let popovers (date pickers etc.) escape */
      .body:not(.collapsed):not(.animating) .inner {
        overflow: visible;
      }

      .content {
        padding: 0 10px 10px;
      }

      /* card chrome bounds the panel tightly — slotted panels scale their
         empty-state treatment down from the roomy tab-pane default to a
         single quiet line */
      :host(:not([plain])) .content ::slotted(*) {
        --empty-padding: 1em;
        --empty-extras-display: none;
        --empty-title-size: 0.9em;
        --empty-title-color: var(--text-3);
      }

      /* bleed mode: the body content runs edge-to-edge so a panel with its
         own surface (e.g. the notepad) fills the card, clipped to the card
         radius. The footer of such content sits on the card's bottom edge. */
      :host([bleed]) .content {
        padding: 0;
      }

      :host([bleed]) .body:not(.collapsed):not(.animating) .inner {
        overflow: hidden;
        border-radius: 0 0 var(--r-sm) var(--r-sm);
      }

      /* plain mode: headerless and non-collapsible — the wrapper (e.g. a
         tab pane) supplies the label — but still a proper card surface
         with padding. Fills its pane and scrolls its content internally,
         since a tab pane is height-bounded. */
      :host([plain]) {
        display: flex;
        flex-direction: column;
        flex-grow: 1;
        min-height: 0;
        margin-top: var(--layout-spacing, 8px);
        margin-bottom: var(--layout-spacing, 8px);
      }

      :host([plain]) .frame,
      :host([plain]) .body,
      :host([plain]) .inner {
        display: flex;
        flex-direction: column;
        flex-grow: 1;
        min-height: 0;
        overflow: hidden;
      }

      :host([plain]) .inner {
        border-radius: var(--r-sm);
      }

      :host([plain]) .content {
        display: flex;
        flex-direction: column;
        flex-grow: 1;
        min-height: 0;
        padding: 10px;
        overflow-y: auto;
      }

      /* no header row in plain mode, so bleeding content gets a top inset
         directly against the card surface */
      :host([plain][bleed]) .content {
        padding: 10px 0 0 0;
      }
    `;
  }

  @property({ type: String })
  label = '';

  @property({ type: String })
  icon = '';

  // what the header is picked up by - the grip unless the host has something that says what the card is
  @property({ type: String, attribute: 'grip-icon' })
  gripIcon: string = Icon.drag;

  @property({ type: Number })
  count = 0;

  // show a dot instead of the count
  @property({ type: Boolean })
  activity = false;

  @property({ type: Boolean, reflect: true })
  collapsed = false;

  // render without chrome (no header, border or collapse) — content only
  @property({ type: Boolean, reflect: true })
  plain = false;

  // body content runs edge-to-edge instead of getting the inset padding
  @property({ type: Boolean, reflect: true })
  bleed = false;

  // the slotted panel reported (via temba-details-changed) that it has
  // nothing to show — the card hides entirely in card mode, though its
  // tab remains available in narrow mode
  @property({ type: Boolean, reflect: true })
  empty = false;

  // named surface treatments, e.g. "note" for the sticky-note look
  @property({ type: String, reflect: true })
  variant = '';

  @property({ type: Boolean })
  dirty = false;

  private animating = false;

  private handleHeaderClick() {
    this.collapsed = !this.collapsed;
    this.animating = true;
    this.requestUpdate();
    this.dispatchEvent(
      new CustomEvent('toggle', {
        bubbles: true,
        composed: true,
        detail: { collapsed: this.collapsed, label: this.label }
      })
    );
  }

  private handleTransitionEnd(event: TransitionEvent) {
    // transitionend bubbles composed out of slotted content — only our own
    // grid collapse animation should clear the clipping state
    if (
      event.target !== event.currentTarget ||
      event.propertyName !== 'grid-template-rows'
    ) {
      return;
    }
    this.animating = false;
    this.requestUpdate();
  }

  private handleDetailsChanged(event: CustomEvent) {
    if ('dirty' in event.detail) {
      this.dirty = event.detail.dirty;
    }
    if ('count' in event.detail) {
      this.count = event.detail.count;
    }
    if ('empty' in event.detail) {
      this.empty = event.detail.empty;
    }
  }

  public render(): TemplateResult {
    if (this.plain) {
      return html`
        <div class="frame">
          <div class="body">
            <div class="inner">
              <div class="content">
                <slot
                  @temba-details-changed=${this.handleDetailsChanged}
                ></slot>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    return html`
      <div class="frame">
        <div class="card-header" @click=${this.handleHeaderClick}>
          <temba-icon
            name=${this.gripIcon}
            class="grip"
            part="grip"
          ></temba-icon>
          <div class="label">
            ${this.icon
              ? html`<temba-icon name=${this.icon}></temba-icon>`
              : null}
            <div class="label-text">
              <div part="title">${this.label}${this.dirty ? ' *' : ''}</div>
              <slot name="description"></slot>
            </div>
          </div>
          <slot name="header-actions"></slot>
          ${this.count > 0
            ? this.activity
              ? html`<div class="dot"></div>`
              : html`<div class="count">${formatCount(this.count)}</div>`
            : null}
          <temba-icon
            name=${Icon.arrow_down}
            class="toggle ${this.collapsed ? 'collapsed' : ''}"
          ></temba-icon>
        </div>
        <div
          class="body ${getClasses({
            collapsed: this.collapsed,
            animating: this.animating
          })}"
          @transitionend=${this.handleTransitionEnd}
        >
          <div class="inner">
            <div class="content">
              <slot @temba-details-changed=${this.handleDetailsChanged}></slot>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
