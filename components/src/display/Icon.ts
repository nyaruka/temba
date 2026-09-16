import { LitElement, TemplateResult, html, css, PropertyValues } from 'lit';
import { property } from 'lit/decorators.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { Icon, SVG_FINGERPRINT } from '../Icons';
import { getClasses } from '../utils';

interface InlineSymbol {
  viewBox: string;
  content: string;
}

export class VectorIcon extends LitElement {
  // symbols carried inside a standalone bundle rather than referenced from the
  // sprite - a page on another site can't <use> a cross-origin sprite, so the
  // webchat bundle registers its own here and those icons render inline
  private static inlineSymbols = new Map<string, InlineSymbol>();

  /**
   * Registers the symbols of a sprite to be rendered inline, by id
   */
  public static addInlineSprite(sprite: string): void {
    const doc = new DOMParser().parseFromString(sprite, 'image/svg+xml');
    doc.querySelectorAll('symbol').forEach((symbol) => {
      VectorIcon.inlineSymbols.set(symbol.id, {
        viewBox: symbol.getAttribute('viewBox') || '0 0 24 24',
        content: symbol.innerHTML
      });
    });
  }

  @property({ type: String })
  name: string;

  @property({ type: String })
  prefix: string;

  // same as name but without implicit coloring
  @property({ type: String })
  id: string;

  @property({ type: Number })
  size = 1;

  @property({ type: Boolean })
  spin: boolean;

  @property({ type: Boolean })
  clickable: boolean;

  @property({ type: Boolean })
  circled: boolean;

  @property({ type: String })
  animateChange: string;

  @property({ type: String })
  animateClick: string;

  @property({ type: Number })
  animationDuration = 200;

  @property({ type: String })
  src = '';

  @property({ type: Number, attribute: false })
  steps = 2;

  @property({ type: Number, attribute: false })
  animationStep: number;

  @property({ type: String })
  easing = 'cubic-bezier(0.68, -0.55, 0.265, 1.55)';

  static get styles() {
    return css`
      :host {
        align-items: center;
        align-self: center;
      }

      .sheet {
        color: var(--icon-color);
        transform: scale(1);
        transition:
          fill 100ms ease-in-out,
          background 200ms cubic-bezier(0.68, -0.55, 0.265, 1.55),
          padding 200ms cubic-bezier(0.68, -0.55, 0.265, 1.55),
          margin 200ms cubic-bezier(0.68, -0.55, 0.265, 1.55);
      }

      .sheet.spin {
        transform: rotate(0deg);
      }

      .sheet.spin-1 {
        transform: rotate(180deg);
      }

      .sheet.spin-2 {
        transform: rotate(360deg);
      }

      .sheet.spin-3 {
        transform: rotate(0deg);
        transition-duration: 0ms !important;
      }

      .sheet.pulse {
        transform: scale(1);
      }

      .sheet.pulse-1 {
        transform: scale(1.2);
      }

      .clickable:hover {
        cursor: pointer;
        fill: var(--color-link-primary) !important;
        background: rgb(255, 255, 255);
      }

      .circled {
        background: var(--icon-color-circle);
        padding: 0.15em;
        margin: -0.15em;
        box-shadow: var(--shadow);
      }

      .wrapper {
        display: flex;
        flex-direction: column;
        border-radius: 999px;
        transition:
          background 200ms linear,
          transform 300ms cubic-bezier(0.68, -0.55, 0.265, 1.55),
          padding 150ms linear,
          margin 150ms linear;
      }

      .wrapper.clickable {
        transform: scale(1);
      }

      .wrapper.clickable:hover {
        --icon-circle-size: 0.35em;
        --icon-background: var(--icon-color-circle-hover);
      }

      .wrapper.clickable {
        padding: var(--icon-circle-size);
        margin: calc(-1 * var(--icon-circle-size));
        background: var(--icon-background);
      }

      .spin-forever {
        animation-name: spin;
        animation-duration: var(--test-animation-duration, 2000ms);
        animation-iteration-count: infinite;
        animation-timing-function: linear;
        animation-play-state: var(--test-animation-play-state, running);
      }

      @keyframes spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(360deg);
        }
      }
    `;
  }

  constructor() {
    super();
  }

  private lastName: string;

  public willUpdate(changes: PropertyValues): void {
    super.willUpdate(changes);
    if (!this.hasUpdated && changes.has('animateChange')) {
      // set our default duration if we need one
      if (!changes.has('animationDuration')) {
        this.animationDuration = this.steps * this.animationDuration;
      }

      if (this.animateChange === 'spin') {
        this.steps = 3;
        this.animationDuration = 400;
        this.easing = 'linear';
      }
    }

    // clear lastName at the animation halfway point so render uses the new name
    if (changes.has('animationStep')) {
      if (this.lastName && this.animationStep >= this.steps / 2) {
        this.lastName = null;
      }
    }
  }

  public handleClicked() {
    if (this.animateClick) {
      this.animationStep = 1;
    }
  }

  public updated(changes: Map<string, any>) {
    super.updated(changes);

    if (changes.has('animationStep')) {
      setTimeout(() => {
        if (this.animationStep > 0 && this.animationStep < this.steps) {
          this.animationStep++;
        } else {
          this.animationStep = 0;
        }
      }, this.animationDuration / this.steps);
    }

    if (changes.has('name') && this.animateChange) {
      this.lastName = changes.get('name');

      // our name changed, defer animation start to avoid scheduling
      // an update during the current update cycle
      if (this.lastName && this.animateChange) {
        setTimeout(() => {
          this.animationStep = 1;
        }, 0);
      }
    }
  }

  public render(): TemplateResult {
    if (!this.name) {
      return null;
    }

    // let icon name mappings take precedence
    let name = this.lastName || this.name;

    // special case our channel icon fallback
    if (name.startsWith('channel_') && !Icon[name]) {
      name = Icon.channel_ex;
    } else {
      name = Icon[name.replace('icon.', '')] || name;
    }

    // referencing icons by id is explicit
    if (!name) {
      name = this.id;
    }

    const inline = this.src ? null : VectorIcon.inlineSymbols.get(name);
    const svgStyle = `height:${this.size}em;width:${this.size}em;transition:transform ${
      this.animationDuration / this.steps
    }ms ${this.easing}`;
    const svgClasses = getClasses({
      sheet: this.src === '',
      [this.animateChange]: !!this.animateChange,
      [this.animateChange + '-' + this.animationStep]: this.animationStep > 0,
      [this.animateClick]: !!this.animateClick,
      [this.animateClick + '-' + this.animationStep]: this.animationStep > 0
    });

    return html`
      <div
        @click=${this.handleClicked}
        class="wrapper ${getClasses({
          clickable: this.clickable,
          circled: this.circled,
          animate: !!this.animateChange || !!this.animateClick,
          'spin-forever': this.spin
        })}"
      >
        ${inline
          ? html`<svg
              style="${svgStyle}"
              class="${svgClasses}"
              viewBox="${inline.viewBox}"
            >
              ${unsafeSVG(inline.content)}
            </svg>`
          : html`<svg style="${svgStyle}" class="${svgClasses}">
              <use
                href="${this.src
                  ? this.src
                  : `${
                      this.prefix || (window as any).static_url || '/static/'
                    }svg/index.svg?v=${SVG_FINGERPRINT}#${name}`}"
              />
            </svg>`}
      </div>
    `;
  }
}
