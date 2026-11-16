import { css, html, PropertyValues, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { msg } from '@lit/localize';
import { RapidElement } from '../RapidElement';
import { CustomEventType } from '../interfaces';
import { Icon } from '../Icons';
import {
  clearLightContent,
  getClasses,
  getUrl,
  setLightContent,
  WebResponse
} from '../utils';

/**
 * A list beside the item selected in it: with nothing selected the list fills
 * the space, and selecting an item puts the list in a column on the left with
 * the item's own view on the right. On a phone they take turns.
 *
 * The list scrolls infinitely, following the `next` URL of a cursor-paged
 * endpoint (one returning `results` and `next`) as it nears the bottom. The
 * selected item's view is fetched from its URL (the server renders it without
 * the page around it, see the X-Temba-Sheet header) into our light DOM, so
 * the page's styles apply to it.
 *
 * Subclasses say how to show an item and where its view is.
 */
export abstract class SplitList<T> extends RapidElement {
  static get styles() {
    return css`
      :host {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
      }

      /* edge to edge, with no frame of its own - whatever it fills (a sheet,
         a page) is the frame. The list is a white column and the selected
         item sits beside it on the page background. */
      .split {
        flex: 1;
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        min-height: 0;
        font-family: var(--font, inherit);
        color: var(--text-1, #111);
      }

      .split.with-detail {
        grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
      }

      .list {
        min-height: 0;
        overflow-y: auto;
        outline: none;
        background: var(--surface, #fff);
      }

      .with-detail .list {
        border-right: 1px solid var(--border, #e5e7eb);
      }

      .row {
        display: grid;
        grid-template-columns: 8px minmax(0, 1fr) auto;
        align-items: center;
        gap: 12px;
        width: 100%;
        padding: 9px 16px;
        border: none;
        border-bottom: 1px solid var(--border, #e5e7eb);
        background: none;
        font: inherit;
        font-size: 13px;
        color: inherit;
        text-align: left;
        cursor: pointer;
      }

      .row:hover {
        background: var(--sunken, #f6f8fb);
      }

      .row.selected {
        background: var(--accent-50, #eef4ff);
      }

      .row:focus-visible {
        outline: 2px solid var(--accent, #2563eb);
        outline-offset: -2px;
      }

      .status {
        padding: 16px;
        color: var(--text-3, #6b7280);
        font-size: 13px;
        text-align: center;
      }

      .empty {
        padding: 48px 16px;
      }

      temba-loading {
        display: block;
        margin: 12px auto;
        width: 120px;
      }

      .detail {
        position: relative;
        min-height: 0;
        min-width: 0;
        overflow: auto;
        padding: 20px 24px;
        background: var(--bg, #f7f8fa);
      }

      /* the item's own view gives its title. On a phone, where it replaces
         the list, a back button above it returns to the list */
      .back {
        display: none;
        align-items: center;
        gap: 4px;
        margin: -6px 0 12px -6px;
        padding: 6px;
        border: none;
        border-radius: var(--r-sm, 6px);
        background: none;
        color: var(--accent, #2563eb);
        font: inherit;
        font-size: 13px;
        font-weight: var(--w-medium, 500);
        cursor: pointer;
        --icon-color: var(--accent, #2563eb);
      }

      .back:focus-visible {
        outline: 2px solid var(--accent, #2563eb);
        outline-offset: 1px;
      }

      /* on a phone, the selected item replaces the list */
      .mobile.with-detail {
        grid-template-columns: minmax(0, 1fr);
      }

      .mobile.with-detail .list {
        display: none;
      }

      .mobile .detail {
        padding: 16px;
      }

      .mobile .back {
        display: inline-flex;
      }
    `;
  }

  @property({ type: String })
  endpoint: string;

  @property({ type: String, attribute: 'empty-message' })
  emptyMessage = '';

  /** the URL of the selected item's view, shown beside the list */
  @property({ type: String, reflect: true })
  selected = '';

  @state()
  protected items: T[] = [];

  @state()
  private nextUrl: string = null;

  @state()
  private fetching = false;

  @state()
  private loaded = false;

  @state()
  private loadingDetail = false;

  // bumped on each fetch, so a slow response can't land over a newer one
  private listId = 0;
  private detailId = 0;

  /** renders an item's row, after its status dot */
  protected abstract renderItem(item: T): TemplateResult;

  /** the URL of an item's own view */
  protected abstract getItemUrl(item: T): string;

  /** a class for an item's row, e.g. "bad" to mark it as a problem */
  protected getItemClass(_item: T): string {
    return '';
  }

  /** the selected item's name, for screen readers - its view shows its title */
  protected getItemTitle(_item: T): string {
    return '';
  }

  protected defaultEmptyMessage(): string {
    return msg('Nothing to show');
  }

  protected updated(changes: PropertyValues): void {
    super.updated(changes);

    if (changes.has('endpoint') && this.endpoint) {
      this.items = [];
      this.nextUrl = null;
      this.loaded = false;
      this.fetchPage(this.endpoint, ++this.listId);
    }

    if (changes.has('selected')) {
      this.loadDetail();
    }
  }

  private fetchPage(url: string, id: number): void {
    this.fetching = true;
    getUrl(url)
      .then((response: WebResponse) => {
        if (id !== this.listId) {
          return;
        }
        const page = response.json as { results?: T[]; next?: string };
        this.items = [...this.items, ...(page.results || [])];
        this.nextUrl = page.next || null;
        this.loaded = true;
        this.fetching = false;

        // keep going until the list can scroll, or there's no more
        this.updateComplete.then(() => this.fetchMoreIfNear());
      })
      .catch(() => {
        if (id === this.listId) {
          this.fetching = false;
          this.loaded = true;
        }
      });
  }

  private fetchMoreIfNear(): void {
    const list = this.shadowRoot.querySelector('.list') as HTMLElement;
    if (
      list &&
      this.nextUrl &&
      !this.fetching &&
      list.scrollTop + list.clientHeight > list.scrollHeight - 240
    ) {
      this.fetchPage(this.nextUrl, this.listId);
    }
  }

  private loadDetail(): void {
    const id = ++this.detailId;
    clearLightContent(this);

    if (!this.selected) {
      this.loadingDetail = false;
      return;
    }

    this.loadingDetail = true;
    getUrl(this.selected, null, { 'X-Temba-Spa': '1', 'X-Temba-Sheet': '1' })
      .then((response: WebResponse) => {
        if (id === this.detailId) {
          setLightContent(this, response.body);
          this.loadingDetail = false;
        }
      })
      .catch(() => {
        if (id === this.detailId) {
          this.loadingDetail = false;
          setLightContent(
            this,
            `<div class="dash-empty">${msg('Something went wrong loading this.')}</div>`
          );
        }
      });
  }

  /** selects an item, showing its view beside the list */
  public select(item: T): void {
    const url = this.getItemUrl(item);
    if (url !== this.selected) {
      this.selected = url;
      this.fireCustomEvent(CustomEventType.Selection, { item, url });
    }
  }

  /** goes back to the list on its own */
  public clearSelection(): void {
    if (this.selected) {
      this.selected = '';
      this.fireCustomEvent(CustomEventType.Selection, {
        item: null,
        url: null
      });
    }
  }

  private get selectedIndex(): number {
    return this.items.findIndex((i) => this.getItemUrl(i) === this.selected);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const index = this.selectedIndex;
    const next =
      event.key === 'ArrowDown'
        ? Math.min(index + 1, this.items.length - 1)
        : Math.max(index - 1, 0);
    if (this.items[next]) {
      this.select(this.items[next]);
      this.updateComplete.then(() => {
        const row = this.shadowRoot.querySelector(
          '.row.selected'
        ) as HTMLElement;
        if (row) {
          row.scrollIntoView({ block: 'nearest' });
          row.focus();
        }
      });
    }
  }

  public render(): TemplateResult {
    const selectedItem = this.items[this.selectedIndex];

    return html`
      <div
        class=${getClasses({
          split: true,
          'with-detail': !!this.selected,
          mobile: this.isMobile()
        })}
      >
        <div
          class="list"
          role="listbox"
          @scroll=${() => this.fetchMoreIfNear()}
          @keydown=${this.handleKeyDown}
        >
          ${this.items.map((item) => {
            const url = this.getItemUrl(item);
            return html`<button
              class="row ${this.getItemClass(item)} ${url === this.selected
                ? 'selected'
                : ''}"
              role="option"
              aria-selected=${url === this.selected ? 'true' : 'false'}
              @click=${() => this.select(item)}
            >
              ${this.renderItem(item)}
            </button>`;
          })}
          ${this.fetching
            ? html`<temba-loading units="5" size="10"></temba-loading>`
            : null}
          ${this.loaded && !this.fetching && !this.items.length
            ? html`<div class="status empty">
                ${this.emptyMessage || this.defaultEmptyMessage()}
              </div>`
            : null}
        </div>
        ${this.selected
          ? html`<div
              class="detail"
              role="region"
              aria-label=${selectedItem ? this.getItemTitle(selectedItem) : ''}
            >
              <button class="back" @click=${() => this.clearSelection()}>
                <temba-icon name=${Icon.arrow_left}></temba-icon>
                ${msg('Back')}
              </button>
              ${this.loadingDetail
                ? html`<temba-loading units="5" size="10"></temba-loading>`
                : null}
              <slot></slot>
            </div>`
          : null}
      </div>
    `;
  }
}
