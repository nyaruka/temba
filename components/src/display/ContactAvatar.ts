import { css, html, TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';

/**
 * A contact's avatar: their initials in a colored circle, or a plain contact
 * icon when they have no name, with the scheme of the URN they're reached on
 * inset on its corner.
 */
export class ContactAvatar extends RapidElement {
  // the contact's own name, for their initials - not a URN or ref standing
  // in for one, which has no initials
  @property({ type: String })
  name: string;

  @property({ type: String })
  scheme: string;

  static get styles() {
    return css`
      /* the user's own 26px circle scaled from its left edge to 32px. The
         scheme's disc hangs past the circle, so the box makes room for it,
         since a header clips its title to its box */
      :host {
        position: relative;
        display: flex;
        align-items: center;
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        padding: 0 2px 2px 0;
      }

      temba-user {
        --temba-scale: 1.23;
      }

      .scheme {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 17px;
        height: 17px;
        border-radius: 50%;
        background: var(--surface, #fff);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .scheme temba-urn {
        --temba-urn-small-margin: 0;
      }
    `;
  }

  public render(): TemplateResult {
    return html`
      <temba-user name=${this.name || ''}></temba-user>
      ${this.scheme
        ? html`<div class="scheme">
            <temba-urn size="15" scheme=${this.scheme}></temba-urn>
          </div>`
        : null}
    `;
  }
}
