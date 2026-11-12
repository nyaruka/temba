import { css, html, PropertyValues, TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { CustomEventType } from '../interfaces';
import { RapidElement } from '../RapidElement';
import { Store } from '../store/Store';
import { fetchResultsPage, ResultsPage } from '../utils';

const DEFAULT_REFRESH = 10000;

export class TembaList extends RapidElement {
  @property({ type: Array, attribute: false })
  items: any[] = [];

  @property({ type: Object, attribute: false })
  selected: any;

  @property({ type: Number })
  cursorIndex = -1;

  @property({ type: String })
  endpoint: string;

  @property({ type: String })
  nextSelection: any;

  @property({ type: Number })
  tabIndex = 1;

  @property({ type: String })
  valueKey = 'id';

  @property({ type: String })
  value: string;

  @property({ type: Boolean })
  loading = false;

  @property({ type: Boolean })
  collapsed: boolean;

  @property({ type: Boolean })
  hideShadow: boolean;

  @property({ type: Boolean })
  paused = false;

  @property({ type: Boolean })
  internalFocusDisabled = false;

  // when set, shown in place of the list when it loads empty
  @property({ type: String })
  emptyMessage: string = null;

  // default empty message, resolved at render time so it reflects the
  // locale, which is only known once the store has loaded - subclasses
  // override this rather than assigning emptyMessage in their
  // constructors, which would freeze the source-locale string
  protected defaultEmptyMessage(): string {
    return null;
  }

  @property({ attribute: false })
  getNextRefresh: (firstOption: any) => any;

  @property({ attribute: false })
  sanitizeOption: (option: any) => any;

  @property({ attribute: false })
  renderOption: (option: any, selected: boolean) => TemplateResult;

  @property({ attribute: false })
  renderDivider: (prev: any, option: any) => TemplateResult | null;

  @property({ attribute: false })
  renderOptionDetail: (option: any, selected: boolean) => TemplateResult;

  @property({ attribute: false, type: Object })
  mostRecentItem: any;

  // changes to the refresh key force a refresh
  @property({ type: String })
  refreshKey = '0';

  reverseRefresh = true;

  // subclasses can enforce a display order when refreshed items are merged in,
  // otherwise new items simply land at the top of the list
  protected compareItems: (a: any, b: any) => number = null;

  // subclasses that get realtime updates can opt out of interval polling
  protected pollingEnabled = true;

  // our next page from our endpoint
  nextPage: string = null;

  pages = 0;
  clearRefreshTimeout: any;
  pending: AbortController[] = [];

  store: Store;

  // used for testing only
  preserve: boolean;

  static get styles() {
    return css`
      temba-options {
        display: block;
        width: 100%;
        flex-grow: 1;
      }
    `;
  }

  constructor() {
    super();
    this.store = document.querySelector('temba-store') as Store;
    this.handleSelection.bind(this);
  }

  private reset(): void {
    this.selected = null;
    this.nextPage = null;
    this.cursorIndex = -1;
    this.mostRecentItem = null;
    this.items = [];
  }

  refreshInterval = null;

  public connectedCallback() {
    super.connectedCallback();
    if (this.pollingEnabled) {
      this.refreshInterval = setInterval(() => {
        if (!this.paused) {
          this.refreshKey = 'default_' + new Date().getTime();
        }
      }, DEFAULT_REFRESH);
    }
  }

  public disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.refreshInterval);
  }

  public willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);

    if (changedProperties.has('cursorIndex')) {
      if (this.cursorIndex > -1) {
        this.selected = this.items[this.cursorIndex];
      }
    }

    if (changedProperties.has('endpoint') && this.endpoint) {
      this.loading = true;
      this.reset();
    }
  }

  public updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    if (changedProperties.has('endpoint') && this.endpoint) {
      this.fetchItems();
    }

    if (changedProperties.has('loading')) {
      if (!this.loading) {
        this.fireCustomEvent(CustomEventType.FetchComplete);
      }
    }

    if (
      changedProperties.has('refreshKey') &&
      !changedProperties.has('endpoint')
    ) {
      this.refreshTop();
    }

    if (changedProperties.has('mostRecentItem') && this.mostRecentItem) {
      this.fireCustomEvent(CustomEventType.Refreshed);
    }

    if (changedProperties.has('cursorIndex')) {
      if (this.cursorIndex > -1) {
        this.handleSelected(this.selected);
      }
    }

    if (changedProperties.has('items')) {
      //
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public handleSelected(selected: any) {
    const evt = new Event('change', { bubbles: true });
    this.dispatchEvent(evt);
  }

  private getValue(obj: any): any {
    if (!obj) {
      return null;
    }

    const path = this.valueKey.split('.');
    let current = obj;
    while (path.length > 0) {
      const key = path.shift();
      current = current[key];
    }
    return current;
  }

  public setSelection(value: string) {
    const index = this.items.findIndex((item) => {
      return this.getValue(item) === value;
    });
    this.cursorIndex = index;
    this.selected = this.items[index];
    const evt = new Event('change', { bubbles: true });
    this.dispatchEvent(evt);
  }

  public getItemIndex(value: string) {
    return this.items.findIndex((option) => this.getValue(option) === value);
  }

  public removeItem(value: string) {
    const index = this.getItemIndex(value);
    this.items.splice(index, 1);
    this.items = [...this.items];
    if (this.cursorIndex === index) {
      this.cursorIndex = -1;
    }

    // request a change even if it is the same, the item is different
    this.requestUpdate('cursorIndex');
    this.requestUpdate('items');
  }

  public getSelection(): any {
    return this.selected;
  }

  /** Deselects without firing a change — e.g. mobile going back to the
   *  list, so the same row can be selected again. */
  public clearSelection() {
    this.cursorIndex = -1;
    this.selected = null;
    this.value = null;
  }

  public refresh(): void {
    this.refreshKey = 'requested_' + new Date().getTime();
  }

  public setEndpoint(endpoint: string, nextSelection: any = null) {
    this.endpoint = endpoint;
    this.nextSelection = nextSelection;
  }

  public getRefreshEndpoint() {
    return this.endpoint;
  }

  protected sanitizeResults(results: any[]): Promise<any[]> {
    return Promise.resolve(results);
  }

  /**
   * Finds where the item our cursor was pinned to ended up after a merge
   * re-ordered our list. Returns null if the cursor is still on the right item,
   * otherwise the index it moved to (-1 if it is no longer in the list).
   */
  private findRepinnedCursorIndex(prevItem: any, newItems: any[]): number {
    if (!prevItem) {
      return null;
    }

    const prevValue = this.getValue(prevItem);
    if (prevValue === this.getValue(newItems[this.cursorIndex])) {
      return null;
    }

    return newItems.findIndex((option) => this.getValue(option) === prevValue);
  }

  /**
   * Whether any part of the focused option is inside the visible part of the
   * list
   */
  private isFocusedOptionVisible(): boolean {
    const options = this.shadowRoot.querySelector('temba-options');
    const option = options?.shadowRoot?.querySelector('.option.focused');
    const scrollBox = options?.shadowRoot?.querySelector('.options-scroll');
    if (!option || !scrollBox) {
      return false;
    }

    const optionBounds = option.getBoundingClientRect();
    const scrollBounds = scrollBox.getBoundingClientRect();
    return (
      optionBounds.bottom > scrollBounds.top &&
      optionBounds.top < scrollBounds.bottom
    );
  }

  /**
   * Refreshes the first page, updating any found items in our list
   */
  private async refreshTop(): Promise<void> {
    const refreshEndpoint = this.getRefreshEndpoint();
    if (!refreshEndpoint) {
      return;
    }

    // cancel any outstanding requests
    while (this.pending.length > 0) {
      const pending = this.pending.pop();
      pending.abort();
    }

    const controller = new AbortController();
    this.pending.push(controller);

    const prevItem = this.items[this.cursorIndex];

    try {
      const page = await fetchResultsPage(
        this.getRefreshEndpoint(),
        controller
      );

      const sanitizedResults = await this.sanitizeResults(page.results);
      const items = [...this.items];

      // remove any dupes already in our list
      if (sanitizedResults) {
        sanitizedResults.forEach((newOption: any) => {
          if (this.sanitizeOption) {
            this.sanitizeOption(newOption);
          }
          const newValue = this.getValue(newOption);
          const removeIndex = items.findIndex(
            (option) => this.getValue(option) === newValue
          );

          if (removeIndex > -1) {
            items.splice(removeIndex, 1);
          }
        });

        // insert our new items at the front
        let results = sanitizedResults;
        if (this.reverseRefresh) {
          results = sanitizedResults.reverse();
        }
        const newItems = [...results, ...items];

        // capture the top item before any display sort - it means "the newest
        // item we just fetched, or the previous top if we fetched nothing" and
        // drives the Refreshed event
        const topItem = newItems[0];

        if (this.compareItems) {
          newItems.sort(this.compareItems);
        }

        if (
          !this.mostRecentItem ||
          JSON.stringify(this.mostRecentItem) !== JSON.stringify(topItem)
        ) {
          this.mostRecentItem = topItem;
        }

        const newIndex = this.findRepinnedCursorIndex(prevItem, newItems);
        if (newIndex !== null && newIndex > -1) {
          // follow our focused item to its new position, but only if it was
          // in view - otherwise we'd drag a list that has been scrolled away
          // from it back on every refresh
          const follow = this.isFocusedOptionVisible();
          this.cursorIndex = newIndex;

          if (follow) {
            window.setTimeout(() => {
              const options = this.shadowRoot.querySelector('temba-options');
              if (options) {
                const option =
                  options.shadowRoot.querySelector('.option.focused');
                if (option) {
                  option.scrollIntoView({
                    block: 'nearest',
                    inline: 'nearest'
                  });
                }
              }
            }, 0);
          }
        }

        this.items = newItems;
      }
    } catch (error) {
      this.paused = true;
    }
  }

  private async fetchItems(): Promise<void> {
    // cancel any outstanding requests
    while (this.pending.length > 0) {
      const pending = this.pending.pop();
      pending.abort();
    }

    let endpoint = this.endpoint;
    let pagesToFetch = this.pages || 1;
    let pages = 0;
    let nextPage = null;

    let fetchedItems: any[] = [];

    while (pagesToFetch > 0 && endpoint) {
      const controller = new AbortController();
      this.pending.push(controller);

      try {
        const page = await fetchResultsPage(endpoint, controller);
        const sanitizedResults = await this.sanitizeResults(page.results);

        // sanitize our options if necessary
        if (this.sanitizeOption) {
          sanitizedResults.forEach(this.sanitizeOption);
        }

        if (sanitizedResults) {
          fetchedItems = fetchedItems.concat(sanitizedResults);
        }

        // save our next pages
        nextPage = page.next;
        endpoint = nextPage;
        pagesToFetch--;
        pages++;
      } catch (error) {
        // aborted
        this.reset();
        this.paused = true;
        this.loading = false;
        return;
      }
      this.nextPage = nextPage;
    }
    this.pages = pages;

    const topItem = fetchedItems[0];
    if (
      !this.mostRecentItem ||
      JSON.stringify(this.mostRecentItem) !== JSON.stringify(topItem)
    ) {
      this.mostRecentItem = topItem;
    }

    // see if our cursor needs to move to stay on the same item
    const newItem = fetchedItems[this.cursorIndex];

    if (
      !this.nextSelection &&
      this.selected &&
      newItem &&
      this.getValue(newItem) !== this.getValue(this.selected)
    ) {
      const index = fetchedItems.findIndex((item) => {
        return this.getValue(item) === this.getValue(this.selected);
      });

      // old selection is in the new fetch
      if (index > -1) {
        this.cursorIndex = index;
      }
      // old selection is missing from the new fetch
      else {
        // if our index didn't change, our item still did, fire change
        if (this.cursorIndex === 0) {
          this.requestUpdate('cursorIndex');
        }
        // otherwise select the first item
        else {
          this.cursorIndex = 0;
        }
      }
    }

    // save our results
    this.items = fetchedItems;
    this.loading = false;
    this.pending = [];

    if (this.nextSelection) {
      this.setSelection(this.nextSelection);
      this.nextSelection = false;
    } else {
      if (this.cursorIndex === -1 && !this.isMobile()) {
        this.cursorIndex = 0;
      }
    }

    if (this.value) {
      this.setSelection(this.value);
      this.value = null;
    } else if (this.isMobile() && !this.selected) {
      this.cursorIndex = -1;
      this.value = null;
      this.selected = null;
      const evt = new Event('change', { bubbles: true });
      this.dispatchEvent(evt);
    }

    return Promise.resolve();
  }

  private handleScrollThreshold() {
    if (this.nextPage && !this.loading) {
      this.loading = true;
      fetchResultsPage(this.nextPage)
        .then((page: ResultsPage) => {
          return this.sanitizeResults(page.results).then(
            (sanitizedResults: any[]) => {
              if (this.sanitizeOption) {
                sanitizedResults.forEach(this.sanitizeOption);
              }

              // the item our cursor is pinned to, sorting can move it
              const prevItem = this.items[this.cursorIndex];

              // drop anything we already have, a poll can pull an item from the
              // next page up into our loaded window before we fetch it
              const seen = new Set(
                this.items.map((option) => this.getValue(option))
              );
              const appended = (sanitizedResults || []).filter(
                (option: any) => {
                  const value = this.getValue(option);
                  if (seen.has(value)) {
                    return false;
                  }
                  seen.add(value);
                  return true;
                }
              );

              const items = [...this.items, ...appended];

              // the server pages in the same total order we display in, so this is
              // normally a no-op, but a poll can re-sort an item (say a ticket that
              // just closed) into the loaded window - without this the appended
              // page would land below it
              if (this.compareItems) {
                items.sort(this.compareItems);
              }

              // the sort can shift our selection, keep the cursor on it
              const newIndex = this.findRepinnedCursorIndex(prevItem, items);
              if (newIndex !== null && newIndex > -1) {
                this.cursorIndex = newIndex;
              }

              this.items = items;
              this.nextPage = page.next;
              this.pages++;
              this.loading = false;
            }
          );
        })
        .catch(() => {
          // let the next scroll try again instead of wedging on loading
          this.loading = false;
        });
    }
  }

  public renderHeader(): TemplateResult {
    return null;
  }

  public renderFooter(): TemplateResult {
    return null;
  }

  public getListStyle() {
    return '';
  }

  protected handleSelection(event: CustomEvent) {
    let index = event.detail.index;
    const selected = event.detail.selected;

    if (index === -1) {
      index = 0;
    }

    this.selected = selected;
    this.cursorIndex = index;

    event.stopPropagation();
    event.preventDefault();
  }

  public render(): TemplateResult {
    const emptyMessage = this.emptyMessage ?? this.defaultEmptyMessage();
    return html`
      ${this.renderHeader()}
      <temba-options
        style="${this.getListStyle()}"
        visible
        block
        cursorSelection
        ?hideShadow=${this.hideShadow}
        ?collapsed=${this.collapsed}
        ?loading=${this.loading}
        ?internalFocusDisabled=${this.internalFocusDisabled}
        ?showEmptyMessage=${!!emptyMessage && !this.loading}
        .emptyMessage=${emptyMessage}
        .renderOption=${this.renderOption}
        .renderDivider=${this.renderDivider}
        .renderOptionDetail=${this.renderOptionDetail}
        @temba-scroll-threshold=${this.handleScrollThreshold}
        @temba-selection=${this.handleSelection.bind(this)}
        .options=${this.items}
        .cursorIndex=${this.cursorIndex}
      >
        <slot></slot>
      </temba-options>
      ${this.renderFooter()}
    `;
  }
}
