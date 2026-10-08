import { css, html, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { Icon } from '../Icons';
import { RapidElement } from '../RapidElement';
import { Card } from '../layout/Card';
import { Article, CustomEventType } from '../interfaces';
import { designTokens } from '../styles/designTokens';
import { fetchResults, getClasses, postJSON } from '../utils';

/** One card of the helpdesk: a root article standing as a section, and
 * the articles filed under it. */
export interface Section {
  section: Article;
  articles: Article[];
}

/** One entry of the ordering posted to the sort endpoint. */
export interface ArticleOrder {
  uuid: string;
  parent: string | null;
  sort_order: number;
}

/** Where a cross-card drag would land: a slot in another card, or -
 * when that card is shut and shows no slots - the card itself. */
interface DropTarget {
  section: number;
  index: number;
  into: boolean;
}

/**
 * Groups the flattened tree the endpoint serves into sections. A root
 * article is a section; everything under it - at any depth, since data
 * can predate the depth cap - files into that section's card.
 */
export function groupSections(rows: Article[]): Section[] {
  const sections: Section[] = [];
  let orphans: Article[] = [];

  for (const row of rows) {
    if (row.depth === 0) {
      sections.push({ section: row, articles: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1].articles.push(row);
    } else {
      // rows can't precede their section, but don't lose them if they do
      orphans.push(row);
    }
  }

  if (orphans.length && sections.length) {
    sections[0].articles = [...orphans, ...sections[0].articles];
    orphans = [];
  }

  return sections;
}

/**
 * Reads the sections back out as the (uuid, parent, sort_order) triples
 * the server validates: sections in card order at the root, each card's
 * articles under it. The whole forest is described, so a cross-card
 * move and the reflow it causes post as one ordering.
 */
export function toOrder(sections: Section[]): ArticleOrder[] {
  const order: ArticleOrder[] = [];

  sections.forEach((group, index) => {
    order.push({ uuid: group.section.uuid, parent: null, sort_order: index });
    group.articles.forEach((article, position) => {
      order.push({
        uuid: article.uuid,
        parent: group.section.uuid,
        sort_order: position
      });
    });
  });

  return order;
}

/**
 * Moves an article to `toIndex` within the section at `toSection`, and
 * returns the resulting sections. The index is the slot in the target
 * card with the dragged article already out of it - which is how a drop
 * position reads, since the dragged row isn't a landing place.
 */
export function moveArticle(
  sections: Section[],
  uuid: string,
  toSection: number,
  toIndex: number
): Section[] | null {
  const from = sections.findIndex((group) =>
    group.articles.some((article) => article.uuid === uuid)
  );
  if (from < 0 || toSection < 0 || toSection >= sections.length) {
    return null;
  }

  const result = sections.map((group) => ({
    ...group,
    articles: [...group.articles]
  }));

  const fromArticles = result[from].articles;
  const dragged = fromArticles.find((article) => article.uuid === uuid);
  fromArticles.splice(fromArticles.indexOf(dragged), 1);

  const toArticles = result[toSection].articles;
  toArticles.splice(Math.max(0, Math.min(toIndex, toArticles.length)), 0, {
    ...dragged,
    parent: result[toSection].section.uuid
  });

  return result;
}

/**
 * The helpdesk as sortable cards: each root article is a section
 * rendered as a card of the articles under it, the way the contact page
 * renders its detail panels. Cards drag amongst themselves by their
 * headers; articles drag by their handles - within their card or into
 * another one. Either way the whole resulting order is posted to
 * `sort-endpoint`, and the server re-derives the tree without trusting
 * the client's.
 *
 * Each card's rows are a sortable list of their own, so a picked-up row
 * is carried as a ghost and its landing slot is held open by a
 * placeholder, the same as sorting anywhere else. A drag that leaves
 * its card goes external: the ghost keeps following the pointer, and
 * this component renders the placeholder in whichever card the drop
 * would land in - or rings a shut card, which files the article at its
 * end.
 */
export class HelpdeskCards extends RapidElement {
  static get styles() {
    return css`
      ${designTokens}

      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        font-family: var(--font);
      }

      :host([fill-window]) {
        flex: 1 1 auto;
      }

      /* the host page strips its own inset (the cards sit on the page
         background), so the header and cards carry a matching one */
      temba-page-header {
        flex: 0 0 auto;
        padding: 0 12px;
      }

      /* the scrollport, and what the layout below sizes itself against -
         the page, not the window, since the menu beside it can be open or
         shut */
      .cards {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: 8px 16px 32px;
        container: helpdesk / inline-size;
      }

      /* one comfortable column on a narrow page: whatever the host puts
         above the cards, then the outline of sections */
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 16px;
        margin: 0 auto;
        max-width: 880px;
      }

      .aside {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 0;
        container: helpdesk-aside / inline-size;
      }

      /* the overview only earns its place beside the outline - stacked
         above it, it would just push the sections down */
      .overview {
        display: none;
      }

      .aside.bare {
        display: none;
      }

      /* a wide page splits in two: the outline, and a rail beside it that
         stays put while the outline scrolls */
      @container helpdesk (min-width: 1060px) {
        .layout {
          grid-template-columns: minmax(0, 1fr) 320px;
          grid-template-areas: 'main aside';
          column-gap: 32px;
          max-width: 1280px;
        }

        .main {
          grid-area: main;
        }

        .aside,
        .aside.bare {
          display: flex;
          grid-area: aside;
          align-self: start;
          position: sticky;
          top: 0;
        }

        .overview {
          display: block;
        }
      }

      .banner {
        display: block;
      }

      .main {
        min-width: 0;
      }

      /* ==========================================================
         The outline: a rail down the left joins the sections into
         the one ordered whole the help site presents, each card
         hanging off a numbered stop on it. The numbers are counters,
         so they follow a drag as the cards reflow.
         ========================================================== */

      .stack {
        display: block;
        margin: 0;
        width: 100%;
        box-sizing: border-box;
        padding-left: 44px;
        counter-reset: section;
      }

      temba-card {
        position: relative;
        counter-increment: section;
        --card-border: var(--border);
      }

      /* the stop - a numbered disc level with the card's title */
      temba-card::before {
        content: counter(section);
        position: absolute;
        left: -44px;
        top: 14px;
        z-index: 1;
        box-sizing: border-box;
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        border: 1.5px solid var(--accent-300);
        background: var(--surface);
        color: var(--accent-700);
        font-size: 12px;
        font-weight: var(--w-semibold);
        font-variant-numeric: tabular-nums;
        transition:
          background 150ms ease,
          color 150ms ease,
          border-color 150ms ease;
      }

      temba-card:hover::before {
        background: var(--accent-500);
        border-color: var(--accent-500);
        color: #fff;
      }

      /* the rail - from this stop down through the gap to the next one */
      temba-card::after {
        content: '';
        position: absolute;
        left: -31px;
        width: 2px;
        top: 42px;
        bottom: -28px;
        background: var(--accent-200);
        border-radius: 2px;
      }

      temba-card:last-of-type::after {
        display: none;
      }

      /* a card being carried is clipped to itself - no stop, no rail */
      temba-card.ghost::before,
      temba-card.ghost::after {
        display: none;
      }

      .stack > .drop-placeholder {
        border-radius: var(--r) !important;
        background: var(--accent-50) !important;
        outline-color: var(--accent-300) !important;
      }

      temba-card::part(frame) {
        border-radius: var(--r);
        box-shadow: var(--shadow-1);
        transition:
          box-shadow 150ms ease,
          border-color 150ms ease;
      }

      temba-card:hover::part(frame) {
        border-color: var(--border-strong);
        box-shadow: var(--shadow-2);
      }

      temba-card::part(header) {
        align-items: flex-start;
        padding: 14px 14px 14px 18px;
        border-radius: var(--r);
      }

      /* the stop says what the card is and the whole header picks it up,
         so the card's own grip is surplus */
      temba-card::part(grip) {
        display: none;
      }

      temba-card::part(toggle) {
        align-self: flex-start;
        margin-top: 6px;
        --icon-color: var(--text-4);
      }

      temba-card::part(content) {
        padding: 0 10px 10px;
      }

      /* the section's name leads its card: heavier and darker than the
         articles under it, so the page reads as sections first */
      temba-card::part(title) {
        color: var(--text-1);
        font-size: 15px;
        font-weight: var(--w-semibold);
        letter-spacing: -0.01em;
        line-height: 1.35;
      }

      /* an unpublished section takes its whole card with it, whatever
         its articles say for themselves: the section is the unit the
         user publishes, so it's the unit that reads as off. The controls
         stay live: this is a state, not a lock. */
      temba-card[unpublished]::part(frame),
      temba-card[unpublished] .rows {
        opacity: 0.6;
      }

      temba-card[unpublished]::part(frame) {
        border-style: dashed;
        box-shadow: none;
      }

      temba-card[unpublished]::before {
        border-style: dashed;
        border-color: var(--text-4);
        color: var(--text-3);
      }

      /* a drop landing on a shut card files into it, so the whole card
         reads as the landing place */
      temba-card[drop-into]::part(frame) {
        border-color: var(--accent-400);
        box-shadow: 0 0 0 3px var(--accent-100);
      }

      /* a section the overview just jumped to, picked out for a moment */
      temba-card.flash::part(frame) {
        border-color: var(--accent-400);
        box-shadow: 0 0 0 4px var(--accent-100);
      }

      /* what the section holds - its description, then how much is in it */
      .summary {
        margin-top: 3px;
        font-weight: normal;
      }

      .description {
        color: var(--text-2);
        font-size: 13px;
        line-height: 1.45;
        text-wrap: pretty;
        overflow-wrap: anywhere;
      }

      /* two lines while the card is shut, so a long one can't make the
         outline ragged, and all of it once the card is open */
      temba-card[collapsed] .description {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
      }

      .meta {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 6px;
        color: var(--text-3);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }

      .meta .sep {
        color: var(--text-4);
      }

      .meta .drafts {
        color: var(--warning);
      }

      /* the section's own controls, riding the card header */
      .section-actions {
        display: flex;
        align-items: center;
        gap: 2px;
        margin: 0 8px 0 12px;
        min-height: 26px;
      }

      .section-edit,
      .section-add {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 6px;
        cursor: pointer;
        --icon-color: var(--text-3);
        transition:
          background 120ms ease,
          opacity 120ms ease;
      }

      .section-edit:hover,
      .section-add:hover {
        background: var(--sunken);
        --icon-color: var(--text-1);
      }

      .section-edit:focus-visible,
      .section-add:focus-visible {
        outline: 2px solid var(--accent-400);
        outline-offset: 1px;
      }

      /* where there's a pointer to hover with, the controls wait for it
         rather than crowding every header at once */
      @media (hover: hover) {
        .section-edit,
        .section-add {
          opacity: 0;
        }

        temba-card:hover .section-edit,
        temba-card:hover .section-add,
        temba-card:focus-within .section-edit,
        temba-card:focus-within .section-add {
          opacity: 1;
        }
      }

      .section-actions temba-toggle {
        margin-left: 8px;
      }

      /* ==========================================================
         Articles - numbered within their section, the number giving
         way to a grip under the pointer
         ========================================================== */

      .rows {
        display: block;
        counter-reset: article;
      }

      /* a hairline between what names the section and the articles in
         it - not over an empty card's landing place, which is already
         its own box */
      .rows:not(.empty) {
        border-top: 1px solid var(--border);
        padding-top: 6px;
      }

      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 38px;
        padding: 0 8px 0 4px;
        border-radius: 6px;
        cursor: pointer;
        counter-increment: article;
        /* rows ghost and reflow while dragging - keep their surface
           opaque so a ghosted row reads over whatever it crosses */
        background: var(--surface);
        transition: background 100ms ease;
      }

      .row:hover {
        background: var(--sunken);
      }

      .row .title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13.5px;
        color: var(--text-1);
      }

      .row:hover .title {
        color: var(--accent-700);
      }

      /* a draft article recedes the way an unpublished section does -
         but not on top of it, or rows in a dimmed card would fade twice */
      .row.draft .title,
      .row.draft .position {
        opacity: 0.55;
      }

      temba-card[unpublished] .row.draft .title,
      temba-card[unpublished] .row.draft .position {
        opacity: 1;
      }

      /* where the article sits in its section - and, sortable, where it's
         picked up from */
      .position {
        position: relative;
        flex: 0 0 auto;
        width: 34px;
        height: 26px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 5px;
        color: var(--text-4);
        font-size: 11.5px;
        font-weight: var(--w-medium);
        font-variant-numeric: tabular-nums;
      }

      .position::before {
        content: counter(section) '.' counter(article);
      }

      .position temba-icon {
        position: absolute;
        opacity: 0;
        --icon-color: var(--text-3);
      }

      .drag-handle {
        cursor: grab;
      }

      .row:hover .drag-handle::before {
        opacity: 0;
      }

      .row:hover .drag-handle temba-icon {
        opacity: 1;
      }

      .drag-handle:hover {
        background: var(--border);
      }

      .pill {
        flex: 0 0 auto;
        border-radius: 999px;
        padding: 1px 8px;
        font-size: 11px;
        font-weight: var(--w-medium);
        background: var(--warning-bg);
        border: 1px solid var(--warning-border);
        color: var(--warning);
      }

      /* a control rather than text - don't let the row's cursor imply
         the toggle opens the article */
      temba-toggle {
        flex: 0 0 auto;
        cursor: default;
      }

      /* the slot a cross-card drop would land in, matching the
         placeholder the row's own list shows within a card */
      .drop-placeholder {
        background: var(--accent-50);
        border-radius: 6px;
        height: 38px;
        outline: 2px dashed var(--accent-300);
        outline-offset: -2px;
      }

      /* an empty card still needs a place for a drop to land */
      .rows.empty {
        border: 1.5px dashed var(--border-strong);
        border-radius: 6px;
      }

      .empty-note {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        min-height: 52px;
        color: var(--text-3);
        font-size: 12.5px;
      }

      .empty-add {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 10px 3px 6px;
        border-radius: 999px;
        border: 1px solid var(--accent-200);
        background: var(--accent-50);
        color: var(--accent-700);
        font-weight: var(--w-medium);
        cursor: pointer;
        --icon-color: currentColor;
      }

      .empty-add:hover {
        background: var(--accent-100);
      }

      .empty-message {
        color: var(--text-3);
        padding: 3em 2em;
        text-align: center;
        border: 1.5px dashed var(--border-strong);
        border-radius: var(--r);
      }

      /* ==========================================================
         The overview - the outline at a glance, beside it
         ========================================================== */

      .overview {
        border: 1px solid var(--border);
        border-radius: var(--r);
        background: var(--surface);
        box-shadow: var(--shadow-1);
        overflow: hidden;
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        border-bottom: 1px solid var(--border);
      }

      .stat {
        padding: 14px 16px 12px;
      }

      .stat + .stat {
        border-left: 1px solid var(--border);
      }

      .stat-value {
        color: var(--text-1);
        font-size: 22px;
        font-weight: var(--w-semibold);
        letter-spacing: -0.02em;
        line-height: 1.1;
        font-variant-numeric: tabular-nums;
      }

      .stat.drafts .stat-value.some {
        color: var(--warning);
      }

      .stat-label {
        margin-top: 2px;
        color: var(--text-3);
        font-size: 11.5px;
      }

      .overview-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px 6px;
        color: var(--text-3);
        font-size: 11px;
        font-weight: var(--w-semibold);
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .expand-all {
        border: none;
        background: none;
        padding: 2px 4px;
        border-radius: 4px;
        color: var(--accent-600);
        font: inherit;
        font-size: 12px;
        font-weight: var(--w-medium);
        letter-spacing: normal;
        text-transform: none;
        cursor: pointer;
      }

      .expand-all:hover {
        background: var(--accent-50);
      }

      .toc {
        list-style: none;
        margin: 0;
        padding: 0 8px 10px;
      }

      .toc-item {
        width: 100%;
        border: none;
        background: none;
        font: inherit;
        text-align: left;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 8px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        color: var(--text-2);
      }

      .toc-item:hover {
        background: var(--sunken);
        color: var(--text-1);
      }

      .toc-item:focus-visible {
        outline: 2px solid var(--accent-400);
        outline-offset: -2px;
      }

      .toc-num {
        flex: none;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: var(--accent-100);
        color: var(--accent-700);
        font-size: 11px;
        font-weight: var(--w-semibold);
        font-variant-numeric: tabular-nums;
      }

      .toc-item.draft .toc-num {
        background: none;
        border: 1px dashed var(--text-4);
        color: var(--text-3);
      }

      .toc-item.draft .toc-title {
        color: var(--text-3);
      }

      .toc-title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .toc-count {
        flex: none;
        color: var(--text-4);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
    `;
  }

  /** GET endpoint serving the article tree flattened into display order. */
  @property({ type: String })
  endpoint = '';

  @property({ type: String, attribute: 'list-title' })
  listTitle = '';

  @property({ type: String, attribute: 'content-menu-endpoint' })
  contentMenuEndpoint = '';

  /** Endpoint the reordered forest is posted to. Drag is only offered
   * when this is set, so a viewer without the permission simply can't
   * start one. */
  @property({ type: String, attribute: 'sort-endpoint' })
  sortEndpoint = '';

  /** Endpoint a publish switch posts `{uuid, status}` to. Like the sort
   * endpoint, the switch is only offered when this is set, so a viewer
   * without the permission simply doesn't get one. */
  @property({ type: String, attribute: 'publish-endpoint' })
  publishEndpoint = '';

  /** Endpoint new articles are created at. We don't post to it - the
   * host opens its dialog when a card asks for an article - but like the
   * others, its presence is what says the viewer may, so each card's add
   * button is only offered when it's set. */
  @property({ type: String, attribute: 'create-endpoint' })
  createEndpoint = '';

  @property({ type: String, attribute: 'empty-message' })
  emptyMessage = 'No articles';

  @state()
  private sections: Section[] = [];

  @state()
  private loaded = false;

  /** Where a row dragged out of its card would land right now. */
  @state()
  private dropTarget: DropTarget = null;

  public firstUpdated(changes: Map<PropertyKey, unknown>): void {
    super.firstUpdated(changes);
    this.fetchArticles();
  }

  public updated(changes: Map<PropertyKey, unknown>): void {
    super.updated(changes);
    if (changes.has('endpoint') && changes.get('endpoint') !== undefined) {
      this.fetchArticles();
    }
  }

  public refresh(): void {
    this.fetchArticles();
  }

  private async fetchArticles(): Promise<void> {
    if (!this.endpoint) {
      return;
    }
    const results = (await fetchResults(this.endpoint)) as Article[];
    this.sections = groupSections(results);
    this.loaded = true;
  }

  /** Posts the order as it now stands, then reconciles against the
   * server's tree either way - it's the authority on what the hierarchy
   * is, and a rejected ordering has to snap back. */
  private postOrder(): void {
    postJSON(this.sortEndpoint, toOrder(this.sections))
      .catch((error) => {
        console.warn('Failed to save article order', error);
      })
      .finally(() => this.refresh());
  }

  // ==========================================================
  // Card dragging - the outer sortable list owns the gesture,
  // we just apply the swap it reports
  // ==========================================================

  private handleCardSwap(event: CustomEvent): void {
    event.stopPropagation();

    const [from, to] = event.detail.swap;
    if (from === to || !this.sections[from] || !this.sections[to]) {
      return;
    }

    const sections = [...this.sections];
    const [moved] = sections.splice(from, 1);
    sections.splice(to, 0, moved);
    this.sections = sections;

    this.postOrder();
  }

  /** The ghost is a deep clone appended to document.body, sized to the
   * original card - so an open card drags as an open card. */
  // Ghosts are appended to our own render root rather than the body so
  // the rows inside a dragged card (and a dragged row itself) keep the
  // styling this stylesheet gives them.
  private prepareGhost = (ghost: HTMLElement) => {
    ghost.removeAttribute('id');
    ghost.style.overflow = 'hidden';
  };

  // ==========================================================
  // Article dragging - each card's rows are a sortable list of
  // their own, so within a card the list handles the whole
  // gesture and reports a swap. A drag that leaves its card goes
  // external; we track which card it's over and land the drop.
  // ==========================================================

  private handleRowSwap(sectionIndex: number, event: CustomEvent): void {
    // the outer stack listens for its own swaps on this same event
    event.stopPropagation();

    const [from, to] = event.detail.swap;
    const group = this.sections[sectionIndex];
    if (!group || from === to || !group.articles[from]) {
      return;
    }

    const articles = [...group.articles];
    const [moved] = articles.splice(from, 1);
    articles.splice(to, 0, moved);

    const sections = [...this.sections];
    sections[sectionIndex] = { ...group, articles };
    this.sections = sections;

    this.postOrder();
  }

  /** The card under the pointer, and the slot within it the drop would
   * take - held open by the placeholder the render draws from this. */
  private findDropTarget(mouseX: number, mouseY: number): DropTarget {
    // the card being dragged rides along as a ghost in this same root -
    // it isn't a place to drop
    const cards = Array.from(
      this.shadowRoot.querySelectorAll('temba-card:not(.ghost)')
    ) as any[];

    const section = cards.findIndex((card) => {
      const box = card.getBoundingClientRect();
      return (
        mouseX >= box.left &&
        mouseX <= box.right &&
        mouseY >= box.top &&
        mouseY <= box.bottom
      );
    });

    if (section < 0) {
      return null;
    }

    // a shut card doesn't show its slots - the drop files the article at
    // its end and the card as a whole reads as the landing place
    if (cards[section].collapsed) {
      return {
        section,
        index: this.sections[section]?.articles.length || 0,
        into: true
      };
    }

    // the slot above the first row whose midpoint the pointer is above
    const rows = Array.from(
      cards[section].querySelectorAll('.row')
    ) as HTMLElement[];
    let index = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const box = rows[i].getBoundingClientRect();
      if (mouseY < box.top + box.height / 2) {
        index = i;
        break;
      }
    }

    return { section, index, into: false };
  }

  private handleRowDragExternal = (event: CustomEvent): void => {
    event.stopPropagation();
    this.dropTarget = this.findDropTarget(
      event.detail.mouseX,
      event.detail.mouseY
    );
  };

  private handleRowDragInternal = (event: CustomEvent): void => {
    // back over its own card - that list's placeholder takes over
    event.stopPropagation();
    this.dropTarget = null;
  };

  private handleRowDragStop = (event: CustomEvent): void => {
    event.stopPropagation();

    const target = this.dropTarget;
    this.dropTarget = null;

    if (!event.detail.isExternal || !target) {
      return;
    }

    const moved = moveArticle(
      this.sections,
      event.detail.id,
      target.section,
      target.index
    );
    if (!moved) {
      return;
    }

    // shown straight away, then reconciled against the server's tree
    this.sections = moved;
    this.postOrder();
  };

  // ==========================================================
  // Row actions
  // ==========================================================

  private handleArticleClick(article: Article): void {
    this.fireCustomEvent(CustomEventType.RowClick, { item: article });
  }

  /** A card asked for an article. Making one is the host's dialog to
   * open, so this only says which section it goes in. */
  private handleAddArticle(section: Article): void {
    this.fireCustomEvent(CustomEventType.ArticleAddRequested, { section });
  }

  /**
   * Puts an article in or out of the agents' reach. Shown straight away
   * and then reconciled against the server's tree either way - it's the
   * authority on what the status is, and a rejected change has to snap
   * back rather than leave the row lying about it.
   */
  private handlePublishChanged(article: Article, event: Event): void {
    // the switch is a control on the row rather than part of it, so
    // using one isn't opening the article
    event.stopPropagation();

    const status = (event.target as any).checked ? 'published' : 'draft';

    this.sections = this.sections.map((group) => ({
      section:
        group.section.uuid === article.uuid
          ? { ...group.section, status }
          : group.section,
      articles: group.articles.map((item) =>
        item.uuid === article.uuid ? { ...item, status } : item
      )
    }));

    postJSON(this.publishEndpoint, { uuid: article.uuid, status })
      .catch((error) => {
        console.warn('Failed to change article status', error);
      })
      .finally(() => this.refresh());
  }

  // ==========================================================
  // Rendering
  // ==========================================================

  private renderStatus(article: Article): TemplateResult {
    // the switch says what the status is as well as changing it; without
    // the permission to publish, a pill is the only thing left that can
    // say - and only a draft is worth calling out
    if (this.publishEndpoint) {
      return html`<temba-toggle
        label="Published"
        hide_label
        ?checked=${article.status === 'published'}
        @click=${(event: MouseEvent) => event.stopPropagation()}
        @change=${(event: Event) => this.handlePublishChanged(article, event)}
      ></temba-toggle>`;
    }
    return article.status === 'draft'
      ? html`<div class="pill">Draft</div>`
      : null;
  }

  private renderRow(article: Article): TemplateResult {
    const classes = ['row'];
    if (this.sortEndpoint) classes.push('sortable');
    if (article.status === 'draft') classes.push('draft');

    // the position is drawn by a counter, so it follows the row as a drag
    // reflows its card; sortable, it doubles as the handle the row is
    // picked up by
    return html`
      <div
        class=${classes.join(' ')}
        id=${article.uuid}
        @click=${() => this.handleArticleClick(article)}
      >
        ${this.sortEndpoint
          ? html`<span
              class="position drag-handle"
              @click=${(event: MouseEvent) => event.stopPropagation()}
              ><temba-icon name=${Icon.drag} size="1"></temba-icon
            ></span>`
          : html`<span class="position"></span>`}
        <div class="title" title=${article.title || ''}>
          ${article.title || ''}
        </div>
        ${this.renderStatus(article)}
      </div>
    `;
  }

  private renderRows(group: Section, index: number): TemplateResult {
    // rows keyed by article so a mid-drag render (the cross-card
    // placeholder arriving) moves the placeholder without rebuilding the
    // rows around it - in particular the one the drag is hiding
    const rows = group.articles.map((article) => ({
      key: article.uuid,
      content: this.renderRow(article)
    }));

    const target = this.dropTarget;
    const placeholder = target && target.section === index && !target.into;
    if (placeholder) {
      rows.splice(Math.min(target.index, rows.length), 0, {
        key: 'drop-placeholder',
        content: html`<div class="drop-placeholder"></div>`
      });
    }

    return html`
      <temba-sortable-list
        class="rows ${group.articles.length ? '' : 'empty'}"
        dragHandle="drag-handle"
        .ghostContainer=${this.renderRoot}
        .overlapDrop=${true}
        .externalDrag=${true}
        .ghostExternal=${true}
        .externalDragPadding=${8}
        @temba-order-changed=${(event: CustomEvent) =>
          this.handleRowSwap(index, event)}
        @temba-drag-external=${this.handleRowDragExternal}
        @temba-drag-internal=${this.handleRowDragInternal}
        @temba-drag-stop=${this.handleRowDragStop}
      >
        ${repeat(
          rows,
          (row) => row.key,
          (row) => row.content
        )}
        ${group.articles.length || placeholder
          ? null
          : html`<div class="empty-note">
              No articles yet
              ${this.createEndpoint
                ? html`<span
                    class="empty-add"
                    role="button"
                    tabindex="0"
                    @click=${() => this.handleAddArticle(group.section)}
                    @keydown=${(event: KeyboardEvent) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        this.handleAddArticle(group.section);
                      }
                    }}
                    ><temba-icon name=${Icon.add} size="0.9"></temba-icon> Add
                    article</span
                  >`
                : null}
            </div>`}
      </temba-sortable-list>
    `;
  }

  /** Whether the section itself is unpublished. Its articles don't
   * weigh in: the section is what the user switched off, so the card
   * goes with it even while articles under it are still published. */
  private isUnpublished(group: Section): boolean {
    return group.section.status === 'draft';
  }

  private countDrafts(articles: Article[]): number {
    return articles.filter((article) => article.status === 'draft').length;
  }

  /** How much the section holds, beneath what it says about itself. */
  private renderSummary(group: Section): TemplateResult {
    const count = group.articles.length;
    const drafts = this.countDrafts(group.articles);

    return html`<div slot="description" class="summary">
      ${group.section.description
        ? html`<div class="description">${group.section.description}</div>`
        : null}
      <div class="meta">
        <span class="count"
          >${count
            ? `${count} ${count === 1 ? 'article' : 'articles'}`
            : 'No articles'}</span
        >
        ${drafts
          ? html`<span class="sep">·</span
              ><span class="drafts"
                >${drafts} ${drafts === 1 ? 'draft' : 'drafts'}</span
              >`
          : null}
        ${this.isUnpublished(group)
          ? html`<span class="sep">·</span><span>Hidden from the site</span>`
          : null}
      </div>
    </div>`;
  }

  private renderCard(group: Section, index: number): TemplateResult {
    const target = this.dropTarget;

    // collapsed is stamped once when the card is created (keyed by
    // section, so a card survives re-renders): sections open on demand
    // and stay however the user left them across refreshes
    return html`
      <temba-card
        collapsed
        class=${getClasses({ sortable: !!this.sortEndpoint })}
        id=${group.section.uuid}
        label=${group.section.title}
        ?drop-into=${target && target.section === index && target.into}
        ?unpublished=${this.isUnpublished(group)}
      >
        <div slot="header-actions" class="section-actions">
          <span
            class="section-edit"
            role="button"
            tabindex="0"
            aria-label="Edit section"
            title="Edit section"
            @click=${(event: MouseEvent) => {
              // opening the section for writing isn't collapsing its card
              event.stopPropagation();
              this.handleArticleClick(group.section);
            }}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                this.handleArticleClick(group.section);
              }
            }}
            ><temba-icon name=${Icon.edit} size="1"></temba-icon
          ></span>
          ${this.createEndpoint
            ? html`<span
                class="section-add"
                role="button"
                tabindex="0"
                aria-label="Add article"
                title="Add article"
                @click=${(event: MouseEvent) => {
                  // asking for an article isn't collapsing the card
                  event.stopPropagation();
                  this.handleAddArticle(group.section);
                }}
                @keydown=${(event: KeyboardEvent) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.handleAddArticle(group.section);
                  }
                }}
                ><temba-icon name=${Icon.add} size="1"></temba-icon
              ></span>`
            : null}
          ${this.renderStatus(group.section)}
        </div>
        ${this.renderSummary(group)} ${this.renderRows(group, index)}
      </temba-card>
    `;
  }

  // ==========================================================
  // Overview - the outline at a glance, for a page wide enough
  // to show it beside the cards
  // ==========================================================

  private getCards(): Card[] {
    return Array.from(
      this.shadowRoot.querySelectorAll('.stack > temba-card')
    ) as Card[];
  }

  /** Opens the section's card and brings it into view, picked out for a
   * moment so the eye lands on it. */
  private jumpToSection(group: Section): void {
    const card = this.getCards().find((card) => card.id === group.section.uuid);
    if (!card) {
      return;
    }
    card.setCollapsed(false);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1200);
    this.requestUpdate();
  }

  private toggleAll(): void {
    const cards = this.getCards();
    const open = cards.some((card) => card.collapsed);
    cards.forEach((card) => card.setCollapsed(!open));
    this.requestUpdate();
  }

  private renderOverview(): TemplateResult {
    if (!this.loaded || this.sections.length === 0) {
      return null;
    }

    const articles = this.sections.flatMap((group) => group.articles);
    // articles only, the same as each card counts - a hidden section is
    // called out as hidden rather than as a draft
    const drafts = this.countDrafts(articles);
    const anyCollapsed =
      this.getCards().length === 0 ||
      this.getCards().some((card) => card.collapsed);

    return html`
      <div class="overview">
        <div class="stats">
          <div class="stat">
            <div class="stat-value">${this.sections.length}</div>
            <div class="stat-label">Sections</div>
          </div>
          <div class="stat">
            <div class="stat-value">${articles.length}</div>
            <div class="stat-label">Articles</div>
          </div>
          <div class="stat drafts">
            <div class="stat-value ${drafts ? 'some' : ''}">${drafts}</div>
            <div class="stat-label">Drafts</div>
          </div>
        </div>
        <div class="overview-head">
          <span>Contents</span>
          <button class="expand-all" @click=${this.toggleAll}>
            ${anyCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        </div>
        <ol class="toc">
          ${this.sections.map(
            (group, index) =>
              html`<li>
                <button
                  class="toc-item ${this.isUnpublished(group) ? 'draft' : ''}"
                  @click=${() => this.jumpToSection(group)}
                >
                  <span class="toc-num">${index + 1}</span>
                  <span class="toc-title">${group.section.title}</span>
                  <span class="toc-count">${group.articles.length}</span>
                </button>
              </li>`
          )}
        </ol>
      </div>
    `;
  }

  public render(): TemplateResult {
    // the header decides whether to show a subtitle by looking for one in
    // its own light DOM, where our forwarding slot would always be found -
    // so only forward when the host actually gave us one
    const hasSubtitle = this.querySelector('[slot="subtitle"]');

    // anything the host wants shown alongside the cards - the site's
    // domain, say - goes above them on a narrow page and in the rail
    // beside them on a wide one
    const hasBanner = this.querySelector('[slot="banner"]');

    return html`
      <temba-page-header content-menu-endpoint=${this.contentMenuEndpoint}>
        <slot name="title" slot="title">${this.listTitle}</slot>
        ${hasSubtitle
          ? html`<slot name="subtitle" slot="subtitle"></slot>`
          : null}
      </temba-page-header>
      <div class="cards">
        <div class="layout">
          <div class="aside ${hasBanner ? '' : 'bare'}">
            ${hasBanner
              ? html`<div class="banner"><slot name="banner"></slot></div>`
              : null}
            ${this.renderOverview()}
          </div>
          <div class="main">
            ${this.loaded && this.sections.length === 0
              ? html`<div class="empty-message">${this.emptyMessage}</div>`
              : html`
                  <temba-sortable-list
                    class="stack"
                    gap="14px"
                    dragHandle="card-header"
                    .ghostContainer=${this.renderRoot}
                    .overlapDrop=${true}
                    .prepareGhost=${this.prepareGhost}
                    @temba-order-changed=${this.handleCardSwap}
                    @toggle=${() => this.requestUpdate()}
                  >
                    ${repeat(
                      this.sections,
                      (group) => group.section.uuid,
                      (group, index) => this.renderCard(group, index)
                    )}
                  </temba-sortable-list>
                `}
          </div>
        </div>
      </div>
    `;
  }
}
