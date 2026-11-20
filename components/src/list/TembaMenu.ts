import { css, html, TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { property } from 'lit/decorators.js';
import { CustomEventType } from '../interfaces';
import {
  debounce,
  fetchResults,
  formatCount,
  getClasses,
  renderAvatar
} from '../utils';
import { Icon } from '../Icons';
import { Dropdown } from '../display/Dropdown';
import { NotificationList } from './NotificationList';
import { ResizeElement } from '../ResizeElement';
import { Store } from '../store/Store';
import { designTokens } from '../styles/designTokens';

export interface MenuItem {
  id?: string;
  vanity_id?: string;
  name?: string;
  verbose_name?: string;
  count?: number;
  icon?: string;
  collapsed_icon?: string;
  endpoint?: string;
  loading?: boolean;
  bottom?: boolean;
  level?: number;
  href?: string;
  show_header?: boolean;
  items?: MenuItem[];
  inline?: boolean;
  type?: string;
  target?: string;
  on_submit?: string;
  bubble?: string;
  popup?: boolean;
  avatar?: string;
  trigger?: boolean;
  event?: string;
  initial?: string;
}

interface MenuItemState {
  collapsed?: string;
}

// fields the menu maintains on an item rather than reading off the server, so
// a reload carries them across instead of treating them as dropped
const OWN_ITEM_FIELDS = ['items', 'level', 'loading'];

const findItem = (
  items: MenuItem[],
  id: string
): { item: MenuItem; index: number } => {
  const search = items || [];

  const index = search.findIndex((item: MenuItem) => {
    return item.id == id || item.vanity_id == id;
  });

  if (index > -1) {
    const item = search[index];
    return { item, index };
  }

  return { item: null, index: -1 };
};

export class TembaMenu extends ResizeElement {
  static get styles() {
    return css`
      ${designTokens}

      :host {
        width: 100%;
        display: block;
        font-family: var(--font);
        color: var(--text-1);
        --color-widget-bg-focused: transparent;
        --options-block-shadow: none;
        --menu-rail: var(--accent-400);
        --menu-rail-selected: rgba(0, 0, 0, 0.15);
      }

      .bubble {
        width: 0.6em;
        height: 0.6em;
        right: 0em;
        bottom: 0em;
        border-radius: 99em;
        border: 0.12em solid rgba(0, 0, 0, 0.1);
        position: absolute;
      }

      .bubble.count {
        position: relative;
        width: inherit;
        height: inherit;
        right: inherit;
        bottom: inherit;
        color: #fff;
        line-height: 1em;
        padding: 0.12em;
        min-width: 1em;
        text-align: center;
      }

      .section {
        font-size: 15px;
        font-weight: var(--w-medium);
        color: var(--text-1);
      }

      .collapse-toggle {
        width: 0.5em;
        cursor: pointer;
        display: block;
        margin-right: 5px;
        margin-top: 3px;
        margin-bottom: 3px;
      }

      .collapse-toggle:hover {
        background: rgba(0, 0, 0, 0.04);
      }

      .item {
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--text-2);
        font-weight: var(--w-regular);
        --icon-color: var(--text-2);
        transition:
          background-color 120ms ease,
          color 120ms ease;
      }

      .item:hover {
        background: var(--sunken);
        color: var(--text-1);
        --icon-color: var(--text-1);
      }

      .item.selected,
      .item.pressed,
      .item.selected:hover,
      .item.pressed:hover {
        background: var(--focus-50);
        color: var(--focus-700);
        --icon-color: var(--focus-600);
      }

      .root {
        display: flex;
        flex-direction: row;
        height: 100%;
      }

      .level {
        display: flex;
        flex-direction: column;
      }

      .level.hidden {
        display: none;
      }

      .level-0 > .item,
      .level-0 > temba-dropdown > div[slot='toggle'] > .avatar,
      .level-0 > temba-dropdown > div[slot='toggle'] > .item {
        padding: 0px;
        color: rgba(255, 255, 255, 0.92);
        --icon-color: rgba(255, 255, 255, 0.92);
        flex-direction: column;
        justify-content: center;
        border: 0px solid transparent;
        width: 36px;
        height: 36px;
        margin: 4px 8px;
        box-sizing: border-box;
        border-radius: var(--r);
        display: flex;
        align-items: center;
        position: relative;
      }

      .level-0 .item > temba-tip {
        padding: 0;
      }

      .level-0 > .item.selected::after,
      .level-0 > temba-dropdown > div[slot='toggle'] > .item.selected::after {
        content: '';
        position: absolute;
        left: -8px;
        top: 50%;
        width: 3px;
        height: 22px;
        background: #fff;
        border-radius: 0 2px 2px 0;
        transform: translateY(-50%);
      }

      .level-0 {
        padding-top: var(--menu-padding) !important;
      }

      .level-0 > .empty {
        background: var(--menu-rail);
        align-self: stretch;
        flex-grow: 1;
      }

      .level-0 > .bottom {
        height: 1em;
        background: var(--menu-rail);
      }

      .level-0 > temba-dropdown.open > div[slot='toggle'] > .avatar {
        background: transparent !important;
      }

      .level-0 {
        background: var(--menu-rail);
      }

      temba-dropdown {
        margin: 0 0.25em;
      }

      .level-0 > temba-dropdown {
        margin: 0;
        display: block;
        width: 100%;
      }

      temba-dropdown > div[slot='dropdown'] {
        width: 300px;
        overflow: hidden;
      }

      /* popups holding natural links hug their content instead */
      temba-dropdown > div[slot='dropdown']:has(> .popup-link) {
        width: auto;
        min-width: 11em;
      }

      .popup-link {
        display: flex;
        align-items: center;
        margin: 0.5em 1em;
        color: var(--color-link-primary);
        --icon-color: var(--text-2);
        cursor: pointer;
        text-decoration: none;
      }

      .popup-link temba-icon {
        margin-right: 0.5em;
      }

      .popup-link:hover {
        text-decoration: underline;
      }

      .popup-link:first-child {
        margin-top: 1em;
      }

      .popup-link:last-child {
        margin-bottom: 1em;
      }

      temba-dropdown > div[slot='dropdown'] .avatar > .details {
        margin-left: 0.75em;
      }

      temba-dropdown > div[slot='dropdown'] .bubble.count {
        margin-right: 0.75em;
      }

      .level-0 > .item > .details,
      .level-0 > temba-dropdown > div[slot='toggle'] .details {
        display: none !important;
      }

      .avatar {
        align-items: center;
      }

      temba-dropdown > div[slot='dropdown'] {
      }

      temba-dropdown > div[slot='dropdown'] .avatar .avatar-circle,
      temba-dropdown > div[slot='dropdown'] .avatar .bubble {
        font-size: 0.7em;
      }

      .level-0.expanded {
        background: inherit;
      }

      .level-0 > .item.selected,
      .level-0 > temba-dropdown > div[slot='toggle'] > .item.selected {
        background: var(--menu-rail-selected);
        color: #fff;
        --icon-color: #fff;
      }

      .level {
        padding: 8px;
        gap: 1px;
      }

      .level-0 {
        padding: 0px;
        gap: 0;
      }

      .top {
        display: flex;
        align-items: center;
        flex-direction: column;
      }

      .item {
        padding: 0 8px;
        height: 28px;
        flex-shrink: 0;
        border-radius: var(--r-sm);
        display: flex;
        min-width: 12em;
        position: relative;
        font-size: 13.5px;
      }

      .item > .details > .name {
        flex-grow: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        width: 0;
      }

      .level-0 > .item,
      .level-0 > temba-dropdown > div[slot='toggle'] > .item {
        margin-top: 0em;
        min-width: inherit;
        max-width: inherit;
        color: rgba(255, 255, 255, 0.92);
      }

      .level-0 > temba-dropdown > div[slot='toggle'] > .item.popup:hover {
        --icon-color: #fff;
      }

      .level-0 > .item > .name {
        min-width: 0px;
      }

      .count {
        align-self: center;
        margin-left: 10px;
        font-size: 11.5px;
        font-weight: var(--w-regular);
        color: var(--text-3);
        background: var(--sunken);
        padding: 1px 6px;
        border-radius: 999px;
        font-variant-numeric: tabular-nums;
      }

      .count:empty {
        display: none;
      }

      .item.selected .count,
      .item.pressed .count {
        background: var(--focus-200);
        color: var(--focus-700);
      }

      .level-0 > .item-top,
      .level-0 > .item-bottom {
        background: var(--menu-rail);
        min-height: var(--r);
      }

      .level-0 > .item:hover,
      .level-0 > temba-dropdown > div[slot='toggle'] > .item:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        --icon-color: #fff;
      }

      .level-0 > .item.selected:hover,
      .level-0 > temba-dropdown > div[slot='toggle'] > .item.selected:hover {
        background: var(--menu-rail-selected);
        color: #fff;
        --icon-color: #fff;
        cursor: default;
      }

      .item.inline {
        border: 0px solid transparent;
      }

      .level-1,
      .level-2 {
        border-right: 1px solid var(--border);
        box-shadow: var(--shadow-2);
      }

      .level-1 {
        transition:
          opacity 100ms linear,
          width 200ms linear,
          min-width 200ms linear,
          max-width 200ms linear;
        overflow-y: scroll;
      }

      .mobile.root {
        height: 100svh;
      }

      .mobile.root.fully-collapsed {
        height: initial;
      }

      .root.fully-collapsed.mobile .level.level-0 {
        padding-right: 0.5em;
      }

      .root.fully-collapsed.mobile .level.level-0 {
        flex-direction: row;
      }

      /* when collapsed on mobile, the only thing in the header is the
         hamburger — any new direct child of level-0 must opt in with
         the .top class to stay visible here */
      .root.fully-collapsed.mobile .level.level-0 > *:not(.top) {
        display: none;
      }

      .root.fully-collapsed.mobile .level.level-0 .expand-icon {
        max-height: 100%;
        padding: 1em;
      }

      .mobile.fully-collapsed.root {
        flex-direction: column;
      }

      .mobile.fully-collapsed.root .level-0 {
        padding-top: 0px !important;
      }

      .mobile.fully-collapsed .level-1 {
        display: none;
      }

      .mobile .level-1 {
        flex-grow: 1;
      }

      .mobile .level-1 .item {
        max-width: inherit;
        min-width: inherit;
      }

      .mobile .level-1 .section {
        max-width: inherit;
        min-width: inherit;
      }

      .mobile .expand-icon {
        transition: none;
        transform: rotate(-90deg);
        align-self: center;
      }

      .mobile.fully-collapsed .expand-icon {
        transform: none;
      }

      .level-1 {
        background: var(--surface);
      }

      .level-2 {
        background: var(--bg);
        overflow-y: auto;
      }

      .level-2 .item .details {
        overflow: hidden;
      }

      .level-2 .item {
        min-width: 16em;
        max-width: 16em;
      }

      .level-1 .item {
        overflow: hidden;
        max-width: 16em;
        min-width: 16em;
        transition: min-width var(--transition-speed) !important;
      }

      .collapsed .item {
        overflow: hidden;
        min-width: 0;
        margin: 0;
      }

      .item .details {
        opacity: 1;
        min-height: 1.5em;
        max-height: 1.5em;
        align-items: center;
      }

      .collapsed .item {
        margin-bottom: 0.5em;
      }

      .collapsed .item .details {
        overflow: hidden;
        max-height: 0em;
        max-width: 0em;
      }

      .collapsed .item .details {
        max-height: 0em;
      }

      .collapsed .item temba-icon {
        margin-right: 0;
      }

      .section {
        max-width: 16em;
      }

      .collapsed .section {
        opacity: 0;
        max-width: 0em;
        max-height: 0.6em;
      }

      .collapsed.level-1 {
        overflow: hidden;
        padding: 0.5em;
        --icon-color: var(--text-3);
      }

      .item .right {
        display: none;
      }

      .collapsed .item .right {
        display: block;
        flex-grow: 1;
      }

      .collapse-icon {
        display: none;
      }

      .collapsed .collapse-icon {
        --icon-color: var(--text-4);
        display: block;
      }

      .collapsed .item.iconless {
        max-height: 0em;
        padding: 0em;
        min-height: 0em;
        margin-bottom: 0em;
      }

      .divider {
        height: 1px;
        background: var(--border);
        margin: 0.5em var(--pad);
        min-height: 1px;
        flex-shrink: 0;
      }

      .space {
        margin: 0.5em;
      }

      .collapsed .divider {
        height: 0;
        margin: 0;
        padding: 0;
        min-height: 0px;
      }

      .sub-section {
        font-size: 11px;
        font-weight: var(--w-semibold);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-3);
        padding: 14px 10px 4px;
        flex-shrink: 0;
      }

      .fully-collapsed .level-1 {
        width: 0;
        min-width: 0;
        max-width: 0;
        padding: 0;
        pointer-events: none;
        border: none;
        box-shadow: none;
        overflow: hidden;
      }

      .fully-collapsed .level-2,
      .fully-collapsed .level-3 {
        display: none;
      }

      temba-button {
        margin-top: 0.2em;
        margin-bottom: 0.2em;
        margin-left: 0.75em;
        margin-right: 0.75em;
        --button-justify: flex-start;
      }

      .expand-icon {
        transform: rotate(180deg);
        --icon-color: rgba(255, 255, 255, 0.6);
        cursor: pointer;
        max-height: 0px;
        overflow: hidden;
        opacity: 0;
        transition: all 400ms ease-in-out 400ms;
      }

      .expand-icon:hover {
        --icon-color: #fff;
      }

      .fully-collapsed .expand-icon {
        padding-top: 0.5em;
        max-height: 2em;
        opacity: 1;
      }

      .section-header {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        margin: -8px -8px 8px;
        padding: 8px 8px 8px 16px;
        border-bottom: 1px solid var(--border);
      }

      .section-header .section {
        flex-grow: 1;
      }

      .section-header temba-icon {
        --icon-color: var(--border-strong);
        cursor: pointer;
        padding: 4px;
        transition: --icon-color 120ms ease;
      }

      .section-header temba-icon:hover {
        --icon-color: var(--accent);
      }

      a {
        text-decoration: none;
        color: inherit;
      }

      slot[name='header'] {
        display: none;
      }

      slot[name='header'].show-header {
        display: block;
      }

      .icon-wrapper {
        position: relative;
      }

      .level-0 .icon-wrapper {
        padding: 0.4em 0.2em;
      }

      .level-0 temba-dropdown div[slot='dropdown'] .icon-wrapper {
        padding: 0em !important;
        align-self: center;
        margin-right: 0.4em;
        margin-left: 0.4em;
      }

      temba-workspace-select {
        margin: 0.2em;
        display: block;
        --options-shadow: none;
        --color-widget-border: transparent;
        --widget-box-shadow: none;
      }
    `;
  }

  @property({ type: Boolean })
  wait: boolean;

  @property({ type: String })
  endpoint: string;

  @property({ type: String })
  value: string;

  // submenu to constrain to
  @property({ type: String })
  submenu: string;

  @property({ type: Boolean })
  collapsed: boolean;

  @property({ type: Object })
  pressedItem: MenuItem;

  /**
   * Resolves when every load in flight has settled. Awaiting it has to mean
   * "the menu has finished fetching", not "the last load anyone started has
   * finished" - loads overlap (a click while a debounced refresh is armed),
   * and a caller that awaited whichever promise happened to be here last
   * would read the menu mid-update.
   */
  public httpComplete: Promise<void> = Promise.resolve();

  private loadsInFlight = 0;
  private loadsSettled: () => void;

  root: MenuItem;
  selection: string[] = [];
  state: { [id: string]: MenuItemState } = {};

  constructor() {
    super();
    this.doRefresh = this.doRefresh.bind(this);

    // scroll any lists to the top
    this.addEventListener('blur', () => {
      this.shadowRoot
        .querySelectorAll('temba-notification-list')
        .forEach((ele: NotificationList) => {
          ele.scrollToTop();
        });
    });
  }

  public setBubble(id: string, color: string) {
    const found = findItem(this.root.items, id);
    if (found && found.item) {
      found.item.bubble = color;
      this.requestUpdate('root');
      return true;
    }
    return false;
  }

  private getMenuItemState(id: string): MenuItemState {
    let itemState = {};
    if (id) {
      itemState = this.state[id];
      if (!itemState) {
        itemState = {};
        this.state[id] = itemState;
      }
    }
    return itemState;
  }

  public updated(changes: Map<string, any>) {
    if (changes.has('endpoint')) {
      this.root = {
        level: -1,
        endpoint: this.endpoint
      };

      if (!this.wait) {
        this.loadItems(this.root);
      } else {
        this.fireCustomEvent(CustomEventType.Ready);
      }
    }

    if (changes.has('root')) {
      if (this.value) {
        this.setFocusedItem(this.value);
        this.value = null;
      }
    }
  }

  public reset() {
    this.loadItems(this.root);
  }

  public async doRefresh() {
    const path = [...this.selection];
    let item = this.root;

    while (path.length > 0) {
      this.loadItems(item);
      // we need to wait until the load is complete before doing the replace
      await this.httpComplete;
      const id = path.shift();
      item = (item.items || []).find((_item) => _item.id == id);
    }

    this.loadItems(item);
  }

  public refresh = debounce(this.doRefresh, 200);

  /**
   * Opening a popup with notifications in it marks them all seen - the badge
   * clears now, the items unbold next open. No fetching; the socket keeps
   * the list itself current.
   */
  private handlePopupOpened(event: CustomEvent, menuItem: MenuItem) {
    const dropdown = event.currentTarget as HTMLElement;
    const lists = dropdown.querySelectorAll('temba-notification-list');
    if (lists.length === 0) {
      return;
    }

    // clear the badge optimistically, restoring it if marking seen fails so
    // the unseen indicator isn't silently lost
    const bubble = menuItem.bubble;
    if (bubble) {
      menuItem.bubble = null;
      this.requestUpdate('root');
    }

    lists.forEach((list: NotificationList) => {
      list.markSeen().then((marked) => {
        if (!marked && bubble && !menuItem.bubble) {
          menuItem.bubble = bubble;
          this.requestUpdate('root');
        }
      });
    });
  }

  /**
   * Folds a load into httpComplete, which stays unresolved until the last one
   * outstanding settles.
   */
  private trackLoad(load: Promise<void>): void {
    if (this.loadsInFlight === 0) {
      this.httpComplete = new Promise((resolve) => {
        this.loadsSettled = resolve;
      });
    }
    this.loadsInFlight++;

    load.then(() => {
      if (--this.loadsInFlight === 0) {
        this.loadsSettled();
      }
    });
  }

  /**
   * Reloading a level reuses the item objects it already had. Replacing them
   * would orphan anything already pointing at one - a rendered click handler,
   * or a load in flight for that item's own children, which would then land
   * on a copy no longer in the tree.
   */
  private mergeItems(item: MenuItem, items: MenuItem[]): MenuItem[] {
    const previous = item.items || [];
    return items.map((newItem) => {
      const prevItem = previous.find((prev) => prev.id == newItem.id);
      if (!prevItem) {
        return newItem;
      }

      // sub-items the reload didn't speak to are ours to carry over - either
      // ones we already had or ones still on their way
      const carried = newItem.items || prevItem.items;

      // anything the reload dropped is gone, so this reads as a replacement
      // everywhere except identity - bar the fields the menu sets on an item
      // itself, which the server never speaks to
      Object.keys(prevItem).forEach((key) => {
        if (!(key in newItem) && !OWN_ITEM_FIELDS.includes(key)) {
          delete prevItem[key];
        }
      });
      Object.assign(prevItem, newItem);
      if (carried) {
        prevItem.items = carried;
      }
      return prevItem;
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private loadItems(item: MenuItem, event: MouseEvent | KeyboardEvent = null) {
    if (item && item.endpoint) {
      item.loading = true;
      const load = fetchResults(item.endpoint)
        .then((items: MenuItem[]) => {
          items = this.mergeItems(item, items);

          // update our item level
          items.forEach((subItem) => {
            subItem.level = item.level + 1;
            // if we came with preset items, set the level for them accordingly
            if (subItem.items) {
              subItem.items.forEach((inlineItem) => {
                inlineItem.level = item.level + 2;
              });
            }
          });

          item.items = items;
          item.loading = false;

          if (this.submenu && this.selection.length == 0) {
            const sub = this.getMenuItemForSelection([this.submenu]);
            this.handleItemClicked(event, sub);
          }

          if (!this.wait) {
            this.fireCustomEvent(CustomEventType.Ready);
            this.wait = true;
          }

          this.requestUpdate('root');
          this.scrollSelectedIntoView();
        })
        .catch((error) => {
          this.fireCustomEvent(CustomEventType.Error, { error });
        });
      this.trackLoad(load);
    }
  }

  private handleItemClicked(
    event: MouseEvent | KeyboardEvent,
    menuItem: MenuItem,
    parent: MenuItem = null
  ) {
    const store = document.querySelector('temba-store') as Store;
    if (store) {
      if (store.getDirtyMessage()) {
        store
          .getState()
          .flushSave?.()
          .then(() => {
            store.cleanAll();
            this.executeNavigation(event, menuItem, parent);
          });
        return;
      }
      store.cleanAll();
    }

    this.executeNavigation(event, menuItem, parent);
  }

  private executeNavigation(
    event: MouseEvent | KeyboardEvent,
    menuItem: MenuItem,
    parent: MenuItem = null
  ) {
    if (parent && parent.popup) {
      const dropdown = this.shadowRoot.querySelector(
        `#dd-${CSS.escape(parent.id)}`
      ) as Dropdown;
      if (dropdown) {
        dropdown.close();
      }

      if (event) {
        this.fireCustomEvent(CustomEventType.ButtonClicked, {
          item: menuItem,
          selection: this.getSelection(),
          parent
        });
      }
      return;
    }

    if (menuItem.popup) {
      if (event) {
        this.fireCustomEvent(CustomEventType.ButtonClicked, {
          item: menuItem,
          selection: this.getSelection(),
          parent
        });
      }
      return;
    }

    if (menuItem.type === 'modax-button' || menuItem.type === 'button') {
      this.fireCustomEvent(CustomEventType.ButtonClicked, {
        item: menuItem,
        selection: this.getSelection(),
        parent
      });
      return;
    }

    if (event && event.metaKey && menuItem.href) {
      event.preventDefault();
      event.stopPropagation();
      window.open(menuItem.href, '_blank');
      return;
    }

    if (parent && parent.inline) {
      this.handleItemClicked(null, parent);
    }

    if (this.collapsed && !this.isMobile()) {
      this.collapsed = false;
    }

    if (this.isMobile()) {
      this.collapsed = true;
    }

    if (menuItem.trigger || menuItem.event) {
      this.fireCustomEvent(CustomEventType.ButtonClicked, {
        item: menuItem,
        selection: this.getSelection(),
        parent
      });
      return;
    }

    // update our selection
    if (menuItem.level >= this.selection.length) {
      this.selection.push(menuItem.vanity_id || menuItem.id);
    } else {
      this.selection.splice(
        menuItem.level,
        this.selection.length - menuItem.level,
        menuItem.vanity_id || menuItem.id
      );
    }

    if (menuItem.endpoint) {
      this.loadItems(menuItem, event);

      // make sure change events fire for events with hrefs
      if (!menuItem.href) {
        return;
      }
    } else {
      this.requestUpdate();
    }

    if (menuItem.href) {
      this.dispatchEvent(new Event('change'));
      return;
    }

    this.fireCustomEvent(CustomEventType.ButtonClicked, {
      item: menuItem,
      selection: this.getSelection(),
      parent
    });
  }

  public scrollSelectedIntoView() {
    // makes sure we are scrolled into view
    window.setTimeout(() => {
      const eles = this.shadowRoot.querySelectorAll('.selected');
      eles.forEach((ele) => {
        ele.scrollIntoView({ block: 'end', behavior: 'smooth' });
      });
    }, 0);
  }

  public clickItem(id: string): boolean {
    const path = [...this.selection];
    path.splice(path.length - 1, 1, id);
    const item = this.getMenuItemForSelection(path);

    if (item) {
      this.handleItemClicked(null, item);
      this.scrollSelectedIntoView();
      return true;
    }
    return false;
  }

  public getMenuItem(): MenuItem {
    return this.getMenuItemForSelection([...this.selection]);
  }

  public getMenuItemForSelection(selection: string[]) {
    const path = [...selection];
    let items = this.root.items;
    let item = null;
    while (path.length > 0) {
      const step = path.splice(0, 1)[0];
      if (items) {
        item = findItem(items, step).item;
        if (item) {
          items = item.items;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    return item;
  }

  public getSelection() {
    return this.selection;
  }

  public handleExpand() {
    this.collapsed = false;
  }

  public handleCollapse() {
    this.collapsed = true;
  }

  public async setFocusedItem(path: string) {
    const focusedPath = path.split('/').filter((step) => !!step);
    if (!this.root) {
      return;
    }

    // if we don't match at the first level, we are a noop
    if (focusedPath.length > 0) {
      const rootItem = findItem(this.root.items, focusedPath[0]).item;
      if (!rootItem) {
        return;
      }
    }

    const newPath = [];
    let level = this.root;
    while (focusedPath.length > 0) {
      const nextId = focusedPath.shift();
      if (nextId) {
        if (!level.items) {
          this.loadItems(level);
          await this.httpComplete;
        }

        level = findItem(level.items, nextId).item;
        if (!level) {
          focusedPath.splice(0, focusedPath.length);
        } else {
          newPath.push(nextId);
        }
      }
    }

    this.selection = newPath;
    this.refresh();
    this.requestUpdate('root');
  }

  private isSelected(menuItem: MenuItem) {
    if (menuItem.level < this.selection.length) {
      const selected =
        this.selection[menuItem.level] == (menuItem.vanity_id || menuItem.id);
      return selected;
    }
    return false;
  }

  private isExpanded(menuItem: MenuItem) {
    const expanded = !!this.selection.find(
      (id) => id === menuItem.vanity_id || menuItem.id
    );
    return expanded;
  }

  private renderMenuItem = (
    menuItem: MenuItem,
    parent: MenuItem = null
  ): TemplateResult => {
    if (menuItem.type === 'divider') {
      return html`<div class="divider"></div>`;
    }

    if (menuItem.type === 'temba-workspace-select') {
      return html`<temba-workspace-select
        @change=${(event) => {
          event.stopPropagation();
          event.preventDefault();
        }}
        .values=${[JSON.parse(menuItem.initial)]}
      ></temba-workspace-select>`;
    }

    if (menuItem.type === 'temba-notification-list') {
      return html`<temba-notification-list
        endpoint=${menuItem.href}
        @temba-notification=${() => {
          // light the unseen badge on our popup item as they arrive
          if (parent && parent.bubble !== 'tomato') {
            parent.bubble = 'tomato';
            this.requestUpdate('root');
          }
        }}
      ></temba-notification-list>`;
    }

    if (menuItem.type === 'space') {
      return html`<div class="space"></div>`;
    }

    if (menuItem.type === 'link') {
      return html`<a
        id="menu-${menuItem.id}"
        class="popup-link"
        href=${ifDefined(menuItem.href ? menuItem.href : undefined)}
        target=${ifDefined(menuItem.target ? menuItem.target : undefined)}
        tabindex=${ifDefined(menuItem.href ? undefined : '0')}
        @click=${(event: MouseEvent) => {
          event.preventDefault();
          this.handleItemClicked(event, menuItem, parent);
        }}
        @keydown=${(event: KeyboardEvent) => {
          // anchors without an href aren't keyboard activatable on their own
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            this.handleItemClicked(event, menuItem, parent);
          }
        }}
      >
        ${menuItem.icon
          ? html`<temba-icon name="${menuItem.icon}"></temba-icon>`
          : null}
        ${menuItem.name}
      </a>`;
    }

    if (menuItem.type === 'section' || menuItem.inline) {
      return html`<div class="sub-section">${menuItem.name}</div>`;
    }

    if (menuItem.type === 'modax-button' || menuItem.type === 'button') {
      return html`<temba-button
        name=${menuItem.name}
        lined
        icon=${menuItem.icon}
        @click=${(event) => {
          this.handleItemClicked(event, menuItem);
        }}
      />`;
    }

    const isSelected = this.isSelected(menuItem);
    const isChildSelected =
      isSelected && this.selection.length > menuItem.level + 1;

    let icon = menuItem.icon
      ? html`<div class="icon-wrapper">
          <temba-icon
            size="${menuItem.level === 0 ? '1.35' : '1'}"
            name="${menuItem.icon}"
          ></temba-icon
          >${menuItem.bubble && !menuItem.count
            ? html`<div
                style="background-color: ${menuItem.bubble}"
                class="bubble"
              ></div>`
            : null}
        </div>`
      : null;

    const collapsedIcon = menuItem.collapsed_icon
      ? html`<temba-icon
          size="${menuItem.level === 0 ? '1.35' : '1'}"
          name="${menuItem.collapsed_icon}"
          class="collapse-icon"
        ></temba-icon>`
      : null;

    const itemClasses = getClasses({
      ['menu-' + menuItem.id]: true,
      'child-selected': isChildSelected,
      selected: isSelected,
      item: !(menuItem.avatar && menuItem.level === 0),
      avatar: !!menuItem.avatar,
      popup: menuItem.popup,
      inline: menuItem.inline,
      expanded: this.isExpanded(menuItem),
      iconless: !icon && !collapsedIcon && !menuItem.avatar,
      pressed: this.pressedItem && this.pressedItem.id == menuItem.id
    });

    if (menuItem.avatar) {
      icon = renderAvatar({
        name: menuItem.avatar,
        scale: parent ? 0.9 : 1.2
      });
      if (menuItem.bubble) {
        icon = html`${icon}${menuItem.bubble
          ? html`<div
              style="background-color: ${menuItem.bubble}"
              class="bubble"
            ></div>`
          : null}`;
      }
      icon = html`<div style="position:relative; padding: 0em">${icon}</div>`;
    }

    const item = html`
      <a
        href=${ifDefined(menuItem.href ? menuItem.href : undefined)}
        id="menu-${menuItem.id}"
        class="${itemClasses}"
        @click=${(event) => {
          event.preventDefault();
          this.pressedItem = null;
          this.handleItemClicked(event, menuItem, parent);
        }}
        @mousedown=${() => {
          if (menuItem.level > 0) {
            this.pressedItem = menuItem;
          }
        }}
        @mouseleave=${() => {
          this.pressedItem = null;
        }}
      >
        ${menuItem.level === 0
          ? menuItem.avatar || menuItem.popup
            ? icon
            : html`<temba-tip
                position="right"
                style="display:flex;"
                text="${menuItem.name}"
                >${icon}</temba-tip
              >`
          : html`${icon}${collapsedIcon}`}

        <div class="details" style="flex-grow:1;display:flex">
          <div
            class="name"
            style="flex-grow:1; flex-shrink:0; white-space: nowrap;"
          >
            ${menuItem.name}
          </div>
          ${menuItem.level > 0
            ? menuItem.inline
              ? html`<temba-icon
                  name="${isSelected || isChildSelected
                    ? Icon.arrow_up
                    : Icon.arrow_down}"
                ></temba-icon>`
              : html`${menuItem.count || menuItem.count == 0
                  ? html`
                      <div
                        class="count ${menuItem.bubble ? 'bubble' : ''}"
                        style="background-color: ${menuItem.bubble}"
                      >
                        ${formatCount(menuItem.count)}
                      </div>
                    `
                  : html`<div class="count"></div>`}`
            : null}
        </div>
        <div class="right"></div>
      </a>
    `;

    if (menuItem.popup) {
      return html`
        <temba-dropdown
          id="dd-${menuItem.id}"
          ?up=${!!menuItem.bottom}
          anchor="a"
          @temba-opened=${(event: CustomEvent) =>
            this.handlePopupOpened(event, menuItem)}
        >
          <div slot="toggle">${item}</div>

          <div slot="dropdown">
            ${(menuItem.items || []).map((child: MenuItem) => {
              child.level = menuItem.level + 1;
              return html`${this.renderMenuItem(child, menuItem)}`;
            })}
          </div>
        </temba-dropdown>
      `;
    }
    return item;
  };

  public render(): TemplateResult {
    if (!this.root || !this.root.items) {
      return null;
    }

    let items = this.root.items || [];
    const levels = [];

    const expandIcon = this.isMobile() ? Icon.menu : Icon.menu_collapse;

    levels.push(
      html`<div class="level level-0 ${this.submenu ? 'hidden' : ''}">
        <div class="top">
          <div class="expand-icon" @click=${this.handleExpand}>
            <temba-icon
              name="${expandIcon}"
              class="collapse expand"
              size="1.4"
            ></temba-icon>
          </div>
        </div>
        <div class="top-spacer"></div>

        ${items
          .filter((item) => !item.bottom)
          .map((item: MenuItem) => {
            return this.renderMenuItem(item);
          })}

        <div class="empty"></div>
        ${items
          .filter((item) => !!item.bottom)
          .map((item: MenuItem) => {
            return this.renderMenuItem(item);
          })}
        <div class="bottom"></div>
      </div>`
    );

    this.selection.forEach((id, index) => {
      const selected = findItem(items, id).item;

      let collapsed = false;
      if (selected) {
        items = selected.items;
        const itemState = this.getMenuItemState(selected.id);
        // users set an explicit collapse state
        if (itemState.collapsed) {
          collapsed = itemState.collapsed === 'collapsed';
        }
        // otherwise pick a default collapse state
        else {
          if (this.selection.length > selected.level + 2) {
            collapsed = false;
          }
        }
      } else {
        items = null;
      }

      const collapseIcon = this.isMobile() ? Icon.close : Icon.menu_collapse;

      if (items && items.length > 0 && !selected.inline) {
        levels.push(
          html`<div
            class="${getClasses({
              level: true,
              ['level-' + (index + 1)]: true,
              collapsed
            })}"
          >
            ${!this.submenu
              ? html`
                  <slot
                    class="${getClasses({
                      'show-header': selected.show_header
                    })}"
                    name="header"
                  ></slot>
                  <div class="section-header">
                    <div class="section">${selected.name}</div>

                    ${index == 0 && !this.collapsed
                      ? html`<temba-icon
                          name=${collapseIcon}
                          size="1"
                          @click=${this.handleCollapse}
                        ></temba-icon>`
                      : null}
                  </div>
                `
              : null}
            ${items.map((item: MenuItem) => {
              if (item.inline && item.items) {
                return html`${this.renderMenuItem(item)}
                  <div class="inline-children">
                    ${(item.items || []).map((child: MenuItem) => {
                      return this.renderMenuItem(child, item);
                    })}
                  </div>`;
              }
              return this.renderMenuItem(item);
            })}
          </div>`
        );
      }
    });

    const menu = html`<div
      class="${getClasses({
        root: true,
        'fully-collapsed': this.collapsed,
        mobile: this.isMobile()
      })}"
    >
      ${levels}
    </div>`;
    return html`${menu}`;
  }
}
