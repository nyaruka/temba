import { property, state } from 'lit/decorators.js';
import { TemplateResult, html, css, PropertyValues } from 'lit';
import { Button } from '../display/Button';
import { CustomEventType } from '../interfaces';
import { styleMap } from 'lit-html/directives/style-map.js';
import { getClasses } from '../utils';
import { ResizeElement } from '../ResizeElement';

export enum ButtonType {
  PRIMARY = 'primary',
  SECONDARY = 'secondary',
  DESTRUCTIVE = 'destructive'
}
export class DialogButton {
  name?: string;
  id?: string;
  details?: any;
  type?: string;
  closes?: boolean;
}

export class Dialog extends ResizeElement {
  public static readonly UNSAVED_CHANGES_MESSAGE =
    'You have unsaved changes. Are you sure you want to discard them?';

  static get widths(): { [size: string]: string } {
    return {
      small: '400px',
      medium: '600px',
      large: '655px',
      xlarge: '800px'
    };
  }

  static get styles() {
    return css`
      :host {
        position: absolute;
        z-index: 10000;
        font-family: var(--font-family);
        background: white;
      }

      .flex-grow {
        flex-grow: 1;
      }

      .flex {
        display: flex;
        flex-direction: column;
        width: 100%;
        position: relative;
        left: 0px;
        top: 0px;
        align-items: center;
        height: 100vh;
      }

      .mobile .flex {
        height: 100%;
        position: fixed;
      }

      .mobile .grow-top {
        flex-grow: 0;
      }

      .mobile .grow-bottom {
        flex-grow: 0;
      }

      .grow-top {
        flex-grow: 1;
      }

      .grow-bottom {
        flex-grow: 3;
      }

      .bottom-padding {
        padding: 3rem;
      }

      .dialog-mask {
        width: 100%;
        height: 100%;
        background: rgba(15, 22, 36, 0.42);
        -webkit-backdrop-filter: blur(4px) saturate(120%);
        backdrop-filter: blur(4px) saturate(120%);
        opacity: 0;
        position: fixed;
        top: 0px;
        left: 0px;
        transition: opacity calc(var(--transition-speed, 250ms) * 0.8) ease-out;
        pointer-events: none;
      }

      .mobile.dialog-mask .dialog-container {
        border-radius: 0px;
      }

      .dialog-mask .dialog-container {
        position: relative;
        transition:
          transform calc(var(--transition-speed, 250ms) * 1.5)
            cubic-bezier(0.16, 1, 0.3, 1),
          opacity var(--transition-speed, 250ms) ease-out,
          box-shadow 200ms ease-out;
        border-radius: var(--dialog-radius, 18px);
        box-shadow:
          0 0 0 1px rgba(15, 22, 36, 0.06),
          0 2px 6px rgba(15, 22, 36, 0.06),
          0 24px 56px -12px rgba(15, 22, 36, 0.32);
        overflow: hidden;
        opacity: 0;
        transform: translateY(16px) scale(0.97);
        background: var(--surface, #fff);
        margin: auto;
        display: flex;
        flex-direction: column;
      }

      .dialog-body {
        overflow-y: auto;
        overflow-x: hidden;
        flex-grow: 1;
      }

      .dialog-mask.dialog-open {
        opacity: 1;
        pointer-events: auto;
      }

      .dialog-mask.dialog-open .dialog-container {
        top: inherit;
        opacity: 1;
      }

      .dialog-mask.dialog-animation-end .dialog-container {
        transform: none !important;
      }

      .dialog-mask.dialog-ready .dialog-container {
        transform: none;
      }

      .dialog-mask.dialog-loading .dialog-container {
        margin-top: -10000px;
      }

      /* The dialog is a solid gradient of its color (--header-bg, or the
         primary color) with the title on it, and a white sheet holding the
         body and footer that overlaps the bottom of the header. */
      .dialog-mask .dialog-container {
        --dialog-color: var(--header-bg, rgb(var(--primary-rgb, 73, 127, 206)));
        background: var(--dialog-color);
      }

      @supports (color: color-mix(in srgb, red, red)) {
        .dialog-mask .dialog-container {
          background: linear-gradient(
            155deg,
            color-mix(
              in srgb,
              var(--dialog-color) var(--dialog-shade, 93%),
              #000
            ),
            var(--dialog-color) 45%,
            color-mix(in srgb, var(--dialog-color) 70%, #fff)
          );
        }

        /* an explicit color (a node type, say) keeps a deeper shade; the
           primary color stays lighter, like the primary buttons */
        .dialog-mask .dialog-container.themed {
          --dialog-shade: 78%;
          /* a black shadow grays out the header, so it's a deep shade of
             the color instead */
          --dialog-sheet-shadow: color-mix(
            in srgb,
            color-mix(in srgb, var(--dialog-color) 45%, #000) 40%,
            transparent
          );
          /* the highlighted row in dropdowns follows the theme too */
          --temba-options-option-focus-bg: var(--focus-50);
          --temba-options-option-focus-text: var(--focus-700);
        }

        /* so does the primary button, which draws from the accent ramp */
        .dialog-mask .dialog-container.themed .dialog-footer temba-button {
          --accent: var(--dialog-color);
          --accent-500: color-mix(in srgb, var(--dialog-color) 90%, black);
          --accent-600: color-mix(in srgb, var(--dialog-color) 80%, black);
        }
      }

      /* A light color (a pale note yellow, say) can't carry white text, and
         shading it toward black turns it muddy, so it gets a lighter
         gradient deepened toward its own hue, dark text (whatever
         --header-text says, since that defaults to white), and a primary
         button filled with the color itself. --focus is a darker shade of
         the color (see updateThemeFocus) so rings and edges stay visible. */
      @supports (color: color-mix(in srgb, red, red)) {
        .dialog-mask .dialog-container.themed.light {
          --dialog-ink: color-mix(in srgb, var(--focus) 30%, #1a1f26);
          /* brightest behind the title, deepening across the header; it
             runs sideways since only the top of the container shows */
          background: linear-gradient(
            110deg,
            color-mix(in srgb, var(--dialog-color) 75%, #fff),
            var(--dialog-color) 35%,
            color-mix(in srgb, var(--dialog-color) 55%, var(--focus))
          );
          --dialog-sheet-shadow: color-mix(
            in srgb,
            var(--focus) 45%,
            transparent
          );
        }

        .dialog-mask
          .dialog-container.themed.light
          .dialog-footer
          temba-button {
          --accent: var(--dialog-color);
          --accent-500: color-mix(
            in srgb,
            var(--dialog-color) 85%,
            var(--focus)
          );
          --accent-600: color-mix(
            in srgb,
            var(--focus) 55%,
            var(--dialog-color)
          );
          --accent-text: var(--dialog-ink);
        }
      }

      .dialog-mask .dialog-container.themed.light .header-text {
        color: var(--dialog-ink, #1a1f26);
      }

      /* Focus rings inside a themed dialog follow its color: --focus-rgb is
         set on the container from --header-bg (see updateThemeFocus), and
         the focus tokens are re-derived here so they reach slotted widgets
         as well as the dialog's own buttons. */
      .dialog-mask .dialog-container {
        --focus: rgb(var(--focus-rgb, 91, 156, 229));
        --focus-halo: 0 0 0 3px rgba(var(--focus-rgb, 91, 156, 229), 0.3);
        --widget-box-shadow-focused: var(--focus-halo);
      }

      @supports (color: color-mix(in srgb, red, red)) {
        .dialog-mask .dialog-container {
          --focus-50: color-mix(in srgb, var(--focus) 12%, white);
          --focus-100: color-mix(in srgb, var(--focus) 24%, white);
          --focus-200: color-mix(in srgb, var(--focus) 40%, white);
          --focus-300: color-mix(in srgb, var(--focus) 60%, white);
          --focus-600: color-mix(in srgb, var(--focus) 60%, black);
          --focus-700: color-mix(in srgb, var(--focus) 45%, black);
          --focus-muted: color-mix(in srgb, var(--focus) 60%, white);
          --focus-halo: 0 0 0 3px
            color-mix(in srgb, var(--focus) 30%, transparent);
          --color-focus: var(--focus-muted);
        }
      }

      .dialog-mask .dialog-container.headless {
        background: var(--surface, #fff);
      }

      .dialog-header {
        position: relative;
      }

      /* the bottom padding includes the strip the sheet covers, so the
         title sits centered in the visible part of the header */
      .header-text {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 12px;
        padding: 15px 24px calc(15px + var(--dialog-sheet-overlap, 22px)) 24px;
        color: var(--header-text, #fff);
      }

      .header-text .titles {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex-grow: 1;
        min-width: 0;
      }

      .header-text .title,
      .header-text .subtitle {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .header-text .title {
        font-size: 18.5px;
        font-weight: var(--w-bold, 700);
        letter-spacing: -0.02em;
        line-height: 1.15;
      }

      .header-text .subtitle {
        font-size: 13px;
        font-weight: var(--w-regular, 400);
        line-height: 1.35;
        opacity: 0.85;
      }

      .dialog-sheet {
        position: relative;
        display: flex;
        flex-direction: column;
        flex-grow: 1;
        min-height: 0;
        margin-top: calc(var(--dialog-sheet-overlap, 22px) * -1);
        background: var(--surface, #fff);
        border-radius: 16px 16px 0 0;
        box-shadow: 0 -6px 18px -6px
          var(--dialog-sheet-shadow, rgba(0, 0, 0, 0.22));
      }

      .headless .dialog-sheet {
        margin-top: 0;
        border-radius: 0;
        box-shadow: none;
      }

      /* "flat" variant: one continuous white surface with a plain title,
         for content-focused dialogs. */
      :host([variant='flat']) .dialog-mask .dialog-container {
        background: var(--surface, #fff);
      }

      :host([variant='flat']) .header-text {
        padding-bottom: 0;
        color: var(--text-1, #1a1f26);
      }

      :host([variant='flat']) .header-text .title {
        font-size: 17px;
        font-weight: var(--w-semibold, 600);
      }

      :host([variant='flat']) .dialog-sheet {
        margin-top: 0;
        border-radius: 0;
        box-shadow: none;
      }

      :host([variant='flat']) .dialog-footer {
        border-top: none;
        padding-top: 0;
      }

      .header-text .status {
        font-size: 0.6em;
        font-weight: bold;
      }

      .dialog-footer {
        background: var(--dialog-footer-background, transparent);
        border-top: 1px solid var(--border, #e6e8ec);
        padding: var(--dialog-footer-padding-top, 12px) 16px 12px 24px;
        display: flex;
        flex-flow: row;
        align-items: center;
        gap: 10px;
      }

      .dialog-body temba-loading {
        position: absolute;
        right: 12px;
        margin-top: -30px;
        padding-bottom: 9px;
        display: none;
      }

      #page-loader {
        text-align: center;
        display: block;
        position: relative;
        opacity: 0;
        margin: auto;
        margin-top: 30px;
        width: 154px;
        transition: opacity calc(var(--transition-speed) * 5ms) ease-in
          calc(var(--transition-speed * 2));
        visibility: hidden;
      }

      .dialog-mask.dialog-loading #page-loader {
        opacity: 1;
        visibility: visible;
      }

      #submit-loader {
        flex-grow: 1;
        text-align: right;
      }
    `;
  }

  @property({ type: Boolean })
  open: boolean;

  @property()
  header: string;

  // optional second line under the header
  @property()
  subtitle: string;

  @property()
  body: string;

  @property({ type: Boolean })
  submitting: boolean;

  @property({ type: Boolean })
  destructive: boolean;

  @property({ type: Boolean })
  disabled: boolean;

  @property({ type: Boolean })
  loading: boolean;

  @property({ type: Boolean })
  hideOnClick: boolean;

  @property({ type: String, reflect: true })
  variant: string;

  @property({ type: Boolean })
  noFocus: boolean;

  @property()
  size = 'medium';

  @property({ type: String })
  primaryButtonName = 'Ok';

  @property({ type: String })
  cancelButtonName = 'Cancel';

  @property({ type: String })
  width = null;

  @property()
  submittingName = 'Saving';

  @property()
  animationEnd: boolean;

  @property()
  ready: boolean;

  @property({ type: Array })
  buttons: DialogButton[] = [];

  @property({ attribute: false })
  onButtonClicked: (button: Button) => void;

  // when set, consulted instead of the built-in edit tracking to decide
  // whether escape should confirm before dismissing — for owners that can
  // compare actual values (and so ignore edits that were reverted)
  @property({ attribute: false })
  checkForChanges?: () => boolean;

  @property({ type: Number })
  originX: number | null = null;

  @property({ type: Number })
  originY: number | null = null;

  // whether any input/change has bubbled from our content since opening;
  // the default signal that escape would discard the user's edits
  private contentEdited = false;

  // elements the user has actually interacted with (pointer or key) since the
  // dialog opened; components fire synthetic change events on programmatic
  // value changes (initialization of preset values, async option resolution),
  // so an input/change only counts as an edit when it originates from an
  // element the user has touched
  private interactedElements = new WeakSet<EventTarget>();

  scrollOffset: any = 0;

  private wasVisible = false;

  // the dialog color as an "r, g, b" triplet, used for focus rings
  @state()
  private themeFocusRgb = '';

  // whether the dialog color is too light to carry white text
  @state()
  private themeLight = false;

  private static colorCanvas: CanvasRenderingContext2D | null = null;

  // set while the exit plays, so repeat calls share it
  private exiting: Promise<void> | null = null;
  private exitAnimations: Animation[] = [];

  // whether the primary button was the last one used, which makes a close
  // read as the action being submitted rather than dismissed
  private primaryClicked = false;

  public constructor() {
    super();
  }

  private updateButtons() {
    this.buttons = [];
    if (this.cancelButtonName) {
      this.buttons.push({
        name: this.cancelButtonName,
        type: ButtonType.SECONDARY,
        closes: true
      });
    }

    if (this.primaryButtonName) {
      this.buttons.push({
        name: this.primaryButtonName,
        type: ButtonType.PRIMARY
      });
    }
  }

  public willUpdate(changes: PropertyValues) {
    super.willUpdate(changes);

    if (changes.has('cancelButtonName') || changes.has('primaryButtonName')) {
      this.updateButtons();
    }

    if (changes.has('open') && this.open) {
      // the entrance is played by unfold(), so skip the css transform
      this.animationEnd = true;

      // clear what a previous exit left behind
      this.exitAnimations.forEach((animation) => animation.cancel());
      this.exitAnimations = [];
      this.exiting = null;
      this.primaryClicked = false;
    }
  }

  public updated(changes: Map<string, any>) {
    super.updated(changes);

    const visible = this.open && !this.loading;
    if (visible && !this.wasVisible) {
      this.updateThemeFocus();
      requestAnimationFrame(() => this.unfold());
    }
    this.wasVisible = visible;

    // closing on our own (cancel, escape, or an owner like modax finishing
    // its action) plays the exit
    if (changes.has('open') && !this.open && changes.get('open')) {
      this.exit(this.primaryClicked ? 'submit' : 'cancel');
    }

    if (changes.has('open')) {
      this.contentEdited = false;
      this.interactedElements = new WeakSet<EventTarget>();
      const body = document.querySelector('body');

      if (this.open) {
        this.originX = null;
        this.originY = null;
        window.setTimeout(() => {
          this.ready = true;
          this.animationEnd = false;
        }, 400);

        this.scrollOffset = -document.documentElement.scrollTop;
        body.style.position = 'fixed';
        body.style.overflowY = 'scroll';
        body.style.top = this.scrollOffset + 'px';
        body.style.width = '100%';
        body.style.overflowY = 'hidden';
      } else {
        body.style.position = '';
        body.style.overflowY = '';
        body.style.width = '';
        body.style.marginRight = '';
        body.style.paddingRight = '0px';
        window.scrollTo(0, parseInt(this.scrollOffset || '0') * -1);
      }

      // make sure our buttons aren't in progress on show
      if (this.open && !changes.get('open')) {
        this.shadowRoot
          .querySelectorAll('temba-button')
          .forEach((button: Button) => {
            if (button) button.submitting = false;
          });
      } else {
        // holding the ready state through the exit keeps the css transform
        // from pulling the card down while it plays
        (this.exiting || Promise.resolve()).then(() =>
          window.setTimeout(() => {
            this.ready = false;
          }, 400)
        );
      }
    }
  }

  // read at the moment the dialog shows, since owners like modax set
  // --header-bg once their content has loaded
  private updateThemeFocus(): void {
    const color = getComputedStyle(this).getPropertyValue('--header-bg').trim();
    const rgb = color ? Dialog.toRgbTriplet(color) : '';
    const channels = rgb ? rgb.split(',').map((part) => Number(part)) : [];

    this.themeLight =
      channels.length === 3 &&
      Dialog.luminance(channels) > Dialog.LIGHT_LUMINANCE;

    // a light color makes a faint ring, so focus uses a deeper shade of it
    this.themeFocusRgb = this.themeLight
      ? Dialog.deepen(channels).join(', ')
      : rgb;
  }

  // relative luminance above which a color is too light for white text,
  // well clear of the mid-tone colors (node types, say) that carry it fine
  private static LIGHT_LUMINANCE = 0.6;

  // WCAG relative luminance of 0-255 rgb channels
  private static luminance(channels: number[]): number {
    const [r, g, b] = channels.map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // the same hue at a lightness that reads against white
  private static deepen(channels: number[]): number[] {
    const [r, g, b] = channels.map((channel) => channel / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let hue = 0;
    if (delta) {
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }

    const lightness = (max + min) / 2;
    // HSL calls any pale color with a channel at 255 fully saturated, so
    // scale by how much color there really is (its chroma) to keep a
    // barely tinted color from deepening into a vivid one
    const saturation = delta
      ? (delta / (1 - Math.abs(2 * lightness - 1))) * Math.min(1, delta / 0.2)
      : 0;
    const target = Math.min(lightness, 0.42);

    // back to rgb at the new lightness
    const chroma = (1 - Math.abs(2 * target - 1)) * saturation;
    const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = target - chroma / 2;
    const [r1, g1, b1] =
      hue < 60
        ? [chroma, x, 0]
        : hue < 120
          ? [x, chroma, 0]
          : hue < 180
            ? [0, chroma, x]
            : hue < 240
              ? [0, x, chroma]
              : hue < 300
                ? [x, 0, chroma]
                : [chroma, 0, x];
    return [r1, g1, b1].map((channel) => Math.round((channel + m) * 255));
  }

  private static toRgbTriplet(color: string): string {
    if (!Dialog.colorCanvas) {
      Dialog.colorCanvas = document.createElement('canvas').getContext('2d');
    }
    const ctx = Dialog.colorCanvas;
    if (!ctx) {
      return '';
    }

    // the canvas normalizes any css color to #rrggbb, or rgba() when it
    // has transparency
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    const normalized = String(ctx.fillStyle);
    if (normalized.startsWith('#')) {
      const n = parseInt(normalized.slice(1, 7), 16);
      return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
    }
    const match = normalized.match(/rgba?\(([^)]+)\)/);
    return match
      ? match[1]
          .split(',')
          .slice(0, 3)
          .map((part) => part.trim())
          .join(', ')
      : '';
  }

  /** The header unfurls from a thin line, then the sheet slides up into it. */
  private unfold(): void {
    const container = this.shadowRoot?.querySelector(
      '.dialog-container'
    ) as HTMLElement;
    const header = this.shadowRoot?.querySelector(
      '.dialog-header'
    ) as HTMLElement;
    if (
      !container ||
      !header ||
      !container.animate ||
      this.isMobile() ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }

    const sheet = this.shadowRoot.querySelector('.dialog-sheet') as HTMLElement;
    const titles = this.shadowRoot.querySelector('.titles') as HTMLElement;
    const overlap = sheet ? header.offsetHeight - sheet.offsetTop : 0;
    const height = container.offsetHeight;
    const width = container.offsetWidth;
    const band = header.offsetHeight - overlap;

    // the clip hides the shadow, so bring it back once the card is whole
    container.style.boxShadow = 'none';
    const card = container.animate(
      [
        {
          clipPath: `inset(${band / 2}px ${width * 0.42}px ${height - band / 2}px round 4px)`,
          offset: 0
        },
        {
          clipPath: `inset(0px 0px ${height - band}px round 18px 18px 6px 6px)`,
          offset: 0.45
        },
        { clipPath: 'inset(0px 0px 0px round 18px)', offset: 1 }
      ],
      { duration: 840, easing: 'cubic-bezier(.45,0,.2,1)' }
    );
    const restoreShadow = () => (container.style.boxShadow = '');
    card.onfinish = restoreShadow;
    card.oncancel = restoreShadow;

    titles?.animate(
      [
        { opacity: 0, transform: 'translateY(10px)' },
        { opacity: 1, transform: 'none' }
      ],
      {
        delay: 360,
        duration: 400,
        easing: 'cubic-bezier(.16,1,.3,1)',
        fill: 'backwards'
      }
    );

    sheet?.animate(
      [
        { transform: 'translateY(72px)', opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { transform: 'none', opacity: 1 }
      ],
      {
        delay: 380,
        duration: 660,
        easing: 'cubic-bezier(.22,1.28,.36,1)',
        fill: 'backwards'
      }
    );
  }

  /** Whether exit() will animate, or finish right away. */
  public canAnimateExit(): boolean {
    const container = this.shadowRoot?.querySelector(
      '.dialog-container'
    ) as HTMLElement;
    return (
      !!container?.animate &&
      !this.isMobile() &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /**
   * Plays the dialog's way out. A submit tucks the sheet up into the header
   * and lifts the card away; a cancel dips the sheet and drops the card.
   * Neither claims the action worked, since owners may still be waiting on
   * it. Owners that remove the dialog when they're done can wait on this.
   */
  public exit(kind: 'submit' | 'cancel'): Promise<void> {
    if (this.exiting) {
      return this.exiting;
    }
    if (!this.canAnimateExit()) {
      this.exiting = Promise.resolve();
      return this.exiting;
    }

    const root = this.shadowRoot;
    const container = root.querySelector('.dialog-container') as HTMLElement;
    const header = root.querySelector('.dialog-header') as HTMLElement;
    const sheet = root.querySelector('.dialog-sheet') as HTMLElement;
    const mask = root.querySelector('.dialog-mask') as HTMLElement;

    const run = (
      el: HTMLElement,
      keyframes: Keyframe[],
      delay: number,
      duration: number,
      easing: string
    ) => {
      if (el) {
        this.exitAnimations.push(
          el.animate(keyframes, { delay, duration, easing, fill: 'both' })
        );
      }
    };

    const drop = [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translateY(14px) scale(0.96)' }
    ];
    const fade = [{ opacity: 1 }, { opacity: 0 }];
    let total: number;

    if (kind === 'submit' && header && sheet) {
      const overlap = header.offsetHeight - sheet.offsetTop;
      run(
        sheet,
        [{ transform: 'none' }, { transform: 'translateY(105%)' }],
        0,
        320,
        'cubic-bezier(.5,0,.75,0)'
      );
      run(
        container,
        [
          { height: `${container.offsetHeight}px` },
          { height: `${header.offsetHeight - overlap}px` }
        ],
        60,
        400,
        'cubic-bezier(.16,1,.3,1)'
      );
      run(
        container,
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'translateY(-12px) scale(0.98)' }
        ],
        420,
        240,
        'cubic-bezier(.4,0,.7,.2)'
      );
      run(mask, fade, 440, 300, 'ease');
      total = 740;
    } else {
      run(
        sheet,
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'translateY(10px)' }
        ],
        0,
        180,
        'ease-in'
      );
      run(container, drop, 80, 260, 'cubic-bezier(.4,0,.7,.2)');
      run(mask, fade, 120, 300, 'ease');
      total = 420;
    }

    this.exiting = new Promise((resolve) => window.setTimeout(resolve, total));
    return this.exiting;
  }

  public focusFirstInput(): void {
    window.setTimeout(() => {
      let input = this.querySelector(
        'temba-textinput, temba-completion, input[type="text"], textarea'
      ) as any;
      if (input) {
        input = input.textInputElement || input.inputElement || input;
        if (!input.readOnly) {
          input.focus();
          input.click();
        }
      }
    }, 100);
  }

  public handleClick(evt: MouseEvent) {
    const button = evt.currentTarget as Button;
    if (!button.disabled) {
      let detail: DialogButton = {};
      if (button.index >= 0 && button.index < this.buttons.length) {
        detail = this.buttons[button.index];
      }

      this.primaryClicked = detail?.type === ButtonType.PRIMARY;
      this.fireCustomEvent(CustomEventType.ButtonClicked, { button, detail });
      if (button.name === this.cancelButtonName || (detail && detail.closes)) {
        this.open = false;
      }
    }
  }

  private getDocumentHeight(): number {
    const body = document.body;
    const html = document.documentElement;
    return Math.max(
      body.scrollHeight,
      body.offsetHeight,
      html.clientHeight,
      html.scrollHeight,
      html.offsetHeight
    );
  }

  private clickCancel() {
    const cancel = this.getCancelButton();
    if (cancel) {
      cancel.click();
    }
  }

  public getCancelButton(): Button {
    return this.shadowRoot.querySelector(
      `temba-button[name='${this.cancelButtonName}']`
    );
  }

  public getPrimaryButton(): Button {
    return this.shadowRoot.querySelector(`temba-button[primary]`);
  }

  public hasUnsavedChanges(): boolean {
    return this.checkForChanges ? this.checkForChanges() : this.contentEdited;
  }

  private handleContentInteraction(event: Event) {
    // still working in the dialog after using the primary button (a submit
    // that came back with errors, say), so a close from here is a cancel;
    // the primary button sets this again on its own click
    this.primaryClicked = false;

    // the path covers the interacted element and its ancestors, so a change
    // fired later by a containing component (e.g. a select whose inner input
    // was clicked) still matches
    event.composedPath().forEach((el) => this.interactedElements.add(el));
  }

  private handleContentEdited(event: Event) {
    // only the originating element is checked (not its ancestors, which the
    // paths of unrelated interactions also pass through)
    if (this.interactedElements.has(event.composedPath()[0])) {
      this.contentEdited = true;
    }
  }

  private handleKeyUp(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (
        this.hasUnsavedChanges() &&
        !window.confirm(Dialog.UNSAVED_CHANGES_MESSAGE)
      ) {
        return;
      }
      this.clickCancel();
    }
  }

  private handleClickMask(event: MouseEvent) {
    if (this.hideOnClick) {
      const id = (event.target as HTMLElement).id;
      if (id === 'dialog-mask' || id === 'dialog-bg') {
        this.fireCustomEvent(CustomEventType.DialogHidden);
        this.clickCancel();
      }
    }
  }

  public show(): void {
    this.open = true;
  }

  public hide(): void {
    this.open = false;
  }

  public render(): TemplateResult {
    const dialogStyle = {
      width: this.width
    };

    if (!this.width) {
      dialogStyle['width'] = Dialog.widths[this.size];
    }

    if (this.themeFocusRgb) {
      dialogStyle['--focus-rgb'] = this.themeFocusRgb;
    }

    if (this.isMobile()) {
      dialogStyle['width'] = '100%';
      dialogStyle['height'] = '100%';
      delete dialogStyle['maxWidth'];
    }

    const header = this.header
      ? html`
          <div class="dialog-header">
            <div class="header-text">
              <div class="titles">
                <div class="title">${this.header}</div>
                ${
                  this.subtitle
                    ? html`<div class="subtitle">${this.subtitle}</div>`
                    : null
                }
              </div>
            </div>
          </div>
        `
      : null;

    return html`
      <div
        id="dialog-mask"
        @click=${this.handleClickMask}
        class="dialog-mask ${getClasses({
          'dialog-open': this.open,
          'dialog-loading': this.loading,
          'dialog-animation-end': this.animationEnd,
          'dialog-ready': this.ready,
          mobile: this.isMobile()
        })}"
      >
        <div style="position: absolute; width: 100%;">
          <temba-loading
            id="page-loader"
            units="6"
            size="12"
            color="#ccc"
          ></temba-loading>
        </div>

        <div class="flex">
          <div
            class="grow-top"
            style="${this.isMobile() ? 'flex-grow:0' : ''}"
          ></div>
          <div
            @keyup=${this.handleKeyUp}
            @keydown=${this.handleContentInteraction}
            @pointerdown=${this.handleContentInteraction}
            @input=${this.handleContentEdited}
            @change=${this.handleContentEdited}
            style=${styleMap(dialogStyle)}
            class="dialog-container ${getClasses({
              headless: !this.header,
              themed: !!this.themeFocusRgb,
              light: this.themeLight
            })}"
          >
            ${header}
            <div class="dialog-sheet">
              <div class="dialog-body" @keypress=${this.handleKeyUp}>
                ${this.body ? this.body : html`<slot></slot>`}
                <temba-loading units="6" size="8"></temba-loading>
              </div>

              ${
                // the gutter check is render-time only (not reactive) - fine
                // while consumers slot gutter content declaratively up front
                this.buttons.length > 0 || this.querySelector('[slot="gutter"]')
                  ? html`<div class="dialog-footer">
                      <div class="flex-grow">
                        <slot name="gutter"></slot>
                      </div>
                      ${this.buttons.map(
                        (button: DialogButton, index) => html`
                          <temba-button
                            name=${button.name}
                            ?destructive=${
                              button.type == 'primary' && this.destructive
                            }
                            ?primary=${
                              button.type == 'primary' && !this.destructive
                            }
                            ?secondary=${button.type == 'secondary'}
                            ?submitting=${
                              this.submitting && button.type == 'primary'
                            }
                            ?disabled=${this.disabled && !button.closes}
                            index=${index}
                            @click=${this.handleClick}
                          ></temba-button>
                        `
                      )}
                    </div>`
                  : null
              }
            </div>
          </div>
          <div class="grow-bottom"></div>
        </div>
      </div>
    `;
  }
}
