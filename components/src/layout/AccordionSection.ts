import { LitElement, TemplateResult, css, html } from 'lit';
import { property } from 'lit/decorators.js';
import { formatCount } from '../utils';

export class AccordionSection extends LitElement {
  static get styles() {
    return css`
      /* flat rows separated by hairlines; the accordion draws the rule below the last row */
      :host {
        display: block;
        border-top: 1px solid var(--border, #e6e8ec);
      }

      .accordion-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 2px;
        cursor: pointer;
        user-select: none;
        border-radius: 6px;
        outline: none;
      }

      .accordion-header:focus-visible {
        box-shadow: var(--widget-box-shadow-focused);
      }

      .accordion-title {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        font-weight: var(--w-medium, 500);
        font-size: 13px;
        color: var(--text-1, #1a1f26);
      }

      .summary {
        flex-grow: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 5px;
        font-size: 13px;
        color: var(--text-3, #7b8593);
      }

      .summary-text {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .summary.has-value {
        color: var(--text-2, #4d5664);
      }

      .summary-text.empty {
        font-style: italic;
        color: var(--text-4, #a2abb8);
      }

      .has-error .accordion-title,
      .has-error .summary {
        color: var(--color-error, tomato);
      }

      .toggle-icon {
        flex-shrink: 0;
        color: var(--text-3, #7b8593);
        transition: transform 0.2s ease;
      }

      .accordion-header:hover .toggle-icon {
        color: var(--text-1, #1a1f26);
      }

      .toggle-icon.expanded {
        transform: rotate(90deg);
      }

      .accordion-content {
        padding: 0 2px 12px 2px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        transition: all 0.2s ease-in-out;
        opacity: 1;
      }

      /* only clip while collapsed, so focus rings on fields aren't cut off */
      .accordion-content.collapsed {
        overflow: hidden;
        max-height: 0;
        padding-top: 0;
        padding-bottom: 0;
        opacity: 0;
      }
    `;
  }

  @property({ type: String })
  label = '';

  @property({ type: String })
  icon = '';

  @property({ type: String })
  summary = '';

  // shown, muted, in place of the summary when the section has no value
  @property({ type: String })
  emptySummary = 'None';

  @property({ type: Number })
  count: number;

  @property({ type: Boolean })
  checked = false;

  @property({ type: Boolean, reflect: true })
  collapsed = true;

  @property({ type: Boolean })
  hasError = false;

  private handleClick() {
    this.collapsed = !this.collapsed;
    this.dispatchEvent(
      new CustomEvent('toggle', {
        bubbles: true,
        composed: true,
        detail: { collapsed: this.collapsed, label: this.label }
      })
    );
  }

  private handleKeyDown(evt: KeyboardEvent) {
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      this.handleClick();
    }
  }

  public updated() {
    if (this.collapsed) {
      this.classList.remove('expanded');
      this.classList.add('collapsed');
    } else {
      this.classList.remove('collapsed');
      this.classList.add('expanded');
    }
  }

  private renderSummary(): TemplateResult | string {
    if (this.summary) {
      return html`<span class="summary-text">${this.summary}</span>`;
    }
    if (typeof this.count === 'number' && this.count > 0) {
      return html`<span class="summary-text">${formatCount(this.count)}</span>`;
    }
    if (this.checked) {
      return html`<temba-icon name="check" size="1"></temba-icon>`;
    }
    return html`<span class="summary-text empty">${this.emptySummary}</span>`;
  }

  public render(): TemplateResult {
    const hasValue =
      !!this.summary ||
      this.checked ||
      (typeof this.count === 'number' && this.count > 0);

    return html`
      <div
        class="accordion-header ${this.hasError ? 'has-error' : ''}"
        role="button"
        tabindex="0"
        aria-expanded=${!this.collapsed}
        @click=${this.handleClick}
        @keydown=${this.handleKeyDown}
      >
        <div class="accordion-title">
          ${this.icon
            ? html`<temba-icon
                name=${this.icon}
                size="1"
                style="margin-right:6px;"
              ></temba-icon>`
            : ''}${this.label}
        </div>
        <div class="summary ${hasValue ? 'has-value' : ''}">
          ${this.collapsed
            ? html`${this.hasError
                ? html`<temba-icon name="alert_warning" size="1"></temba-icon>`
                : ''}${this.renderSummary()}`
            : ''}
        </div>
        <temba-icon
          name="arrow_right"
          size="1.2"
          class="toggle-icon ${this.collapsed ? 'collapsed' : 'expanded'}"
        ></temba-icon>
      </div>
      <div class="accordion-content ${this.collapsed ? 'collapsed' : ''}">
        <slot></slot>
      </div>
    `;
  }
}
