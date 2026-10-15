import { LitElement, TemplateResult, css, html } from 'lit';
import { property } from 'lit/decorators.js';
import { AccordionSection } from './AccordionSection';

export class Accordion extends LitElement {
  static get styles() {
    return css`
      :host {
        display: block;
        border-bottom: 1px solid var(--border, #e6e8ec);
      }
    `;
  }

  @property({ type: Boolean })
  multi = false;

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('toggle', this.handleToggle as EventListener);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('toggle', this.handleToggle as EventListener);
  }

  private handleToggle = (evt: CustomEvent) => {
    if (this.multi) return;

    const toggled = evt.target as AccordionSection;
    // If the toggled section was expanded (not collapsed), collapse all others
    if (!toggled.collapsed) {
      const sections = this.querySelectorAll('temba-accordion-section');
      sections.forEach((section: AccordionSection) => {
        if (section !== toggled && !section.collapsed) {
          section.collapsed = true;
        }
      });
    }
  };

  public render(): TemplateResult {
    return html`<slot></slot>`;
  }
}
