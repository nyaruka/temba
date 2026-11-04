import { css, html, TemplateResult } from 'lit';
import { RapidElement } from '../RapidElement';
import { designTokens } from '../styles/designTokens';

/**
 * A fixed-height header strip with a full-bleed rule under it, for the
 * chat + cards pages (contact read, tickets). Pages can use several side
 * by side (e.g. one over a list column, one over the chat) — the shared
 * height and surface make them read as one continuous control.
 */
export class HeaderBar extends RapidElement {
  static get styles() {
    return css`
      ${designTokens}

      :host {
        /* the bar's horizontal inset */
        --header-bar-inset: 8px;

        flex: 0 0 auto;
        display: flex;
        align-items: center;
        /* 52px strip plus the 1px rule */
        height: var(--header-h);
        box-sizing: border-box;
        padding: 0 var(--header-bar-inset);
        background: var(--surface);
        /* the rule is a box-shadow, not a border — host pages (tailwind
           preflight) reset border-width on every element, and outer-scope
           element styles beat :host */
        box-shadow: inset 0 -1px 0 0 var(--border);
      }

      /* Standalone page headers (the default header of every page) keep
         the strip height as a floor, centering a single line of title or
         buttons in it, but grow for taller content (a subtitle) — the
         slotted page header's own padding keeps the space above and below
         even either way. They're inset like the list pages' headers so a
         title sits in the same place whichever kind of page it's on. */
      :host([fit-content]) {
        --header-bar-inset: 12px;

        height: auto;
        min-height: var(--header-h);
      }

      ::slotted(*) {
        flex-grow: 1;
        min-width: 0;
      }
    `;
  }

  public render(): TemplateResult {
    return html`<slot></slot>`;
  }
}
