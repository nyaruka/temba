import { css, html, PropertyValues, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { CustomEventType } from '../interfaces';
import { getClasses } from '../utils';

/**
 * The frame of a modal: the dimmed backdrop and a panel over it, with how
 * they come and go. Components with a modal of their own, e.g. the new
 * channel picker or a sheet, render their content inside one, so modals all
 * look and move the same.
 *
 * It's a `dialog` (centered, sized by `--modal-width` and `--modal-height`)
 * or a `sheet` (nearly the whole window). On a phone, a sheet takes all of it.
 *
 * It doesn't close itself: Escape or a click on the backdrop fires
 * `temba-dismiss-requested`, so its owner can decide what that means (go back
 * a step, say), and closing it is setting `open` false. Its exit plays before
 * it's gone, then it fires `temba-modal-closed`.
 */
export class Modal extends RapidElement {
  static get styles() {
    return css`
      :host {
        display: contents;
      }

      .root {
        position: fixed;
        inset: 0;
        z-index: var(--modal-z, 10001);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        box-sizing: border-box;
        padding: var(--modal-top, clamp(16px, 6vh, 64px)) 16px 0;
        font-family: var(--font, inherit);
        color: var(--text-1, #111);
      }

      .scrim {
        position: absolute;
        inset: 0;
        background: rgba(15, 22, 36, 0.42);
        -webkit-backdrop-filter: blur(4px) saturate(120%);
        backdrop-filter: blur(4px) saturate(120%);
      }

      .panel {
        position: relative;
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        width: 100%;
        max-width: var(--modal-width, 600px);
        height: var(--modal-height, auto);
        max-height: calc(
          100vh - var(--modal-top, clamp(16px, 6vh, 64px)) - clamp(
              24px,
              5vh,
              56px
            )
        );
        border-radius: var(--r-lg, 12px);
        background: var(--surface, #fff);
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
        overflow: hidden;
      }

      /* a sheet: nearly the whole window, on the page's background */
      .sheet.root {
        align-items: stretch;
        padding: 24px;
      }

      .sheet .panel {
        max-width: var(--modal-width, 1280px);
        height: auto;
        max-height: none;
        background: var(--bg, #f7f8fa);
      }

      .sheet.mobile.root {
        padding: 0;
      }

      .sheet.mobile .panel {
        border-radius: 0;
      }
    `;
  }

  @property({ type: Boolean, reflect: true })
  open = false;

  /** dialog (centered) or sheet (nearly the whole window) */
  @property({ type: String })
  size: 'dialog' | 'sheet' = 'dialog';

  /** what the modal is, for screen readers */
  @property({ type: String })
  label = '';

  /** whether we're showing, which outlasts `open` while the exit plays */
  @state()
  private showing = false;

  // the modals open, the topmost last, since only it answers to Escape
  private static stack: Modal[] = [];

  // the element that opened us, to give focus back to on closing - only when
  // it was opened from the keyboard, since giving focus back after a click
  // leaves whatever was clicked looking selected
  private returnFocus: HTMLElement = null;

  private exiting: Animation[] = [];

  /** whether modals animate, which they don't for those who've asked for less motion */
  public static animates(): boolean {
    return (
      typeof Element.prototype.animate === 'function' &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    );
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    const top = Modal.stack[Modal.stack.length - 1];
    if (event.key === 'Escape' && top === this && !event.defaultPrevented) {
      event.preventDefault();
      this.fireCustomEvent(CustomEventType.DismissRequested, {
        reason: 'escape'
      });
    }
  };

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this.leave();
  }

  protected willUpdate(changes: PropertyValues): void {
    super.willUpdate(changes);
    if (changes.has('open') && this.open) {
      const opener = document.activeElement as HTMLElement;
      this.returnFocus =
        opener && opener.matches && opener.matches(':focus-visible')
          ? opener
          : null;
      this.exiting.forEach((a) => a.cancel());
      this.exiting = [];
      this.showing = true;
    }
  }

  protected updated(changes: PropertyValues): void {
    super.updated(changes);
    if (changes.has('open')) {
      if (this.open) {
        this.enter();
      } else if (changes.get('open')) {
        this.exit();
      }
    }
  }

  private enter(): void {
    if (!Modal.stack.includes(this)) {
      Modal.stack.push(this);
    }
    document.addEventListener('keydown', this.handleKeyDown);

    if (Modal.animates()) {
      this.find('.scrim')?.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 200,
        easing: 'ease-out',
        fill: 'backwards'
      });
      this.find('.panel')?.animate(
        [
          { opacity: 0, transform: 'translateY(16px) scale(0.97)' },
          { opacity: 1, transform: 'none' }
        ],
        { duration: 375, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' }
      );
    }
  }

  private exit(): void {
    this.leave();

    const done = () => {
      if (this.open) {
        return;
      }
      this.exiting = [];
      this.showing = false;
      this.fireCustomEvent(CustomEventType.ModalClosed);
    };

    const scrim = this.find('.scrim');
    const panel = this.find('.panel');
    if (!Modal.animates() || !panel) {
      done();
      return;
    }

    // drop the panel away and fade the backdrop
    this.exiting = [
      scrim?.animate([{ opacity: 1 }, { opacity: 0 }], {
        delay: 120,
        duration: 300,
        easing: 'ease',
        fill: 'both'
      }),
      panel.animate(
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'translateY(14px) scale(0.96)' }
        ],
        {
          delay: 80,
          duration: 260,
          easing: 'cubic-bezier(.4,0,.7,.2)',
          fill: 'both'
        }
      )
    ].filter(Boolean);
    Promise.all(this.exiting.map((a) => a.finished)).then(done, done);
  }

  /** stops answering to Escape and gives focus back */
  private leave(): void {
    document.removeEventListener('keydown', this.handleKeyDown);
    Modal.stack = Modal.stack.filter((m) => m !== this);

    if (this.returnFocus && this.returnFocus.isConnected) {
      this.returnFocus.focus();
    } else if (
      document.activeElement instanceof HTMLElement &&
      (this.contains(document.activeElement) || this.matches(':focus-within'))
    ) {
      document.activeElement.blur();
    }
    this.returnFocus = null;
  }

  private find(selector: string): HTMLElement {
    return this.shadowRoot?.querySelector(selector) as HTMLElement;
  }

  public render(): TemplateResult {
    if (!this.showing) {
      return html``;
    }
    return html`
      <div
        class=${getClasses({
          root: true,
          sheet: this.size === 'sheet',
          mobile: this.isMobile()
        })}
      >
        <div
          class="scrim"
          @click=${() =>
            this.fireCustomEvent(CustomEventType.DismissRequested, {
              reason: 'backdrop'
            })}
        ></div>
        <div
          class="panel"
          role="dialog"
          aria-modal="true"
          aria-label=${this.label}
        >
          <slot></slot>
        </div>
      </div>
    `;
  }
}
