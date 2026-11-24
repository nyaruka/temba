import { css, html, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { CustomEventType } from '../interfaces';
import { getClasses, postJSON } from '../utils';
import { Card } from './Card';

/** Saved card layout state — order and collapsed lists may reference cards
 * beyond the ones the current page renders. */
export interface CardSettings {
  order?: string[];
  collapsed?: string[];
  width?: number;
}

/**
 * Responsive layout for a main view with supporting panels. When wide, the
 * main slot fills the space and panels render as collapsible, drag-sortable
 * cards in a right-hand column. Below the breakpoint the same panels are
 * re-projected into a tab pane (main content first) — the slotted elements
 * never disconnect, so their state (sockets, fetched data) survives switches.
 *
 * Panels are declared as slotted temba-cards with an id; the main view goes
 * in slot="main". Anything in slot="header" heads the main view: the two
 * share one card, and in tab view that card takes in the tab strip and
 * every tab's content too, so the header stays put whichever tab is open.
 *
 * The layout can persist card order, collapsed state and the chosen main
 * width itself: seed it with `settings` and point `settings-endpoint` at a
 * POST endpoint that merges top-level keys (rapidpro's user settings view).
 * Saves are debounced and posted as `{[settingsKey]: {order, collapsed,
 * width}}`. The saved state is the union across pages — a page rendering
 * only a subset of the cards merges its relative order into the full saved
 * order rather than clobbering the position of cards it doesn't show, and a
 * page that never sets a width re-posts the saved one rather than clearing
 * it. Double-clicking the resize handle returns to the automatic width and
 * clears the saved one.
 */
export class CardLayout extends RapidElement {
  static get styles() {
    return css`
      :host {
        display: flex;
        flex-direction: column;
        flex-grow: 1;
        min-height: 0;
        /* anchors the tab-view resize handle on the right inset */
        position: relative;
      }

      /* in tab view there is no card column running to the edge — the
         layout itself keeps the content off the right edge */
      :host([narrow]) {
        padding-right: var(--layout-spacing, 8px);
      }

      /* One spacing unit everywhere: left of the main view (host padding,
         supplied by the page), above it, between it and the cards, and
         between the cards and the scrollbar. */
      .body {
        flex-grow: 1;
        min-height: 0;
        display: flex;
      }

      .main {
        /* the main view keeps a comfortable reading width — extra space
           goes to the card column, not the main view */
        flex: 0 1 var(--main-width, 650px);
        min-width: 0;
        display: flex;
        flex-direction: column;
        padding-top: var(--layout-spacing, 8px);
        padding-bottom: var(--layout-spacing, 8px);
        /* anchors the card-view resize handle in the gap to our right */
        position: relative;
      }

      /* drag handle for resizing the main view — in card view it rides the
         gap between the main view and the card column, in tab view (.edge)
         it rides the layout's right inset. touch-action keeps the browser
         from claiming the drag as a scroll gesture on touch pointers. */
      .resize-handle {
        position: absolute;
        top: 0;
        bottom: 0;
        right: calc(var(--layout-spacing, 8px) * -1 - 1px);
        width: calc(var(--layout-spacing, 8px) + 2px);
        cursor: col-resize;
        z-index: 1;
        display: flex;
        justify-content: center;
        touch-action: none;
        outline: none;
      }

      /* in tab view the handle rides the layout's right inset — keep it
         inside that inset so it doesn't overlay (and swallow pointer
         events on) the edge of the tab content */
      .resize-handle.edge {
        right: 0;
        width: var(--layout-spacing, 8px);
      }

      .resize-handle .grip {
        width: 3px;
        border-radius: 2px;
        background: transparent;
      }

      .resize-handle:hover .grip,
      .resize-handle:focus-visible .grip,
      .resize-handle.active .grip {
        background: var(--border-strong);
      }

      slot[name='main']::slotted(*) {
        flex-grow: 1;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        /* the layout owns spacing — strip any host margin the slotted
           main view carries for standalone use */
        margin: 0;
      }

      /* in tab view the main pane gets the same gap below the tab strip
         and above the bottom edge that the cards have */
      :host([narrow]) slot[name='main']::slotted(*) {
        margin-top: var(--layout-spacing, 8px);
        margin-bottom: var(--layout-spacing, 8px);
      }

      .column {
        /* the column soaks up whatever the main view doesn't take. Its
           scrollport runs the full height (the host supplies no vertical
           padding) so the scrollbar bleeds top to bottom, while the inner
           padding aligns the cards with the main view — including below,
           so the last card scrolls to rest level with the bottom of the
           main view — and doubles as room for card shadows. */
        flex: 1 0 var(--card-column-width, 360px);
        min-height: 0;
        /* without min-width:0 the column's automatic minimum is its
           content's intrinsic width, so one long unbreakable line in
           a card (e.g. a flow pill's name) widens the whole column
           instead of ellipsizing — the flex basis still keeps it
           from shrinking below the configured column width */
        min-width: 0;
        overflow-y: auto;
        padding: var(--layout-spacing, 8px);
      }

      temba-tabs {
        margin-top: var(--layout-spacing, 8px);
        flex-grow: 1;
        min-height: 0;
      }

      /* without a header the frame stays out of the layout entirely */
      .frame {
        display: contents;
      }

      /* with one, it's the card the header and the main view (or, in tab
         view, the tabs) share - what it holds drops its own chrome */
      .frame.framed {
        display: flex;
        flex-direction: column;
        flex-grow: 1;
        min-height: 0;
        background: var(--surface);
        border: 1px solid var(--border-strong);
        border-radius: var(--r-lg);
        box-shadow: var(--shadow-2);
        overflow: hidden;
        --framed-border: none;
        --framed-radius: 0;
        --framed-shadow: none;
        /* room for anything floating inside the frame, e.g. the chat's
           search bar, to keep off its edges */
        --framed-inset: 8px;
      }

      :host([narrow]) .frame.framed {
        margin: var(--layout-spacing, 8px) 0;
      }

      .framed .frame-header {
        flex-shrink: 0;
        border-bottom: 1px solid var(--border);
      }

      .framed temba-tabs {
        margin-top: 0;
      }

      :host([narrow]) .framed slot::slotted(*) {
        margin-top: 0;
        margin-bottom: 0;
      }
    `;
  }

  // explicit width below which the tab view is used — when unset (0), the
  // flip point is computed from what the layout actually needs: the card
  // column's footprint plus a comfortable minimum for the main view
  @property({ type: Number })
  breakpoint = 0;

  // minimum comfortable main-view width before flipping to tabs — lean
  // toward card mode: the main view may get snug before we give up on it
  @property({ type: Number, attribute: 'main-min-width' })
  mainMinWidth = 420;

  // column basis (360) plus its horizontal spacing (2 x 8px) — keep in
  // sync with the .column CSS defaults
  static COLUMN_FOOTPRINT = 376;

  // user-chosen main-view width in px (0 = automatic). Dragging the resize
  // handle sets it, and it participates in the flip: the cards always keep
  // their footprint, so a wider chat flips to tabs sooner
  @property({ type: Number, attribute: false })
  mainWidth = 0;

  // a drag on the resize handle is in progress
  @property({ type: Boolean, attribute: false })
  resizing = false;

  // last observed layout width — the handles use it to decide whether a
  // resize could reach card mode at all before offering themselves
  @property({ type: Number, attribute: false })
  hostWidth = 0;

  // last measured width of the rendered main pane — the separator
  // announces it while the width is still automatic (no chosen width)
  @property({ type: Number, attribute: false })
  mainPaneWidth = 0;

  /** The narrowest layout that can show card mode at any main-view width. */
  private getMinFlipWidth(): number {
    return this.breakpoint > 0
      ? this.breakpoint
      : this.mainMinWidth + CardLayout.COLUMN_FOOTPRINT;
  }

  /** The main width the layout actually renders. A width saved on a page
   * with a lower floor still gets this page's minimum, but merely
   * rendering at that floor never writes it back into `mainWidth` — that
   * would clobber the user's chosen width for the page it was chosen on.
   * An explicit resize here (drag or arrow key) does step from the floor
   * and does commit: the user is choosing a width on this page, so this
   * page's minimum is the right thing to start from. */
  private getEffectiveMainWidth(): number {
    return this.mainWidth > 0 ? Math.max(this.mainWidth, this.mainMinWidth) : 0;
  }

  private getFlipWidth(): number {
    const min = this.getMinFlipWidth();
    const width = this.getEffectiveMainWidth();
    // a user-sized main view raises the bar — the cards keep their
    // footprint rather than being squeezed beside it
    return width > 0 ? Math.max(min, width + CardLayout.COLUMN_FOOTPRINT) : min;
  }

  /** Whether the layout is wide enough for a resize to land anywhere
   * useful: the main view at its minimum beside the card column, and at
   * or above any explicit breakpoint. Narrower than that a drag can only
   * strand the layout in tab mode — the flip width it would need exceeds
   * the layout — so no handle is offered. Note an explicit *low*
   * breakpoint says "prefer cards", it doesn't make dragging work: the
   * footprint floor still applies. */
  private isResizable(): boolean {
    return (
      this.hostWidth >=
      Math.max(
        this.getMinFlipWidth(),
        this.mainMinWidth + CardLayout.COLUMN_FOOTPRINT
      )
    );
  }

  /** The widest main view that still leaves the cards their footprint —
   * the separator's maximum. */
  private getResizeMax(): number {
    return this.hostWidth - CardLayout.COLUMN_FOOTPRINT;
  }

  /** Keep a width inside the range the separator advertises. In tab view
   * the pane spans more than the widest card-mode fit, so an unclamped
   * value would fall outside [valuemin, valuemax]. */
  private clampResizeWidth(width: number): number {
    return Math.min(Math.max(width, this.mainMinWidth), this.getResizeMax());
  }

  /** The value the separator announces: the chosen width when there is
   * one, otherwise the last measured pane width. */
  private getAnnouncedWidth(): number {
    return Math.round(
      this.clampResizeWidth(
        this.getEffectiveMainWidth() || this.mainPaneWidth || this.mainMinWidth
      )
    );
  }

  /** Width the main view occupies now — in tab view it fills the layout,
   * so a resize from there starts at the full width. */
  private getMainPaneWidth(): number {
    const main = this.shadowRoot?.querySelector('.main') as HTMLElement;
    return main ? main.offsetWidth : this.offsetWidth;
  }

  @property({ type: Array })
  order: string[] = [];

  // saved order + collapsed state to seed from (JSON attribute)
  @property({ type: Object })
  settings: CardSettings = null;

  // where to POST settings changes; persistence is off when unset
  @property({ type: String, attribute: 'settings-endpoint' })
  settingsEndpoint = '';

  // top-level key the settings are posted (and saved) under
  @property({ type: String, attribute: 'settings-key' })
  settingsKey = 'contact_cards';

  // debounce window for settings saves (ms) — tests shrink it
  saveDelay = 500;

  // the full saved lists — unlike `order`, these keep ids for cards other
  // pages show, so a save from this page can't clobber their state
  private savedOrder: string[] = [];
  private savedCollapsed: string[] = [];
  // the last width we know is stored — a page where the user never sets a
  // width re-posts this rather than dropping the key and clearing the
  // width chosen on another page
  private savedWidth = 0;

  // cards whose collapsed state has been seeded from settings — seed once
  // so a later mutation can't undo the user's toggles
  private seeded = new Set<string>();

  private saveTimeout: ReturnType<typeof setTimeout> = null;

  @property({ type: String, attribute: 'main-name' })
  mainName = 'Chat';

  @property({ type: String, attribute: 'main-icon' })
  mainIcon = 'message';

  @property({ type: Boolean, reflect: true })
  narrow = false;

  // whether anything is slotted into the header
  @state()
  private hasHeader = false;

  // in tab view, drop tab labels (icons only, selected keeps its name)
  // once the pane is too tight to show them all
  @property({ type: Boolean })
  compactTabs = false;

  static COMPACT_TABS_WIDTH = 560;

  private resizer: ResizeObserver;
  private mutations: MutationObserver;

  private handleDetailsChanged = () => {
    // tab entries render card metadata (count/activity) by value — refresh
    // them when a projected panel reports new details
    if (this.narrow) {
      this.requestUpdate();
    }
  };

  private handleToggle = (event: Event) => {
    // only collapse toggles from our own cards should trigger a save
    if ((event.target as Element).parentElement === this) {
      this.scheduleSave();
    }
  };

  public connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener(
      CustomEventType.DetailsChanged,
      this.handleDetailsChanged
    );
    this.addEventListener('toggle', this.handleToggle);

    // the wide render reprojects via its slotchange, but the narrow render
    // has no default slot — watch for cards added/removed in either mode
    this.mutations = new MutationObserver(() => {
      this.applyProjection();
      this.applyOrder();
      this.applyCollapsed();
      this.requestUpdate();
    });
    this.mutations.observe(this, { childList: true });

    this.resizer = new ResizeObserver(() => {
      // defer out of the observer callback — flipping modes re-renders and
      // resizes us, which would otherwise trip the browser's RO loop guard
      requestAnimationFrame(() => this.updateModes());
    });
    this.resizer.observe(this);
  }

  private updateModes() {
    const width = this.offsetWidth;
    if (width > 0) {
      this.hostWidth = width;
      this.narrow = width < this.getFlipWidth();
      this.compactTabs = width < CardLayout.COMPACT_TABS_WIDTH;
      // keep the separator's announced width current without measuring on
      // every render — only while the width is automatic, since a chosen
      // width is announced from state and measuring here would force a
      // layout on every frame of a drag
      if (this.mainWidth === 0) {
        this.mainPaneWidth = this.getMainPaneWidth();
      }
    }
  }

  public disconnectedCallback(): void {
    this.removeEventListener(
      CustomEventType.DetailsChanged,
      this.handleDetailsChanged
    );
    this.removeEventListener('toggle', this.handleToggle);
    this.resizer?.disconnect();
    this.mutations?.disconnect();
    this.releaseResize();

    // flush a pending save so navigating away doesn't drop it
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
      this.saveSettings();
    }
    super.disconnectedCallback();
  }

  public getCards(): Card[] {
    return Array.from(
      this.querySelectorAll(':scope > temba-card[id]')
    ) as Card[];
  }

  public getIds(): string[] {
    return this.getCards().map((card) => card.id);
  }

  private dragStartX = 0;
  private dragStartWidth = 0;
  // the chosen width when the drag began, restored if it is cancelled
  private dragStartMainWidth = 0;
  // whether the pointer has actually travelled — a click on the handle
  // (a trackpad tap can fire a pointermove with a pixel or two of drift)
  // must not commit a width, which would also turn an automatic width
  // into a chosen one
  private dragMoved = false;
  // whether the pointer moved far enough to change the width — a click on
  // the handle shouldn't announce a resize or post settings
  private dragChanged = false;
  // a keyboard step is pending — if it flips the mode, focus follows the
  // rebuilt handle
  private refocusHandle = false;
  private previousBodyUserSelect = '';
  private previousBodyCursor = '';

  // dragging past the widest fit pins the chat there; the pointer must
  // then travel this fraction of the card column before the layout flips
  // to tabs — and come the complementary fraction back across it before
  // the cards pop back out
  static FLIP_DRAG_RATIO = 0.75;

  // travel (px) before a press counts as a drag — a click on the handle
  // carries a pixel or two of drift, which must not commit a width
  static DRAG_THRESHOLD = 3;

  private handleResizeStart = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // a second pointer replaces rather than overlaps an active drag, so
    // the captured body styles stay the ones we found before any drag
    this.releaseResize();
    event.preventDefault();
    // in tab view the main pane fills the layout, so the drag starts from
    // the full width — the cards return only once the pointer has come
    // most of the way back across the column they will occupy
    this.dragStartX = event.clientX;
    this.dragStartWidth = this.getMainPaneWidth();
    this.dragStartMainWidth = this.mainWidth;
    this.dragMoved = false;
    this.dragChanged = false;
    this.resizing = true;
    this.previousBodyUserSelect = document.body.style.userSelect;
    this.previousBodyCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    // deliberately no setPointerCapture: a flip between card and tab mode
    // mid-drag tears this handle out of the shadow DOM, which would end
    // the capture and kill the drag — window listeners survive the flip
    window.addEventListener('pointermove', this.handleResizeMove);
    window.addEventListener('pointerup', this.handleResizeEnd);
    window.addEventListener('pointercancel', this.handleResizeCancel);
  };

  private handleResizeMove = (event: PointerEvent) => {
    event.preventDefault();
    if (
      Math.abs(event.clientX - this.dragStartX) >= CardLayout.DRAG_THRESHOLD
    ) {
      this.dragMoved = true;
    }
    // a press that hasn't really travelled isn't a resize — leave the
    // width alone (in particular, don't turn an automatic width into a
    // chosen one, which would also move the flip point for good)
    if (!this.dragMoved) {
      return;
    }
    // deliberately the live width rather than the lagged `hostWidth`: mid
    // window-resize the pointer is working against the layout as it is
    // now, not as the resize observer last saw it
    const width = this.offsetWidth;
    // the widest chat that still leaves the cards their footprint
    const max = width - CardLayout.COLUMN_FOOTPRINT;
    // where the pointer says the chat edge should be — it can run past
    // the widest fit without the chat following
    const dragged = Math.min(
      Math.max(
        this.dragStartWidth + event.clientX - this.dragStartX,
        this.mainMinWidth
      ),
      width
    );

    const flipZone = CardLayout.COLUMN_FOOTPRINT * CardLayout.FLIP_DRAG_RATIO;
    const returnZone = CardLayout.COLUMN_FOOTPRINT - flipZone;
    let next: number;
    if (this.narrow) {
      // in tabs the cards return only once the pointer has dragged far
      // enough back; until then the width keeps tracking the pointer so
      // a release leaves tab mode in place
      next = dragged < max + returnZone ? Math.min(dragged, max) : dragged;
    } else {
      // in cards the chat stops growing at the widest fit — the flip to
      // tabs waits until the pointer has crossed most of the card column
      next = dragged > max + flipZone ? dragged : Math.min(dragged, max);
    }

    if (next !== this.mainWidth) {
      this.mainWidth = next;
      this.dragChanged = true;
    }
  };

  private handleResizeEnd = () => {
    const changed = this.dragChanged;
    this.releaseResize();
    if (changed) {
      this.fireCustomEvent(CustomEventType.Resized, { width: this.mainWidth });
      this.scheduleSave();
    }
  };

  /** A cancelled gesture (the browser or OS taking the pointer away) is
   * not a resize — put the width back where the drag found it. This is a
   * deliberate divergence from ContentList, which commits on cancel. */
  private handleResizeCancel = () => {
    const changed = this.dragChanged;
    this.releaseResize();
    if (changed) {
      this.mainWidth = this.dragStartMainWidth;
    }
  };

  /** Arrow keys resize in 10px steps (25px with Shift), the keyboard
   * equivalent of dragging the separator. There is no hysteresis here —
   * the width simply clamps to what fits, so a shrink press from tab mode
   * lands in card mode at the widest width the cards leave room for. */
  private handleResizeKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 25 : 10;
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    // step from state when a width is chosen — a measurement here would
    // still read the previous step until its render has flushed, folding
    // rapid same-task presses into one
    const current = this.getEffectiveMainWidth() || this.getMainPaneWidth();
    const width = this.clampResizeWidth(current + direction * step);

    // in tab view the pane already spans more than the widest card-mode
    // fit, so there is nothing to grow into — growing must not shrink the
    // pane (and pop the cards back out) as a side effect of the clamp
    if (direction > 0 && width < current) {
      return;
    }

    if (width !== this.mainWidth) {
      this.mainWidth = width;
      // if this press flips the mode, the handle is rebuilt from the
      // other template and focus falls to the body — move it to the new
      // handle so the keyboard user isn't stranded
      this.refocusHandle = true;
      this.fireCustomEvent(CustomEventType.Resized, { width });
      this.scheduleSave();
    }
  };

  /** Double-click returns the layout to the automatic width — the one
   * escape hatch from a chosen width. An explicit reset also clears the
   * stored width (unlike a passive save from a page rendering at the
   * automatic width, which carries the stored value through). The two
   * clicks that make up the double-click commit nothing on their own —
   * a press with no travel is not a resize. */
  private handleResizeReset = () => {
    if (this.mainWidth === 0 && this.savedWidth === 0) {
      return;
    }
    this.mainWidth = 0;
    this.savedWidth = 0;
    this.fireCustomEvent(CustomEventType.Resized, { width: 0 });
    this.scheduleSave();
  };

  private releaseResize() {
    if (!this.resizing) {
      return;
    }
    this.resizing = false;
    document.body.style.userSelect = this.previousBodyUserSelect;
    document.body.style.cursor = this.previousBodyCursor;
    window.removeEventListener('pointermove', this.handleResizeMove);
    window.removeEventListener('pointerup', this.handleResizeEnd);
    window.removeEventListener('pointercancel', this.handleResizeCancel);
  }

  /**
   * Route each card to the right place for the current mode: the default
   * slot (forwarded into the card stack) when wide, or its own named slot
   * inside a chromeless tab when narrow.
   */
  private applyProjection() {
    this.getCards().forEach((card) => {
      if (this.narrow) {
        card.setAttribute('slot', `panel-${card.id}`);
        card.setAttribute('plain', '');
      } else {
        card.removeAttribute('slot');
        card.removeAttribute('plain');
      }
    });
  }

  private applyOrder() {
    if (!this.order || this.order.length === 0) {
      return;
    }

    const cards = this.getCards();
    const listed = this.order
      .map((id) => cards.find((card) => card.id === id))
      .filter(Boolean) as Card[];
    const unlisted = cards.filter((card) => !listed.includes(card));
    const desired = [...listed, ...unlisted];

    if (desired.every((card, idx) => card === cards[idx])) {
      return;
    }

    desired.forEach((card) => this.appendChild(card));
    this.requestUpdate();
  }

  /** Seed collapsed state from the saved settings — once per card, so
   * later slot churn can't undo a toggle the user has since made. */
  private applyCollapsed() {
    if (!this.settings) {
      return;
    }
    const collapsed = this.settings.collapsed || [];
    this.getCards().forEach((card) => {
      if (!this.seeded.has(card.id)) {
        this.seeded.add(card.id);
        if (collapsed.includes(card.id)) {
          card.collapsed = true;
        }
      }
    });
  }

  private handleHeaderSlotChange(event: Event) {
    this.hasHeader =
      (event.target as HTMLSlotElement).assignedElements().length > 0;
  }

  private renderFrame(content: TemplateResult): TemplateResult {
    return html`
      <div class=${getClasses({ frame: true, framed: this.hasHeader })}>
        <div class="frame-header">
          <slot name="header" @slotchange=${this.handleHeaderSlotChange}></slot>
        </div>
        ${content}
      </div>
    `;
  }

  private handleSlotChange() {
    this.applyProjection();
    this.applyOrder();
    this.applyCollapsed();
    // tab entries render from the slotted cards
    this.requestUpdate();
  }

  private handleOrderChanged(event: CustomEvent) {
    // keep our order prop in sync so a mode switch and back doesn't undo
    // a drag; the event continues up to the host
    this.order = event.detail.ids;
    this.scheduleSave();
  }

  private scheduleSave() {
    if (!this.settingsEndpoint) {
      return;
    }
    clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveSettings();
    }, this.saveDelay);
  }

  /** Slot this page's cards into the full saved order without disturbing
   * the position of cards this page doesn't show. */
  private mergeOrder(existing: string[], present: string[]): string[] {
    const queue = present.slice();
    const result = existing.map((id) =>
      present.includes(id) ? queue.shift() : id
    );
    return result.concat(queue);
  }

  private saveSettings() {
    if (!this.settingsEndpoint) {
      return;
    }

    const present = this.getIds();
    const collapsed = this.getCards()
      .filter((card) => card.collapsed)
      .map((card) => card.id);

    this.savedOrder = this.mergeOrder(this.savedOrder, present);
    this.savedCollapsed = this.savedCollapsed
      .filter((id) => !present.includes(id))
      .concat(collapsed);

    const settings: CardSettings = {
      order: this.savedOrder,
      collapsed: this.savedCollapsed
    };
    // an automatic width on this page doesn't mean "no width anywhere" —
    // carry the stored one through so a save from here doesn't clear it
    const width = Math.round(this.mainWidth) || this.savedWidth;
    if (width > 0) {
      settings.width = width;
      this.savedWidth = width;
    }

    postJSON(this.settingsEndpoint, {
      [this.settingsKey]: settings
    }).catch(() => {
      // a failed save isn't worth interrupting the user over — the next
      // change will retry with the same merged state
    });
  }

  protected willUpdate(changes: Map<PropertyKey, unknown>): void {
    super.willUpdate(changes);
    // seed here so setting `order` rides the same update cycle
    if (changes.has('settings') && this.settings) {
      this.savedOrder = this.settings.order || [];
      this.savedCollapsed = this.settings.collapsed || [];
      if (this.savedOrder.length > 0) {
        this.order = this.savedOrder;
      }
      this.savedWidth = this.settings.width > 0 ? this.settings.width : 0;
      if (this.savedWidth > 0) {
        this.mainWidth = this.savedWidth;
      }
      this.applyCollapsed();
    }
    if (changes.has('mainWidth')) {
      // an undersized saved width (e.g. saved on a page with a lower
      // floor) renders at this page's floor without being rewritten
      const width = this.getEffectiveMainWidth();
      if (width > 0) {
        this.style.setProperty('--main-width', `${width}px`);
      } else {
        this.style.removeProperty('--main-width');
      }
      // the flip point tracks the user width — resizing wide enough to
      // crowd out the cards flips to tabs, and back again
      this.updateModes();
    }
  }

  protected updated(changes: Map<PropertyKey, unknown>): void {
    super.updated(changes);
    if (changes.has('narrow')) {
      this.applyProjection();
    }
    if (changes.has('order')) {
      this.applyOrder();
    }
    if (this.refocusHandle) {
      this.refocusHandle = false;
      if (changes.has('narrow')) {
        (
          this.shadowRoot.querySelector('.resize-handle') as HTMLElement
        )?.focus();
      }
    }
  }

  private renderResizeHandle(edge = false): TemplateResult | null {
    if (!this.isResizable()) {
      return null;
    }
    return html`
      <div
        class=${getClasses({
          'resize-handle': true,
          edge,
          active: this.resizing
        })}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize ${this.mainName}"
        aria-valuemin=${this.mainMinWidth}
        aria-valuemax=${this.getResizeMax()}
        aria-valuenow=${this.getAnnouncedWidth()}
        tabindex="0"
        @pointerdown=${this.handleResizeStart}
        @dblclick=${this.handleResizeReset}
        @keydown=${this.handleResizeKeydown}
      >
        <div class="grip"></div>
      </div>
    `;
  }

  public render(): TemplateResult {
    if (this.narrow) {
      return html`
        ${this.renderFrame(
          html`<temba-tabs .focusedName=${this.compactTabs}>
            <temba-tab name=${this.mainName} icon=${this.mainIcon}>
              <slot name="main"></slot>
            </temba-tab>
            ${this.getCards().map(
              (card) => html`
                <temba-tab
                  name=${card.label}
                  icon=${card.icon}
                  count=${card.count}
                  ?activity=${card.activity}
                >
                  <slot name="panel-${card.id}"></slot>
                </temba-tab>
              `
            )}
          </temba-tabs>`
        )}
        ${this.renderResizeHandle(true)}
      `;
    }

    return html`
      <div class="body">
        <div class="main">
          ${this.renderFrame(html`<slot name="main"></slot>`)}
          ${this.renderResizeHandle()}
        </div>
        <div class="column">
          <temba-card-stack @temba-order-changed=${this.handleOrderChanged}>
            <slot @slotchange=${this.handleSlotChange}></slot>
          </temba-card-stack>
        </div>
      </div>
    `;
  }
}
