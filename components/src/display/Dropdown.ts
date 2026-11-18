import { css, html, TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { getClasses } from '../utils';
import { CustomEventType } from '../interfaces';

import { styleMap } from 'lit-html/directives/style-map.js';

export class Dropdown extends RapidElement {
  static get styles() {
    return css`
      .wrapper {
        position: relative;
      }

      .toggle {
        cursor: pointer;
      }

      .dropdown-wrapper {
        position: relative;
        overflow: auto;
      }

      .dropdown.dormant {
        height: 0;
        overflow: hidden;
      }

      .dropdown {
        position: fixed;
        /* open popups sit above floating windows (simulator, 5000) and
           other page chrome, but below dialogs and toasts (10000);
           temba-content-menu mirrors this value on its temba-dropdown
           flex item (see ContentMenu.ts) */
        z-index: 9000;
        /* the dormant (height: 0) rule is applied 250ms after close, so
           until then this stays a laid-out, invisible fixed box at
           z-index 9000 over whatever it was covering — ignore pointer
           events unless we're actually open */
        pointer-events: none;
        padding: 0;
        opacity: 0;
        border-radius: calc(var(--curvature) * 1.5);
        background: #fff;
        transition:
          opacity calc(0.8 * var(--transition-speed)) var(--bounce),
          transform calc(0.8 * var(--transition-speed)) var(--bounce);
        user-select: none;
        margin-top: 0px;
        margin-left: 0px;
        transform: translateY(0) scale(1);
        box-shadow: var(--dropdown-shadow);
      }

      .dropdown:focus {
        outline: none;
      }

      .arrow {
        content: '';
        width: 0px;
        height: 0;
        z-index: 10;
        position: absolute;
        border-left: 6px solid transparent;
        border-right: 6px solid transparent;
        border-bottom: 6px solid white;
      }

      .open .dropdown {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0.5em) scale(1);
      }

      .open .dropdown.up {
        transform: translateY(-0.5em) scale(1);
      }

      .mask {
        position: absolute;
        left: 0;
        top: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        opacity: 0.5;
        transition: opacity var(--transition-speed) ease-in-out;
        pointer-events: none;
        z-index: 1;
      }

      .mask.open {
        opacity: 1;
        pointer-events: auto;
      }

      .right {
        right: 0;
      }
    `;
  }

  @property({ type: Boolean })
  open = false;

  @property({ type: Boolean })
  dormant = true;

  @property({ type: Number })
  arrowSize = 8;

  @property({ type: Number })
  margin = 10;

  @property({ type: Boolean })
  mask = false;

  // prefer opening above the toggle, falling back to below if there's no room
  @property({ type: Boolean })
  up = false;

  // optional selector for the element inside the toggle slot to position
  // against, e.g. the visible button rather than its padded wrapper
  @property({ type: String })
  anchor = '';

  dropdownStyle: Record<string, string> = {};

  arrowStyle: Record<string, string> = {};

  // whether the last position calculation opened us above the toggle
  private openedUp = false;

  constructor() {
    super();
    this.calculatePosition = this.calculatePosition.bind(this);
  }

  private activeFocus: any;
  private blurHandler: any;

  private resetBlurHandler() {
    const dropdown = this.shadowRoot.querySelector(
      '.dropdown'
    ) as HTMLDivElement;

    if (this.activeFocus) {
      this.activeFocus.removeEventListener('blur', this.blurHandler);
    }

    this.activeFocus = dropdown;
    this.blurHandler = this.handleBlur.bind(this);
    this.activeFocus.addEventListener('blur', this.blurHandler);
  }

  private handleBlur(event: FocusEvent) {
    const newTarget = event.relatedTarget as any;

    if (this.contains(newTarget)) {
      newTarget.addEventListener('blur', this.blurHandler);
      this.activeFocus = newTarget;
    } else {
      this.closeDropdown();
    }
  }

  private openDropdown() {
    // reset position so calculatePosition() sees the natural bounds
    this.dropdownStyle = {};
    this.arrowStyle = {};
    this.openedUp = this.up;

    this.open = true;
    this.dormant = false;
    this.resetBlurHandler();

    const dropdown = this.shadowRoot.querySelector(
      '.dropdown'
    ) as HTMLDivElement;
    dropdown.focus();
    dropdown.click();

    this.fireCustomEvent(CustomEventType.Opened);
  }

  private closeDropdown() {
    this.activeFocus.removeEventListener('blur', this.blurHandler);
    this.open = false;

    window.setTimeout(() => {
      this.dormant = true;
    }, 250);

    this.blur();
  }

  public close() {
    if (this.open) {
      this.closeDropdown();
    }
  }

  public updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    if (changedProperties.has('open') && this.open) {
      // defer to avoid scheduling an update during the current cycle;
      // the dropdown transitions from opacity 0 so this is not visible
      setTimeout(() => this.calculatePosition(), 0);
    }
  }

  public calculatePosition() {
    const dropdown = this.shadowRoot.querySelector(
      '.dropdown'
    ) as HTMLDivElement;
    const toggle = this.querySelector('*[slot="toggle"]');

    let bumpedUp = false;
    let bumpedLeft = false;

    if (dropdown && toggle) {
      const anchor =
        (this.anchor && toggle.querySelector(this.anchor)) || toggle;
      const dropdownBounds = dropdown.getBoundingClientRect();
      const toggleBounds = anchor.getBoundingClientRect();

      // Anchor the dropdown to the toggle's viewport coordinates.
      // The dropdown is `position: fixed`, so viewport coords are
      // the right reference frame. Without an explicit anchor the
      // browser resolves `top: auto; left: auto` from the element's
      // in-flow position, which mis-places the dropdown when the
      // page is scrolled. Always setting top/left from
      // getBoundingClientRect makes positioning scroll-invariant.
      const dropdownStyle = {
        border: '1px solid rgba(0,0,0,0.1)',
        marginTop: '0.5em',
        top: toggleBounds.bottom + 'px',
        left: toggleBounds.left + 'px'
      };

      // if off the the right, bump it left
      if (toggleBounds.left + dropdownBounds.width > window.innerWidth) {
        dropdownStyle['left'] =
          toggleBounds.right - dropdownBounds.width + 'px';
        bumpedLeft = true;
      }

      // if preferred up and there's room, or we'd fall off the bottom, bump
      // it up, leaving room for the arrow to point at the top of the toggle
      if (
        (this.up &&
          toggleBounds.top > dropdownBounds.height + this.arrowSize) ||
        toggleBounds.bottom + dropdownBounds.height > window.innerHeight
      ) {
        // anchored by its bottom edge, so it stays against the toggle when
        // its content changes height while open, e.g. a list being searched.
        // The negative margin matches the overlap the top margin gives a
        // dropdown opening below
        dropdownStyle['top'] = 'auto';
        dropdownStyle['bottom'] =
          window.innerHeight - toggleBounds.top + this.arrowSize + 'px';
        dropdownStyle['marginTop'] = '0';
        dropdownStyle['marginBottom'] = '-0.5em';
        bumpedUp = true;
      }

      // if our arrow is aligned with the left of the dropdown, scootch
      // the dropdown left a pinch so our arrow still overlaps properly
      let arrowLeft = toggleBounds.width / 2 - this.arrowSize;
      if (arrowLeft <= 0) {
        dropdownStyle['marginLeft'] = '-10px';
        arrowLeft = 10;
      }

      // safety: keep dropdown off the viewport's left edge so popups
      // anchored to far-left toggles (e.g. rail items) don't rub against
      // the window edge. Shift the dropdown right and slide the arrow
      // back the same amount so it still points at the toggle.
      // Check against the intended `left` (toggleBounds.left) rather
      // than the dropdown's currently-rendered bounds, since the new
      // left is what we're about to set.
      const MIN_LEFT = 8;
      if (toggleBounds.left < MIN_LEFT && !bumpedLeft) {
        const shift = MIN_LEFT - toggleBounds.left;
        dropdownStyle['left'] = MIN_LEFT + 'px';
        arrowLeft -= shift;
      }

      const arrowStyle = {
        left: arrowLeft + 'px',
        borderWidth: this.arrowSize + 'px',
        top: '-' + this.arrowSize + 'px'
      };

      if (bumpedUp) {
        // rotate our arrow 180 degrees
        arrowStyle['transform'] = 'rotate(180deg)';

        // and place it at the bottom of the dropdown
        arrowStyle['top'] = 'auto';
        arrowStyle['bottom'] = '-' + this.arrowSize + 'px';
      }

      if (bumpedLeft) {
        arrowStyle['right'] = toggleBounds.width / 2 - this.arrowSize + 'px';
        delete arrowStyle['left'];
      }

      this.arrowStyle = arrowStyle;
      this.dropdownStyle = dropdownStyle;
      this.openedUp = bumpedUp;
    }
    this.requestUpdate();
  }

  public handleToggleClicked(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (!this.open && this.dormant) {
      this.openDropdown();
    }
  }

  public render(): TemplateResult {
    return html`
      ${this.mask
        ? html`<div class="mask  ${this.open ? 'open' : ''}" />`
        : null}

      <div
        class="wrapper ${getClasses({
          open: this.open
        })}"
      >
        <slot
          name="toggle"
          class="toggle"
          @click=${this.handleToggleClicked}
        ></slot>
        <div
          class="${getClasses({
            dropdown: true,
            dormant: this.dormant,
            up: this.openedUp
          })}"
          style=${styleMap(this.dropdownStyle)}
          tabindex="0"
        >
          <div class="arrow" style=${styleMap(this.arrowStyle)}></div>
          <div class="dropdown-wrapper">
            <slot name="dropdown" tabindex="1"></slot>
          </div>
        </div>
      </div>
    `;
  }
}
