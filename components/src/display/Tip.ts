import { css, html, PropertyValues, TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { styleMap } from 'lit-html/directives/style-map.js';
import { RapidElement } from '../RapidElement';
import { getClasses, getMiddle, getCenter } from '../utils';

export class Tip extends RapidElement {
  static get styles() {
    return css`
      .tip {
        transition:
          opacity 120ms cubic-bezier(0.2, 0, 0, 1),
          transform 120ms cubic-bezier(0.2, 0, 0, 1);
        margin: 0px;
        position: fixed;
        opacity: 0;
        background: #fff;
        padding: 4px 8px;
        pointer-events: none;
        border-radius: var(--curvature-widget);
        box-shadow:
          0 1px 10px 10px rgba(0, 0, 0, 0.035),
          0 1px 3px 0px rgba(0, 0, 0, 0.1),
          0 1px 2px 0 rgba(0, 0, 0, 0.06);
        font-size: 14px;
        z-index: 2147483647;
        color: #333;
        white-space: nowrap;
        /* a tip reads the same wherever it's anchored, rather than taking on
           the text styles of whatever it's in, e.g. an uppercase heading */
        font-weight: normal;
        font-style: normal;
        text-transform: none;
        letter-spacing: normal;
        line-height: normal;
        text-align: left;
        text-decoration: none;
      }

      .tip kbd {
        display: inline;
        padding: 0;
        border: none;
        border-radius: 0;
        background: transparent;
        color: #8b98ab;
        font-size: 11px;
        font-weight: 500;
        line-height: 1;
        letter-spacing: 0.01em;
        font-family: inherit;
      }

      .tip.hide-on-change {
        transition: none;
      }

      /* hidden tips sit a few px toward their anchor so showing slides
         them into position — up, down, or over based on the side */
      .tip,
      .tip.side-top {
        transform: translateY(6px);
      }

      .tip.side-bottom {
        transform: translateY(-6px);
      }

      .tip.side-left {
        transform: translateX(6px);
      }

      .tip.side-right {
        transform: translateX(-6px);
      }

      .show {
        opacity: 1;
        z-index: 2147483647;
      }

      .tip.show {
        transform: translate(0, 0);
      }

      /* interactive tips accept the mouse while shown so their
         contents can be selected or clicked */
      .tip.interactive.show {
        pointer-events: auto;
      }

      .slot {
        display: flex;
        flex-direction: column;
      }

      .arrow {
        position: absolute;
        color: #fff;
        font-size: 10px;
        line-height: 0px;
      }

      /* squash the glyphs along their pointing axis (and widen the
         base a touch) so the arrows read fat and stubby rather than
         long and pointy */
      .◀ {
        text-shadow: -1px 2px 2px rgba(0, 0, 0, 0.1);
        transform: scale(0.6, 1.15);
      }

      .▶ {
        text-shadow: 1px 2px 2px rgba(0, 0, 0, 0.1);
        transform: scale(0.6, 1.15);
      }

      .▼ {
        text-shadow: 0px 3px 3px rgba(0, 0, 0, 0.1);
        transform: scale(1.15, 0.6);
      }

      .▲ {
        text-shadow: 0px -1px 1px rgba(0, 0, 0, 0.1);
        transform: scale(1.15, 0.6);
      }
    `;
  }

  @property({ type: String })
  text: string;

  @property({ attribute: false })
  content: TemplateResult | string | null = null;

  @property({ type: Boolean })
  visible = false;

  @property({ type: String })
  position = 'auto';

  // gap in px between the anchor and the tip edge; when unset, each
  // side keeps its historical default (10-12px)
  @property({ type: Number })
  distance: number = null;

  // font-size of the arrow glyph; offsets scale with it
  @property({ type: Number, attribute: 'arrow-size' })
  arrowSize = 10;

  // interactive tips stay open while the mouse is over them so their
  // contents can be selected or clicked
  @property({ type: Boolean })
  interactive = false;

  @property({ type: Boolean })
  hideOnChange: boolean;

  top: number;
  left: number;

  @property({ type: Number, attribute: false })
  width: number;

  @property({ type: Boolean, attribute: false })
  poppedTop: boolean;

  @property({ type: Number })
  delay = 350;

  @property({ type: Number })
  hideDelay = 40;

  arrow: string;
  arrowTop: number;
  arrowLeft: number;
  arrowDirection: string;

  // the side the tip last popped on, driving which direction it
  // slides in from
  side: string;

  showTimer = 0;
  hideTimer = 0;

  public willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has('text') && this.hideOnChange) {
      this.visible = false;
    }

    // stamp the placement side before the show transition starts so
    // the very first pop already slides in from the correct direction
    if (changed.has('visible') && this.visible) {
      this.prepareSide();
    }
  }

  /**
   * Measures where the tip will pop and applies the matching side-*
   * class while the tip is still hidden, flushing styles so the slide
   * animation starts from that side's offset rather than the default.
   */
  private prepareSide() {
    const tipEl = this.getDiv('.tip') as HTMLElement;
    const anchorEl = this.getDiv('.slot') as HTMLElement;
    if (!tipEl || !anchorEl) {
      return;
    }

    const side = this.chooseSide(
      this.position,
      anchorEl.getBoundingClientRect(),
      tipEl.getBoundingClientRect(),
      8
    );

    if (side !== this.side) {
      this.side = side;
      // snap (not animate) the hidden tip to the new side's offset so
      // the show transition starts from there — without suppressing
      // the transition, the class swap itself animates and the show
      // retargets from the old offset mid-flight
      tipEl.style.transition = 'none';
      tipEl.classList.remove(
        'side-top',
        'side-bottom',
        'side-left',
        'side-right'
      );
      tipEl.classList.add(`side-${side}`);
      void tipEl.offsetWidth;
      tipEl.style.transition = '';
    }
  }

  public updated(changed: Map<string, any>) {
    if ((changed.has('visible') || changed.has('text')) && this.visible) {
      this.calculatePosition();
    }
  }

  private calculatePosition() {
    if (this.visible) {
      const tipEl = this.getDiv('.tip') as HTMLElement;
      const arrowEl = this.getDiv('.arrow') as HTMLElement;
      const tipBounds = tipEl.getBoundingClientRect();
      const anchorBounds = this.getDiv('.slot').getBoundingClientRect();

      const viewportPadding = 8;
      const side = this.chooseSide(
        this.position,
        anchorBounds,
        tipBounds,
        viewportPadding
      );
      this.side = side;

      this.arrowLeft = 0;
      this.arrowTop = 0;

      // arrow offsets scale with the glyph size; the constants
      // reproduce the historical values at the default size of 10
      const arrow = this.arrowSize;

      if (side === 'left') {
        this.left = anchorBounds.left - tipBounds.width - (this.distance ?? 10);
        this.top = getMiddle(anchorBounds, tipBounds);

        // center the glyph box on the tip edge so the arrow always
        // touches the tip regardless of glyph metrics
        this.arrowTop = tipBounds.height / 2;
        this.arrowLeft = tipBounds.width - arrow * 0.5;
        this.arrow = '▶';
      } else if (side === 'right') {
        this.left = anchorBounds.right + (this.distance ?? 12);
        this.top = getMiddle(anchorBounds, tipBounds);

        this.arrowTop = tipBounds.height / 2;
        this.arrowLeft = -arrow * 0.5;
        this.arrow = '◀';
      } else if (side === 'top') {
        this.top = anchorBounds.top - tipBounds.height - (this.distance ?? 12);
        this.left = getCenter(anchorBounds, tipBounds);

        // tucked in slightly so the squashed glyph's base stays
        // buried under the tip edge
        this.arrowTop = tipBounds.height + arrow * 0.1;
        this.arrowLeft = tipBounds.width / 2 - arrow * 0.4;
        this.arrow = '▼';
      } else if (side === 'bottom') {
        this.top = anchorBounds.bottom + (this.distance ?? 10);
        this.left = getCenter(anchorBounds, tipBounds);

        this.arrowTop = -arrow * 0.1;
        this.arrowLeft = tipBounds.width / 2 - arrow * 0.3;
        this.arrow = '▲';
      }

      const minLeft = viewportPadding;
      const maxLeft = window.innerWidth - tipBounds.width - viewportPadding;
      const minTop = viewportPadding;
      const maxTop = window.innerHeight - tipBounds.height - viewportPadding;

      const unclampedLeft = this.left;
      const unclampedTop = this.top;
      this.left = this.clamp(this.left, minLeft, maxLeft);
      this.top = this.clamp(this.top, minTop, maxTop);

      const leftDelta = this.left - unclampedLeft;
      const topDelta = this.top - unclampedTop;

      if (side === 'top' || side === 'bottom') {
        this.arrowLeft -= leftDelta;
        this.arrowLeft = this.clamp(
          this.arrowLeft,
          8,
          tipBounds.width - (arrow + 4)
        );
      } else {
        this.arrowTop -= topDelta;
        this.arrowTop = this.clamp(this.arrowTop, 8, tipBounds.height - 8);
      }

      // round to avoid sub-pixel rendering differences
      this.top = Math.round(this.top);
      this.left = Math.round(this.left);
      this.arrowTop = Math.round(this.arrowTop);
      this.arrowLeft = Math.round(this.arrowLeft);

      // directly update DOM to avoid scheduling another update
      tipEl.classList.remove(
        'side-top',
        'side-bottom',
        'side-left',
        'side-right'
      );
      tipEl.classList.add(`side-${side}`);
      tipEl.style.top = `${this.top}px`;
      tipEl.style.left = `${this.left}px`;
      arrowEl.style.top = `${this.arrowTop}px`;
      arrowEl.style.left = `${this.arrowLeft}px`;
      arrowEl.textContent = this.arrow;
      arrowEl.className = `arrow ${this.arrow}`;
    }
  }

  private clamp(value: number, min: number, max: number): number {
    if (max < min) {
      return min;
    }
    return Math.min(Math.max(value, min), max);
  }

  private chooseSide(
    preferred: string,
    anchorBounds: DOMRect,
    tipBounds: DOMRect,
    viewportPadding: number
  ): string {
    const gap = 12;
    const spaces = {
      left: anchorBounds.left - viewportPadding,
      right: window.innerWidth - anchorBounds.right - viewportPadding,
      top: anchorBounds.top - viewportPadding,
      bottom: window.innerHeight - anchorBounds.bottom - viewportPadding
    };

    const required = {
      left: tipBounds.width + gap,
      right: tipBounds.width + gap,
      top: tipBounds.height + gap,
      bottom: tipBounds.height + gap
    };

    const fits = (side: string) => spaces[side] >= required[side];
    const opposite: Record<string, string> = {
      left: 'right',
      right: 'left',
      top: 'bottom',
      bottom: 'top'
    };

    if (preferred !== 'auto') {
      if (fits(preferred)) {
        return preferred;
      }
      const fallback = opposite[preferred];
      if (fallback && fits(fallback)) {
        return fallback;
      }
      return preferred;
    }

    const order = ['bottom', 'right', 'left', 'top'];
    let bestSide = order[0];
    let bestSpace = -1;

    for (const side of order) {
      if (fits(side)) {
        return side;
      }
      if (spaces[side] > bestSpace) {
        bestSpace = spaces[side];
        bestSide = side;
      }
    }

    return bestSide;
  }

  private handleMouseEnter() {
    window.clearTimeout(this.hideTimer);
    window.clearTimeout(this.showTimer);
    this.showTimer = window.setTimeout(() => {
      this.visible = true;
    }, this.delay);
  }

  private handleMouseLeave() {
    window.clearTimeout(this.showTimer);
    window.clearTimeout(this.hideTimer);

    // interactive tips linger long enough for the mouse to travel from
    // the anchor into the tip itself
    const hideDelay = this.interactive
      ? Math.max(this.hideDelay, 300)
      : this.hideDelay;

    if (hideDelay > 0) {
      this.hideTimer = window.setTimeout(() => {
        this.visible = false;
      }, hideDelay);
      return;
    }
    this.visible = false;
  }

  private handleTipMouseEnter() {
    // the mouse made it into the tip — cancel any pending hide
    window.clearTimeout(this.hideTimer);
  }

  public render(): TemplateResult {
    const tipStyle: any = {
      top: this.top ? `${this.top}px` : '0px',
      left: this.left ? `${this.left}px` : '0px'
    };

    const arrowStyle: any = {
      top: this.arrowTop ? `${this.arrowTop}px` : '0px',
      left: this.arrowLeft ? `${this.arrowLeft}px` : '0px',
      fontSize: `${this.arrowSize}px`
    };

    if (this.width) {
      tipStyle.width = `${this.width}px`;
    }

    const classes = getClasses({
      tip: true,
      show: this.visible,
      top: this.poppedTop,
      interactive: this.interactive,
      'hide-on-change': this.hideOnChange,
      [`side-${this.side}`]: !!this.side
    });

    return html`
      <div
        class="slot"
        @click=${this.handleMouseLeave}
        @mouseenter=${this.handleMouseEnter}
        @mouseleave=${this.handleMouseLeave}
      >
        <slot></slot>
      </div>
      <div
        class="${classes}"
        style=${styleMap(tipStyle)}
        @mouseenter=${this.handleTipMouseEnter}
        @mouseleave=${this.handleMouseLeave}
      >
        ${this.content ?? this.text}
        <div class="arrow" style=${styleMap(arrowStyle)}></div>
      </div>
    `;
  }
}
