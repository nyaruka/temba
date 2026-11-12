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
  getHTTPCookie,
  getUrl,
  postUrl,
  serialize,
  serializeFiles,
  setLightContent,
  WebResponse
} from '../utils';

/** whether a form posts - read from its attribute, as a field named method would shadow the property */
const isPosting = (form: HTMLFormElement): boolean =>
  (form.getAttribute('method') || '').toLowerCase() === 'post';

/** the headers which have a view render just its content, for a sheet */
const SHEET_HEADERS = { 'X-Temba-Spa': '1', 'X-Temba-Sheet': '1' };

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

  // where the content showing came from, which a form in it without an action of its own posts back to
  private contentUrl: string = null;

  // a form in the content which posts, e.g. reconnecting an account, is submitted here rather than leaving the page -
  // other forms, e.g. a search, are left to submit as they would
  private handleSubmit = (event: SubmitEvent) => {
    const form = event.target as HTMLFormElement;
    if (
      form instanceof HTMLFormElement &&
      this.contains(form) &&
      isPosting(form)
    ) {
      event.preventDefault();
      this.submitForm(form, event.submitter);
    }
  };

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
    this.addEventListener('submit', this.handleSubmit);
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('click', this.handleClick);
    this.removeEventListener('submit', this.handleSubmit);
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

    getUrl(view.endpoint, null, SHEET_HEADERS)
      .then((response: WebResponse) => {
        if (id !== this.loadId || this.leaveFor(response)) {
          return;
        }

        // a view which sends us elsewhere on loading, e.g. as a step is already done, goes there
        const success = response.headers.get('X-Temba-Success');
        if (success) {
          document.location = success;
          return;
        }

        this.setContent(response);
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

  /** Posts a form in the content, then shows what comes back, or reloads the page if it sends us back to it */
  private submitForm(
    form: HTMLFormElement,
    submitter: HTMLElement = null
  ): void {
    // a sign-in popup can come back to the site from another one, which leaves out a strict CSRF cookie so the page it
    // loads sets a new one - post the current cookie's token, not the one the form was rendered with
    const csrf = getHTTPCookie('csrftoken');
    const csrfInput = form.querySelector(
      '[name=csrfmiddlewaretoken]'
    ) as HTMLInputElement;
    if (csrf && csrfInput) {
      csrfInput.value = csrf;
    }

    let payload: any = serialize(form);

    // which button submitted it, as a native submit would say
    const button = submitter as HTMLButtonElement;
    if (button && button.name) {
      payload +=
        (payload ? '&' : '') +
        new URLSearchParams({ [button.name]: button.value }).toString();
    }

    let contentType = 'application/x-www-form-urlencoded';
    const files = serializeFiles(form);
    if (files) {
      new URLSearchParams(payload).forEach((value, key) =>
        files.append(key, value)
      );
      payload = files;
      contentType = null;
    }

    const id = ++this.loadId;
    this.loading = true;
    postUrl(
      form.getAttribute('action') || this.contentUrl,
      payload,
      SHEET_HEADERS,
      contentType
    )
      .then((response: WebResponse) => {
        if (id !== this.loadId) {
          return;
        }

        // a form done with sends us back to the page under the sheet, which it has changed (e.g. by reconnecting), so
        // reload it - views give that as X-Temba-Success, the URL of a redirect followed would be rendered for nothing
        const next = response.headers.get('X-Temba-Success') || response.url;
        if (next) {
          const path = new URL(next, window.location.href).pathname;
          if (path === window.location.pathname) {
            document.location = path;
            return;
          }
        }

        // anywhere else, e.g. the next step of verifying a number, shows in the sheet in its place
        const success = response.headers.get('X-Temba-Success');
        if (success) {
          this.views = [
            ...this.views.slice(0, -1),
            { ...this.current, endpoint: success }
          ];
          this.load();
          return;
        }

        if (!this.leaveFor(response)) {
          this.setContent(response);
        }
      })
      .catch(() => {
        if (id === this.loadId) {
          this.loading = false;
          setLightContent(
            this,
            `<div class="dash-empty">${msg('Something went wrong submitting this.')}</div>`
          );
        }
      });
  }

  /** Leaves the page for wherever a response came from if it's a full page, which can't be shown here */
  private leaveFor(response: WebResponse): boolean {
    if (response.body.indexOf('<!DOCTYPE HTML>') === 0) {
      document.location = response.url;
      return true;
    }
    return false;
  }

  private setContent(response: WebResponse): void {
    setLightContent(this, response.body);
    this.contentUrl = response.url;
    this.loading = false;

    // a script of the content's submitting one of its forms directly, as on signing in with Facebook, goes through
    // us too, without the validation a submit button would bring - a script building a form later has to submit it
    // with requestSubmit()
    for (const form of Array.from(this.querySelectorAll('form'))) {
      if (isPosting(form)) {
        (form as any).submit = () => this.submitForm(form);
      }
    }
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
