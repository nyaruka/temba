import { css, html, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { Icon } from '../Icons';
import { RapidElement } from '../RapidElement';
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

      .cards {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        /* room for card shadows, and a bottom inset so the last row of
           cards doesn't rest on the edge of the scrollport */
        padding: 4px 12px 12px;
      }

      /* one card per section, stacked in a single comfortable column */
      .stack {
        display: block;
        margin: 0 auto;
        max-width: 800px;
        width: 100%;
      }

      /* whatever the host puts above the cards sits in the same column, and scrolls away with them */
      .banner {
        display: block;
        margin: 0 auto 12px;
        max-width: 800px;
        width: 100%;
      }

      .rows {
        display: block;
      }

      /* an unpublished section takes its whole card with it, whatever
         its articles say for themselves: the section is the unit the
         user publishes, so it's the unit that reads as off. The controls
         stay live: this is a state, not a lock. */
      temba-card[unpublished] {
        opacity: 0.55;
      }

      /* a drop landing on a shut card files into it, so the whole card
         reads as the landing place */
      temba-card[drop-into] {
        outline: 2px solid var(--accent-400);
        outline-offset: 1px;
        border-radius: var(--r-sm);
      }

      /* the slot a cross-card drop would land in, matching the
         placeholder the row's own list shows within a card */
      .drop-placeholder {
        background: #f3f4f6;
        border-radius: var(--r-sm);
        height: 34px;
        outline: 2px dashed #d1d5db;
        outline-offset: -2px;
      }

      .row {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 34px;
        padding: 0 2px;
        border-radius: var(--r-sm);
        cursor: pointer;
        /* rows ghost and reflow while dragging - keep their surface
           opaque so a ghosted row reads over whatever it crosses */
        background: var(--surface);
      }

      .row:hover {
        background: var(--sunken);
      }

      /* a draft article recedes the way an unpublished section does -
         but not on top of it, or rows in a dimmed card would fade twice */
      .row.draft {
        opacity: 0.55;
      }

      temba-card[unpublished] .row.draft {
        opacity: 1;
      }

      .row .title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        color: var(--text-1);
      }

      /* faint at rest so the rows don't read as busy, and solid under
         the pointer that's about to use it */
      .drag-handle {
        --icon-color: var(--text-3);
        cursor: grab;
        flex: 0 0 auto;
        opacity: 0.35;
      }

      .row:hover .drag-handle {
        opacity: 1;
      }

      /* a little more room between a handle and the title it moves than
         the row's own gap or the card's default gives - for the rows and
         for the sections alike, set so the two titles still line up */
      .drag-handle {
        margin-right: 4px;
      }

      /* a section is picked up by its folder - which says what the card is
         as well as where to grab it, so it's drawn a step darker than a
         plain grip would be */
      temba-card::part(grip) {
        margin-right: 12px;
        --icon-color: var(--text-3);
      }

      .pill {
        flex: 0 0 auto;
        border-radius: 999px;
        padding: 1px 8px;
        font-size: 11px;
        font-weight: var(--w-medium);
        background: var(--sunken);
        color: var(--text-3);
      }

      /* a control rather than text - don't let the row's cursor imply
         the toggle opens the article */
      temba-toggle {
        flex: 0 0 auto;
        cursor: default;
      }

      /* the section's own controls, riding the card header */
      .section-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-right: 0.5em;
      }

      .section-edit,
      .section-add {
        display: inline-flex;
        border-radius: var(--r-sm);
        padding: 2px;
        --icon-color: var(--text-3);
      }

      .section-edit:hover,
      .section-add:hover {
        background: var(--sunken);
        --icon-color: var(--text-1);
      }

      /* the section's name leads its card: heavier and darker than the
         articles under it, so the page reads as sections first */
      temba-card::part(title) {
        color: var(--text-1);
        font-size: 14px;
        font-weight: var(--w-bold);
        letter-spacing: -0.005em;
      }

      /* what the section holds, in the section's own words - a subtitle
         under its name in the card's header, so it's there to read
         whether or not the card is open. Two lines while the card is
         shut, so a long one can't make the stack ragged, and all of it
         once the card is open. */
      .description {
        margin-top: 2px;
        color: var(--text-3);
        font-size: 12.5px;
        font-weight: normal;
        line-height: 1.45;
        text-wrap: pretty;
        overflow-wrap: anywhere;
      }

      temba-card[collapsed] .description {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
      }

      /* a two line header wants a touch more room than the card gives
         a single line */
      temba-card.described::part(title) {
        padding-top: 2px;
      }

      temba-card.described .description {
        padding-bottom: 2px;
      }

      /* a hairline between what names the section and the articles in
         it - not over an empty card's dashed landing place, which is
         already its own box */
      .rows:not(.empty) {
        border-top: 1px solid var(--border);
        margin-top: 2px;
        padding-top: 6px;
      }

      /* an empty card still needs a place for a drop to land */
      .rows.empty {
        border: 1px dashed var(--border);
        border-radius: var(--r-sm);
      }

      .empty-note {
        color: var(--text-3);
        font-size: 12px;
        min-height: 34px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .empty-message {
        color: var(--text-3);
        padding: 2em;
        text-align: center;
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

    return html`
      <div
        class=${classes.join(' ')}
        id=${article.uuid}
        @click=${() => this.handleArticleClick(article)}
      >
        ${this.sortEndpoint
          ? html`<temba-icon
              class="drag-handle"
              name=${Icon.drag}
              size="1"
              @click=${(event: MouseEvent) => event.stopPropagation()}
            ></temba-icon>`
          : null}
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
          : html`<div class="empty-note">No articles</div>`}
      </temba-sortable-list>
    `;
  }

  /** Whether the section itself is unpublished. Its articles don't
   * weigh in: the section is what the user switched off, so the card
   * goes with it even while articles under it are still published. */
  private isUnpublished(group: Section): boolean {
    return group.section.status === 'draft';
  }

  private renderCard(group: Section, index: number): TemplateResult {
    const target = this.dropTarget;

    // collapsed is stamped once when the card is created (keyed by
    // section, so a card survives re-renders): sections open on demand
    // and stay however the user left them across refreshes
    return html`
      <temba-card
        collapsed
        grip-icon=${Icon.section}
        class=${getClasses({
          sortable: !!this.sortEndpoint,
          described: !!group.section.description
        })}
        id=${group.section.uuid}
        label=${group.section.title}
        count=${group.articles.length}
        ?drop-into=${target && target.section === index && target.into}
        ?unpublished=${this.isUnpublished(group)}
      >
        <div slot="header-actions" class="section-actions">
          <span
            class="section-edit"
            role="button"
            tabindex="0"
            aria-label="Edit section"
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
        ${group.section.description
          ? html`<div slot="description" class="description">
              ${group.section.description}
            </div>`
          : null}
        ${this.renderRows(group, index)}
      </temba-card>
    `;
  }

  public render(): TemplateResult {
    // the header decides whether to show a subtitle by looking for one in
    // its own light DOM, where our forwarding slot would always be found -
    // so only forward when the host actually gave us one
    const hasSubtitle = this.querySelector('[slot="subtitle"]');

    // anything the host wants shown above the cards - the site's domain, say - goes at the top of the column
    const hasBanner = this.querySelector('[slot="banner"]');

    return html`
      <temba-page-header content-menu-endpoint=${this.contentMenuEndpoint}>
        <slot name="title" slot="title">${this.listTitle}</slot>
        ${hasSubtitle
          ? html`<slot name="subtitle" slot="subtitle"></slot>`
          : null}
      </temba-page-header>
      <div class="cards">
        ${hasBanner
          ? html`<div class="banner"><slot name="banner"></slot></div>`
          : null}
        ${this.loaded && this.sections.length === 0
          ? html`<div class="empty-message">${this.emptyMessage}</div>`
          : html`
              <temba-sortable-list
                class="stack"
                gap="12px"
                dragHandle="card-header"
                .ghostContainer=${this.renderRoot}
                .overlapDrop=${true}
                .prepareGhost=${this.prepareGhost}
                @temba-order-changed=${this.handleCardSwap}
              >
                ${repeat(
                  this.sections,
                  (group) => group.section.uuid,
                  (group, index) => this.renderCard(group, index)
                )}
              </temba-sortable-list>
            `}
      </div>
    `;
  }
}
