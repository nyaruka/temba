import { css, html, PropertyValues, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { msg } from '@lit/localize';
import { RapidElement } from '../RapidElement';
import { CustomEventType } from '../interfaces';
import { Icon } from '../Icons';
import { Modal } from './Modal';
import {
  clearLightContent,
  getClasses,
  getUrl,
  setLightContent,
  WebResponse
} from '../utils';

/** One view the sheet has loaded, the last being the one showing */
interface SheetView {
  endpoint: string;
  header: string;
  subtitle: string;
}

/**
 * A large modal over the page, for going deeper into something a dashboard
 * summarizes. It fetches a view's content (the server renders it without the
 * page around it, see the X-Temba-Sheet header) into its light DOM, so the
 * page's styles apply to it as they would on a page of its own.
 *
 * A sheet shows one thing. It can go a level deeper within that thing, e.g.
 * from a list of logs to one log, with a back button to return, but it never
 * switches to something else - that's opened from the page instead.
 */
export class Sheet extends RapidElement {
  static get styles() {
    return css`
      /* the backdrop, panel and how they come and go are temba-modal's */
      :host {
        display: contents;
      }

      .header {
        flex: none;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 16px 14px 20px;
        background: var(--surface, #fff);
        border-bottom: 1px solid var(--border, #e5e7eb);
      }

      /* the page can give every sheet an icon, e.g. its channel's logo */
      ::slotted([slot='icon']) {
        flex: none;
      }

      .titles {
        flex: 1;
        min-width: 0;
      }

      .title {
        font-size: 16px;
        font-weight: var(--w-semibold, 600);
        color: var(--text-1, #111);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .subtitle {
        margin-top: 2px;
        font-size: 12.5px;
        color: var(--text-3, #6b7280);
      }

      .back,
      .close {
        flex: none;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border: none;
        border-radius: var(--r-sm, 6px);
        background: transparent;
        color: var(--text-2, #374151);
        cursor: pointer;
        --icon-color: var(--text-2, #374151);
      }

      .back:hover,
      .close:hover {
        background: var(--sunken, #f1f3f5);
      }

      .back:focus-visible,
      .close:focus-visible {
        outline: 2px solid var(--accent, #2563eb);
        outline-offset: 1px;
      }

      .body {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }

      /* the content scrolls within the sheet, and content that fills it (a
         list that scrolls itself, say) can take the room as a flex child */
      ::slotted(.light-content) {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: auto;
        padding: 20px;
      }

      .body.mobile ::slotted(.light-content) {
        padding: 12px;
      }

      /* content that fills the sheet edge to edge, e.g. a list beside the
         item selected in it */
      ::slotted(.light-content.fill),
      .body.mobile ::slotted(.light-content.fill) {
        padding: 0;
        overflow: hidden;
      }

      .loading {
        margin: 48px auto;
      }
    `;
  }

  @property({ type: Boolean, reflect: true })
  open = false;

  @state()
  private views: SheetView[] = [];

  @state()
  private loading = false;

  /** how wide the sheet is, in pixels, when narrower than the default suits what it shows */
  @state()
  private width: number = null;

  // bumped on every load so a slow response can't land over a newer one
  private loadId = 0;

  // a link in the content marked with data-sheet-push="<title>" goes a level deeper in the sheet rather than leaving it
  private handleClick = (event: MouseEvent) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.button !== 0
    ) {
      return;
    }
    const link = (event.target as Element).closest(
      'a[data-sheet-push]'
    ) as HTMLAnchorElement;
    if (link && this.contains(link)) {
      event.preventDefault();
      this.push(
        link.getAttribute('href'),
        link.dataset.sheetPush,
        this.current ? this.current.header : ''
      );
    }
  };

  /** Opens the sheet on a view, replacing whatever it showed */
  public show(
    endpoint: string,
    header: string,
    subtitle = '',
    width: number = null
  ): void {
    this.width = width;
    this.views = [{ endpoint, header, subtitle }];
    this.open = true;
    this.load();
  }

  /** Goes a level deeper within what the sheet shows, which back returns from */
  public push(endpoint: string, header: string, subtitle = ''): void {
    this.views = [...this.views, { endpoint, header, subtitle }];
    this.load();
  }

  public back(): void {
    if (this.views.length > 1) {
      this.views = this.views.slice(0, -1);
      this.load();
    }
  }

  public close(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.loadId++;
    this.fireCustomEvent(CustomEventType.DialogHidden);
  }

  // once the modal's exit has played, clear the content so its scripts stop finding it
  private handleModalClosed(): void {
    if (!this.open) {
      clearLightContent(this);
      this.views = [];
    }
  }

  /** How many levels deep the sheet is, 1 being what it was opened on */
  public get depth(): number {
    return this.views.length;
  }

  /** The view showing, if any */
  public get current(): SheetView | null {
    return this.views.length ? this.views[this.views.length - 1] : null;
  }

  public connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('click', this.handleClick);
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('click', this.handleClick);
  }

  protected updated(changes: PropertyValues): void {
    super.updated(changes);
    if (changes.has('open') && this.open) {
      // once the modal's open, so it knows what had focus before
      const modal = this.shadowRoot.querySelector(
        'temba-modal'
      ) as unknown as Modal;
      modal?.updateComplete.then(() => {
        const close = this.shadowRoot.querySelector('.close') as HTMLElement;
        close?.focus();
      });
    }
  }

  private load(): void {
    const view = this.current;
    if (!view) {
      return;
    }

    const id = ++this.loadId;
    this.loading = true;
    clearLightContent(this);

    getUrl(view.endpoint, null, { 'X-Temba-Spa': '1', 'X-Temba-Sheet': '1' })
      .then((response: WebResponse) => {
        if (id !== this.loadId) {
          return;
        }

        // a full page means we were sent somewhere that can't be shown here
        if (response.body.indexOf('<!DOCTYPE HTML>') === 0) {
          document.location = response.url;
          return;
        }

        setLightContent(this, response.body);
        this.loading = false;
        this.fireCustomEvent(CustomEventType.Loaded, {
          endpoint: view.endpoint
        });
      })
      .catch(() => {
        if (id === this.loadId) {
          this.loading = false;
          setLightContent(
            this,
            `<div class="dash-empty">${msg('Something went wrong loading this.')}</div>`
          );
        }
      });
  }

  public render(): TemplateResult {
    const view = this.current;

    return html`
      <temba-modal
        size="sheet"
        style=${this.width ? `--modal-width: ${this.width}px` : ''}
        .open=${this.open}
        label=${view ? view.header : ''}
        @temba-dismiss-requested=${() => this.close()}
        @temba-modal-closed=${this.handleModalClosed}
      >
        <div class="header">
          ${this.views.length > 1
            ? html`<button
                class="back"
                title=${msg('Back')}
                aria-label=${msg('Back')}
                @click=${() => this.back()}
              >
                <temba-icon name=${Icon.arrow_left} size="1.1"></temba-icon>
              </button>`
            : null}
          <slot name="icon"></slot>
          <div class="titles">
            <div class="title">${view ? view.header : ''}</div>
            ${view && view.subtitle
              ? html`<div class="subtitle">${view.subtitle}</div>`
              : null}
          </div>
          <button
            class="close"
            title=${msg('Close')}
            aria-label=${msg('Close')}
            @click=${() => this.close()}
          >
            <temba-icon name=${Icon.close} size="1.1"></temba-icon>
          </button>
        </div>
        <div class=${getClasses({ body: true, mobile: this.isMobile() })}>
          ${this.loading
            ? html`<temba-loading
                class="loading"
                units="6"
                size="10"
              ></temba-loading>`
            : null}
          <slot></slot>
        </div>
      </temba-modal>
    `;
  }
}
