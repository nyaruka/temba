import { css, html, nothing, PropertyValues, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { CustomEventType } from '../interfaces';
import { getUrl } from '../utils';
import { designTokens } from '../styles/designTokens';
import { ContentMenuItem, ContentMenuItemType } from '../list/ContentMenu';

/** Request headers that ask the server for the page's content menu
 * payload (`{ items: ContentMenuItem[] }`) — the rapidpro contract
 * the standalone `temba-content-menu` also speaks. */
const MENU_HEADERS = {
  'X-Temba-Content-Menu': '1',
  'X-Temba-Spa': '1'
};

/**
 * Page header bar — a title (and optional subtitle) on the left and
 * the page's content menu (action buttons + an overflow `⋮`) on the
 * right, styled from the design tokens.
 *
 * Reusable on its own for any page that has a content menu, and
 * embedded by {@link ContentList} as the list's header so a list
 * page and a plain page share one header treatment. The menu is
 * fetched from {@link contentMenuEndpoint}; clicking an item fires
 * `temba-selection` (with the item + click origin) for the host to
 * act on, mirroring `temba-content-menu`.
 *
 * The `actions` slot renders between the title and the content menu
 * — list components slot their search / bulk-action controls there.
 */
export class PageHeader extends RapidElement {
  static get styles() {
    return css`
      ${designTokens}

      :host {
        display: block;
        font-family: var(--font);
        /* Match the styleguide's .ds Inter rendering — the stylistic
           sets (ss01/cv11) and the "tnum 0" off-switch — so glyph
           shapes line up with the design-system buttons. */
        font-feature-settings:
          'ss01',
          'cv11',
          'tnum' 0;
      }

      /* One row: the title/subtitle block on the left and the
         actions/content-menu on the right, vertically centered against
         each other. The title block is the flexing column so the
         actions hold their size. Hosts tune the vertical padding to match
         their own horizontal inset — list panels use the default, header
         bars pass down theirs — so the header always ends up with an even
         surround. The height follows from that padding plus the content; a
         host wanting a taller strip should raise the padding rather than
         impose a height, which would be absorbed into the gap around the
         title instead of growing the box. */
      .header {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: var(--gap);
        padding: var(--page-header-padding, 12px 0);
      }
      /* Title + subtitle stacked tight, sharing the left column. It
         flexes and clips so a long subtitle truncates against the
         actions rather than pushing them off the row. */
      .title-block {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      /* Sized from the shared tokens — temba-header-bar solves its inset
         against --title-line, so the two stay in step. */
      .title {
        font-size: var(--title-size);
        /* slotted contact names render at the title's size */
        --contact-name-font-size: var(--title-size);
        font-weight: var(--w-semibold);
        color: var(--text-1);
        line-height: var(--title-leading);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .subtitle {
        font-size: 12.5px;
        color: var(--text-3);
        line-height: 1.25;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .actions {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--text-2);
        font-size: 13px;
      }

      /* Content-menu action buttons — match the design system's
         .btn.btn-sm / .btn-primary / .btn-secondary so the inbox CTA
         reads identically to the styleguide. 28px tall, regular
         weight, 12.5px font, the same transitions and faint top
         highlight + ground-shadow on the primary fill. */
      .menu-button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        /* border-box so height: 28px includes the 1px border the
           same way .ds * does in the styleguide — otherwise the
           border adds 2px and the button computes 2px taller. */
        box-sizing: border-box;
        height: 26px;
        padding: 0 10px;
        border: 1px solid var(--border-strong);
        border-radius: var(--r-sm);
        font-size: 12.5px;
        font-weight: var(--w-regular);
        letter-spacing: -0.005em;
        cursor: pointer;
        user-select: none;
        background: var(--surface);
        color: var(--text-1);
        white-space: nowrap;
        transition:
          background 120ms,
          border-color 120ms,
          color 120ms,
          box-shadow 120ms;
      }
      .menu-button:hover {
        background: var(--sunken);
      }
      .menu-button.primary {
        background: var(--accent-600);
        border-color: transparent;
        color: white;
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.18),
          0 1px 1px rgba(15, 22, 36, 0.1);
      }
      .menu-button.primary:hover {
        background: var(--accent-700);
      }

      /* Overflow toggle — the trailing ⋮ that opens the rest of the
         menu items. Plain icon button, matches the list's Search. */
      .menu-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        user-select: none;
        height: 26px;
        box-sizing: border-box;
        padding: 0 5px;
        border-radius: var(--r-sm);
        color: var(--text-2);
        --icon-color: currentColor;
      }
      .menu-toggle:hover {
        background: var(--sunken);
        color: var(--text-1);
      }

      /* Overflow dropdown — a column of menu items + dividers. */
      .menu-list {
        min-width: 200px;
        padding: 6px 4px;
        font-size: 13px;
      }
      .menu-item {
        padding: 6px 12px;
        border-radius: var(--r-sm);
        cursor: pointer;
        color: var(--text-1);
        white-space: nowrap;
      }
      .menu-item:hover {
        background: var(--accent-50);
        color: var(--accent-800);
      }
      .menu-item.unavailable,
      .menu-item.unavailable:hover {
        background: none;
        color: var(--text-3);
        cursor: default;
      }
      .menu-divider {
        height: 1px;
        background: var(--border);
        margin: 6px 8px;
      }
    `;
  }

  /** Header title. A `title` slot overrides it for rich content. */
  @property({ type: String, attribute: 'header-title' })
  headerTitle = '';

  /** Smaller subtitle under the title. A `subtitle` slot overrides. */
  @property({ type: String })
  subtitle = '';

  /** GET endpoint for the page's content menu. The response shape is
   * `{ items: ContentMenuItem[] }` (rapidpro's content-menu view). */
  @property({ type: String, attribute: 'content-menu-endpoint' })
  contentMenuEndpoint = '';

  /** When true, the content menu (buttons + overflow) is not drawn —
   * the host sets this while it's in a selection / bulk-action mode
   * where the page menu isn't relevant. The menu data is kept, so
   * clearing the flag restores the menu without a re-fetch. */
  @property({ type: Boolean, attribute: 'hide-menu' })
  hideMenu = false;

  /** Buttons split out of the fetched menu (`as_button` items). */
  @state()
  private buttons: ContentMenuItem[] = [];

  /** Remaining menu items, shown under the overflow `⋮`. */
  @state()
  private items: ContentMenuItem[] = [];

  private pendingMenu: AbortController = null;

  public disconnectedCallback(): void {
    if (this.pendingMenu) {
      this.pendingMenu.abort();
    }
    super.disconnectedCallback();
  }

  protected updated(changes: PropertyValues): void {
    super.updated(changes);
    if (changes.has('contentMenuEndpoint')) {
      this.fetchContentMenu();
    }
  }

  /** Public API — re-pull the content menu (e.g. after an action
   * changes which items are available). */
  public refresh(): void {
    this.fetchContentMenu();
  }

  private async fetchContentMenu(): Promise<void> {
    if (!this.contentMenuEndpoint) {
      this.buttons = [];
      this.items = [];
      return;
    }
    if (this.pendingMenu) this.pendingMenu.abort();
    const controller = new AbortController();
    this.pendingMenu = controller;
    try {
      const response = await getUrl(
        this.contentMenuEndpoint,
        controller,
        MENU_HEADERS
      );
      // Staleness guard — if another fetch superseded this one
      // between the request firing and the response arriving, drop
      // the result so the newer fetch wins (mirrors the pattern in
      // ContactList.loadFields).
      if (this.pendingMenu !== controller) return;
      const menu = (response.json?.items as ContentMenuItem[]) || [];
      this.buttons = menu.filter((item) => item.as_button);
      this.items = menu.filter((item) => !item.as_button);
      this.fireCustomEvent(CustomEventType.Loaded, {
        buttons: this.buttons,
        items: this.items
      });
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        // eslint-disable-next-line no-console
        console.error('content menu fetch failed', err);
      }
    } finally {
      if (this.pendingMenu === controller) {
        this.pendingMenu = null;
      }
    }
  }

  /** Fire `temba-selection` with the clicked item and the click
   * origin — same payload the standalone content menu emits, so the
   * host's existing menu handling keeps working. */
  private handleItemClicked(item: ContentMenuItem, event: MouseEvent): void {
    if (item.unavailable) {
      return;
    }
    // note: item.disabled does NOT make the item inert — in the content
    // menu contract it means the opened modal starts with its submit
    // disabled (hosts pass it through to showModax)
    const el = event.currentTarget as Element;
    const rect = el?.getBoundingClientRect();
    this.fireCustomEvent(CustomEventType.Selection, {
      item,
      event,
      originX: rect ? rect.left + rect.width / 2 : event.clientX,
      originY: rect ? rect.top : event.clientY
    });
  }

  private renderContentMenu(): TemplateResult {
    if (this.hideMenu) return html``;
    return html`
      ${this.buttons.map(
        (button) => html`
          <div
            class="menu-button ${button.primary ? 'primary' : ''}"
            @click=${(e: MouseEvent) => this.handleItemClicked(button, e)}
          >
            ${button.label}
          </div>
        `
      )}
      ${this.items.length > 0
        ? html`
            <temba-dropdown>
              <div slot="toggle" class="menu-toggle">
                <temba-icon name="menu" size="1.2"></temba-icon>
              </div>
              <div slot="dropdown" class="menu-list">
                ${this.items.map((item) =>
                  item.type === ContentMenuItemType.DIVIDER
                    ? html`<div class="menu-divider"></div>`
                    : html`<div
                        class="menu-item ${item.unavailable
                          ? 'unavailable'
                          : ''}"
                        title=${item.unavailable || nothing}
                        @click=${(e: MouseEvent) =>
                          this.handleItemClicked(item, e)}
                      >
                        ${item.label}
                      </div>`
                )}
              </div>
            </temba-dropdown>
          `
        : null}
    `;
  }

  public render(): TemplateResult {
    const slotted = this.querySelector('[slot="subtitle"]');
    const hasSubtitle = this.subtitle || slotted;
    // Full subtitle text for the hover tooltip — the bar truncates a
    // long subtitle, so the native title surfaces the rest on hover.
    const subtitleText = (this.subtitle || slotted?.textContent || '').trim();
    return html`
      <div class="header">
        <div class="title-block">
          <div class="title">
            <slot name="title">${this.headerTitle}</slot>
          </div>
          ${hasSubtitle
            ? html`<div class="subtitle" title=${subtitleText}>
                <slot name="subtitle">${this.subtitle}</slot>
              </div>`
            : null}
        </div>
        <div class="actions">
          <slot name="actions"></slot>
          ${this.renderContentMenu()}
        </div>
      </div>
    `;
  }
}
