import { css, html, TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';

export class ContactUrn extends RapidElement {
  @property({ type: String })
  urn: string;

  @property({ type: String })
  scheme: string;

  @property({ type: Number })
  size = 20;

  static get styles() {
    return css`
      :host {
        display: flex;
        align-items: center;
      }
      .urn {
        box-shadow: 0 0 2px 2px rgba(0, 0, 0, 0.04) inset;
        padding: 3px;
        border: 1px solid #ddd;
        border-radius: 18rem;
        background: #eee;
        margin-right: 0.2em;
      }

      .small {
        padding: 0px;
        border: 0px;
        box-shadow: none;
        margin-right: var(--temba-urn-small-margin, 0.5em);
      }
    `;
  }

  public render(): TemplateResult {
    const scheme = this.scheme || this.urn.split(':')[0];
    return html`
      <img
        class="urn ${this.size < 20 ? 'small' : ''}"
        width="${this.size}em"
        height="${this.size}em"
        src="${this.prefix ||
        (window as any).static_url ||
        '/static/'}img/schemes/${scheme}.svg"
      />
    `;
  }
}
