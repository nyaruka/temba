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

  // items that changed while selected (say a reply bumped a ticket's
  // activity) stay in the row they were in until the list reloads, rather
  // than re-sorting - either while being worked on or once the user clicks
  // on to the next one, which would move rows under their pointer
  private held = new Set<any>();

  // set when we move the cursor only to keep it on the same item, so that
  // doesn't read as a new selection
  private silentCursor = false;

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
    this.pages = 0;
    this.held = new Set();
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
      if (this.silentCursor) {
        this.silentCursor = false;
      } else if (this.cursorIndex > -1) {
        this.handleSelected(this.selected);
      }
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
    if (index < 0) {
      return;
    }

    const items = [...this.items];
    items.splice(index, 1);
    this.items = items;
    this.held.delete(value);

    if (this.cursorIndex === index) {
      this.cursorIndex = -1;

      // request a change even if it is the same, the item is different
      this.requestUpdate('cursorIndex');
    } else if (index < this.cursorIndex) {
      // the rows below shifted up, keep the cursor on the same item
      this.silentCursor = true;
      this.cursorIndex = this.cursorIndex - 1;
    }
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

  /**
   * Reads the list again from its endpoint, as many pages as are loaded,
   * keeping the selection where it can
   */
  public reload(): Promise<void> {
    return this.fetchItems();
  }

  public setEndpoint(endpoint: string, nextSelection: any = null) {
    this.endpoint = endpoint;
    this.nextSelection = nextSelection;
  }

  public getRefreshEndpoint() {
    return this.endpoint;
  }

  /**
   * The items a refresh is a complete answer for: any of them it doesn't
   * return no longer belong in the list. Null for a refresh that only brings
   * in what's new.
   */
  protected getRefreshScope(): Set<any> {
    return null;
  }

  /**
   * Called once a refresh is over, with the scope it was for and whether it
   * was merged in - one that failed or was cancelled by a newer request wasn't
   */
  protected handleRefreshEnded(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    scope: Set<any>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    outcome: 'merged' | 'failed' | 'aborted'
  ): void {
    // nothing by default
  }

  protected sanitizeResults(results: any[]): Promise<any[]> {
    return Promise.resolve(results);
  }

  /**
   * Whether a refreshed item belongs in the list - subclasses can leave out
   * ones that no longer fit it, say ones that now sort past what's loaded
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected keepItem(item: any): boolean {
    return true;
  }

  /**
   * Called with the first page each time the list loads from its endpoint
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected handleFirstPage(page: ResultsPage): void {
    // nothing by default
  }

  /**
   * Called with each response that reads the list as it is now - the first
   * page each time the list loads, and every refresh
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected handleCurrentPage(page: ResultsPage): void {
    // nothing by default
  }

  /**
   * Swaps in the latest data for an item and holds it in its current row
   * until the list reloads, for changes made here that would otherwise
   * re-sort it or drop it from the list on the next refresh.
   */
  public holdItem(item: any): void {
    const value = this.getValue(item);
    const index = this.getItemIndex(value);
    if (index < 0) {
      return;
    }

    this.held.add(value);
    const items = [...this.items];
    items[index] = item;
    this.items = items;
    if (index === this.cursorIndex) {
      this.selected = item;
    }
  }

  /**
   * Sorts merged items into display order. Held items are the exception:
   * each stays just below the row it followed before, so they don't move
   * while the user works through the list. The selected item becomes held
   * when it's one of the refreshed items, i.e. it changed itself.
   */
  private arrange(items: any[], selected: any, refreshed: Set<any>): any[] {
    if (!this.compareItems) {
      return items;
    }

    if (selected && refreshed.has(this.getValue(selected))) {
      this.held.add(this.getValue(selected));
    }

    // where each held item was, as the item it followed (null for the top),
    // skipping items that just changed since they may sort elsewhere now
    const anchors = new Map<any, any>();
    let previous: any = null;
    this.items.forEach((item) => {
      const value = this.getValue(item);
      if (this.held.has(value)) {
        anchors.set(value, previous);
      } else if (!refreshed.has(value)) {
        previous = value;
      }
    });

    const held = new Map<any, any[]>();
    const others: any[] = [];
    items.forEach((item) => {
      const value = this.getValue(item);
      if (anchors.has(value)) {
        const anchor = anchors.get(value);
        held.set(anchor, [...(held.get(anchor) || []), item]);
      } else {
        others.push(item);
      }
    });
    others.sort(this.compareItems);

    if (held.size === 0) {
      return others;
    }

    // an anchor that's gone from the list leaves its held items at the top
    const present = new Set(others.map((item) => this.getValue(item)));
    const result: any[] = [];
    held.forEach((group, anchor) => {
      if (anchor === null || !present.has(anchor)) {
        result.push(...group);
      }
    });
    others.forEach((item) => {
      result.push(item);
      const group = held.get(this.getValue(item));
      if (group) {
        result.push(...group);
      }
    });
    return result;
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

  private getScrollBox(): HTMLElement {
    const options = this.shadowRoot.querySelector('temba-options');
    return options?.shadowRoot?.querySelector('.options-scroll');
  }

  private getFocusedOption(): HTMLElement {
    return this.getScrollBox()?.querySelector('.option.focused');
  }

  /**
   * Whether any part of the focused option is inside the visible part of the
   * list
   */
  private isFocusedOptionVisible(): boolean {
    const option = this.getFocusedOption();
    if (!option) {
      return false;
    }

    const optionBounds = option.getBoundingClientRect();
    const scrollBounds = this.getScrollBox().getBoundingClientRect();
    return (
      optionBounds.bottom > scrollBounds.top &&
      optionBounds.top < scrollBounds.bottom
    );
  }

  /**
   * The item at the top of the visible part of a scrolled list and how far
   * its row is from the top, or null for a list that is scrolled to its top
   */
  private getScrollAnchor(): { value: any; offset: number } {
    const scrollBox = this.getScrollBox();
    if (!scrollBox || scrollBox.scrollTop === 0) {
      return null;
    }

    const top = scrollBox.getBoundingClientRect().top;
    const rows = scrollBox.querySelectorAll('.option[data-option-index]');
    for (const row of rows) {
      const bounds = row.getBoundingClientRect();
      if (bounds.bottom > top) {
        const item =
          this.items[parseInt(row.getAttribute('data-option-index'))];
        return item
          ? { value: this.getValue(item), offset: bounds.top - top }
          : null;
      }
    }
    return null;
  }

  /**
   * Scrolls so that the anchor's item is back where it was, undoing the
   * shift from any rows that were added or removed above it
   */
  private restoreScrollAnchor(anchor: { value: any; offset: number }) {
    const scrollBox = this.getScrollBox();
    if (!anchor || !scrollBox) {
      return;
    }

    const index = this.items.findIndex(
      (item) => this.getValue(item) === anchor.value
    );
    const row = scrollBox.querySelector(`[data-option-index="${index}"]`);
    if (row) {
      scrollBox.scrollTop +=
        row.getBoundingClientRect().top -
        scrollBox.getBoundingClientRect().top -
        anchor.offset;
    }
  }

  /**
   * Refreshes the first page, updating any found items in our list
   */
  private async refreshTop(): Promise<void> {
    const refreshEndpoint = this.getRefreshEndpoint();
    if (!refreshEndpoint) {
      return;
    }
    const scope = this.getRefreshScope();

    // cancel any outstanding requests
    while (this.pending.length > 0) {
      const pending = this.pending.pop();
      pending.abort();
    }

    const controller = new AbortController();
    this.pending.push(controller);

    // what to do about our scroll position once the refreshed list has
    // rendered
    let anchor: { value: any; offset: number } = null;
    let follow = false;

    try {
      const page = await fetchResultsPage(refreshEndpoint, controller);

      this.handleCurrentPage(page);
      const sanitizedResults = await this.sanitizeResults(page.results);

      // read our list and selection only now - either can change while we
      // wait on the fetch, say if a different item gets selected
      const prevItem = this.items[this.cursorIndex];
      const prevValue = prevItem ? this.getValue(prevItem) : null;
      let items = [...this.items];

      // remove any dupes already in our list
      if (sanitizedResults) {
        const refreshed = new Set<any>();
        sanitizedResults.forEach((newOption: any) => {
          if (this.sanitizeOption) {
            this.sanitizeOption(newOption);
          }
          const newValue = this.getValue(newOption);
          refreshed.add(newValue);
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

        // capture the top item before any filtering or display sort - it means
        // "the newest item we just fetched, or the previous top if we fetched
        // nothing" and drives the Refreshed event
        const topItem = results.length > 0 ? results[0] : items[0];

        // anything the refresh was for but didn't return has left the list -
        // except the selected item and held items, which always stay, even if
        // they no longer belong, until the list reloads
        if (scope) {
          items = items.filter((option: any) => {
            const value = this.getValue(option);
            return (
              !scope.has(value) || value === prevValue || this.held.has(value)
            );
          });
        }

        const kept = results.filter((option: any) => {
          const value = this.getValue(option);
          return (
            (prevValue !== null && value === prevValue) ||
            this.held.has(value) ||
            this.keepItem(option)
          );
        });

        const newItems = this.arrange([...kept, ...items], prevItem, refreshed);

        if (
          !this.mostRecentItem ||
          JSON.stringify(this.mostRecentItem) !== JSON.stringify(topItem)
        ) {
          this.mostRecentItem = topItem;
        } else if (scope) {
          // a scoped refresh can drop rows without changing the top one, and
          // that's a change too
          this.fireCustomEvent(CustomEventType.Refreshed);
        }

        // a list that has been scrolled stays on the items it is showing
        anchor = this.getScrollAnchor();

        const newIndex = this.findRepinnedCursorIndex(prevItem, newItems);
        if (newIndex !== null && newIndex > -1) {
          // follow our focused item to its new position, but only if it was
          // in view - otherwise we'd drag a list that has been scrolled away
          // from it back on every refresh
          follow = this.isFocusedOptionVisible();
          this.cursorIndex = newIndex;
        } else if (newIndex === null && prevItem) {
          // still on the same row, but pick up the item's latest data
          this.selected = newItems[this.cursorIndex];
        }

        this.items = newItems;
      }

      this.handleRefreshEnded(scope, 'merged');
    } catch (error) {
      // a newer request cancelled this one, that's not a failure
      if (controller.signal.aborted) {
        this.handleRefreshEnded(scope, 'aborted');
      } else {
        this.paused = true;
        this.handleRefreshEnded(scope, 'failed');
      }
      return;
    }

    if (anchor || follow) {
      // wait for the new rows, then settle our scroll before they are painted
      await this.updateComplete;
      const options = this.shadowRoot.querySelector('temba-options') as any;
      await options?.updateComplete;

      this.restoreScrollAnchor(anchor);
      if (follow) {
        this.getFocusedOption()?.scrollIntoView({
          block: 'nearest',
          inline: 'nearest'
        });
      }
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
        if (pages === 0) {
          this.handleFirstPage(page);
          this.handleCurrentPage(page);
        }
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
        // a newer fetch cancelled this one and owns the list now
        if (controller.signal.aborted) {
          return;
        }

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

              // the server pages in the same total order we display in, so this is
              // normally a no-op, but a poll can re-sort an item (say a ticket that
              // just closed) into the loaded window - without this the appended
              // page would land below it. Held items keep their rows.
              const items = this.arrange(
                [...this.items, ...appended],
                prevItem,
                new Set()
              );

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
