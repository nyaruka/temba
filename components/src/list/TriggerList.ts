import { css, html, PropertyValues, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { state } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { ContentList, ContentListColumn } from './ContentList';
import { Icon } from '../Icons';
import { CustomEventType, Trigger } from '../interfaces';

/** Placeholder shown in any cell whose value is empty. */
const EMPTY = '--';

/** Most pills a cell renders before folding the remainder into a
 * "+N" summary — past this, shrinking pills to fit degrades them to
 * bare icons that identify nothing. This is the upper bound; a cell
 * that can't fit even this many folds further after measurement
 * (see {@link TriggerList.measurePillFit}). */
const MAX_PILLS = 3;

/** Name length past which a filter pill is marked `wide` — the pill
 * that gives up space (down to a floor) when the row is squeezed,
 * so its short-named siblings keep their full text. */
const WIDE_PILL_CHARS = 11;

/** Keyword length past which a keyword pill is marked `wide`. Lower
 * than the filter-pill threshold to match the keyword pills' compact
 * monospace sizing and their smaller shrink floor. */
const WIDE_KEYWORD_CHARS = 5;

/** Quiet period after the last resize before pill budgets recompute.
 * Resize events arrive in bursts while dragging — refolding on each
 * one flashes the pills, so wait for the size to settle. */
const PILL_SYNC_DEBOUNCE = 200;

/** A resolved filter pill (channel / contact / group / excluded
 * group) ready to render — see {@link TriggerList.renderFilters}. */
interface FilterPill {
  type: string;
  name: string;
  href: string;
  icon?: string;
  exclude?: boolean;
}

/** Human name for each trigger type slug — mirrors the type names in
 * rapidpro's `triggers/types.py`. Rendered in the trigger cell only
 * for types whose leading icon doesn't say it all (no per-type
 * details of their own). Resolved per call rather than held in a
 * module-level map so the names reflect the locale, which is only
 * known once the store has loaded. */
const TYPE_NAMES = (): { [slug: string]: string } => ({
  keyword: msg('Keyword'),
  catch_all: msg('Catch All'),
  schedule: msg('Schedule'),
  inbound_call: msg('Inbound Call'),
  missed_call: msg('Missed Call'),
  new_conversation: msg('New Conversation'),
  referral: msg('Referral'),
  closed_ticket: msg('Closed Ticket'),
  opt_in: msg('Opt-In'),
  opt_out: msg('Opt-Out')
});

/**
 * Trigger CRUDL list — drop-in replacement for the rapidpro
 * `triggers/trigger_list.html` table. Columns: the trigger itself
 * (a leading type icon plus the per-type details — keyword pills,
 * schedule, referrer — or the type name when there are none), the
 * filters that scope it (channel first, then contact / group pills,
 * excluded groups tinted red), the flow it starts, and created on.
 * Triggers open in an update modal rather than a page of their own,
 * so rows carry no href — the host listens for `temba-row-click`
 * and opens the modal itself.
 */
export class TriggerList extends ContentList<Trigger> {
  static get styles() {
    return css`
      ${ContentList.styles}
      /* Rows are clickable (the host opens the update modal on
         temba-row-click) but carry no href, so ContentList doesn't
         mark them .clickable — carry the affordance ourselves. */
      tr.row {
        cursor: pointer;
      }
      .type-name {
        color: inherit;
        font-weight: var(--w-medium);
        white-space: nowrap;
      }
      /* Trigger cell — muted lead-in text ("starts with", "from")
         ahead of the per-type specifics, with pills sitting inline. */
      .details {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        max-width: 100%;
      }
      /* The lead word never shrinks; the detail text after it ("each
         week on Monday…", the referrer) ellipsizes when the cell runs
         out of room — flex items ignore the cell wrapper's
         text-overflow, so they carry their own. */
      .details .type-name {
        flex: 0 0 auto;
      }
      .details .lead-in,
      .details .detail-text {
        white-space: nowrap;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .details .lead-in {
        color: var(--text-3);
      }
      /* A pill row that outgrows its cell shrinks its pills rather
         than clipping at the cell edge: max-width pins the inline-flex
         container to the cell (it would otherwise size to its content
         and hard-clip under .cell-inner's overflow). Which pills give
         up the space is deliberate — see .wide below. */
      .pills {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        max-width: 100%;
        /* Anything past the box (only possible in the frame or two
           before measurePillFit folds the budget down) clips inside
           the pill row rather than painting into the next column. */
        overflow: hidden;
      }
      /* Short-named pills never squeeze — with the +N cap bounding
         the row, they always fit, so they keep their full text. */
      .pills temba-label {
        flex-shrink: 0;
      }
      /* A long-named pill is the one that gives up space, down to a
         floor that keeps its name identifiable — temba-label's
         internal slot ellipsis handles the truncation. */
      .pills temba-label.wide {
        flex-shrink: 1;
        min-width: 7em;
      }
      /* Keyword pills follow the same rule — short ones never shrink
         (so a pill can never collapse to bare chrome), long ones give
         up space — but with a smaller floor matched to their compact
         monospace sizing, so the floor never stretches a pill beyond
         its natural width. */
      .details .pills temba-label.wide {
        min-width: 4em;
      }
      /* Exclusion pills — group pills derive their palette from
         --recipient (see pillVariants.ts), so re-anchoring it to the
         danger hue retints an excluded group red while keeping the
         pill chrome identical to its included siblings. */
      .pills temba-label.exclude {
        --recipient: var(--danger);
      }
      /* The "+N" summary pill never shrinks — it's the affordance
         that says more exist, so it must stay legible while its
         siblings ellipsize. */
      .pills temba-label.overflow {
        flex: 0 0 auto;
      }
    `;
  }

  protected defaultEmptyMessage(): string {
    return msg('No triggers');
  }

  protected defaultSearchPlaceholder(): string {
    return msg('Search triggers');
  }

  constructor() {
    super();
    this.bulkActions = [
      { key: 'archive', label: 'Archive', icon: Icon.archive }
    ];
  }

  protected buildColumns(): ContentListColumn[] {
    return [
      { key: 'trigger', label: msg('Trigger'), grow: true, minWidth: '260px' },
      {
        key: 'filters',
        label: msg('Filters'),
        minWidth: '120px',
        maxWidth: '360px'
      },
      {
        key: 'flow',
        label: msg('Flow'),
        minWidth: '110px',
        maxWidth: '240px'
      },
      {
        key: 'created_on',
        label: msg('Created on'),
        sortable: true,
        minWidth: '96px',
        maxWidth: '150px',
        align: 'right'
      }
    ];
  }

  /** Per-cell visible-pill budget, keyed `${rowId}:${cellKey}`. A
   * cell starts at {@link MAX_PILLS}; after each render the cell is
   * measured and its budget walked down until the pills (plus the
   * "+N" summary) actually fit — so a narrow column folds pills into
   * the summary instead of clipping them at the cell edge. Reset on
   * resize so widening the window restores pills. */
  @state()
  private pillBudgets: Map<string, number> = new Map();

  /** Pending rAF handle for the deferred pill-fit measure (0 when
   * none is scheduled). */
  private pillMeasureFrame = 0;

  /** Watches the host's width so budgets recompute only when the
   * geometry can actually change — never on scroll-driven re-renders,
   * which would force layout reads for nothing. The host's width is
   * page-layout-driven (folding pills can't change it), so observing
   * it can't oscillate with the folding itself. */
  private hostResizeObserver: ResizeObserver;

  private lastHostWidth = -1;

  /** Pending debounce timer for the post-resize budget recompute (0
   * when none is scheduled). */
  private pillSyncTimeout = 0;

  /** Each pill cell's width as of its last budget computation, keyed
   * like {@link pillBudgets}. A host resize only resets the cells
   * whose width actually moved — when the table is already at its
   * column minimums (scrolling horizontally), a window resize changes
   * the host but not the cells, and nothing re-folds or flashes. */
  private pillCellWidths: Map<string, number> = new Map();

  public connectedCallback(): void {
    super.connectedCallback();
    this.hostResizeObserver = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1].contentRect.width;
      // ignore height-only changes and sub-pixel noise
      if (Math.abs(width - this.lastHostWidth) <= 1) return;
      this.lastHostWidth = width;
      // debounce the recompute to the end of the resize burst — while
      // the drag is in flight, overflowing pills crop cleanly inside
      // their row (.pills is overflow: hidden) and refold just once
      window.clearTimeout(this.pillSyncTimeout);
      this.pillSyncTimeout = window.setTimeout(() => {
        this.pillSyncTimeout = 0;
        this.syncPillCellWidths();
      }, PILL_SYNC_DEBOUNCE);
    });
    this.hostResizeObserver.observe(this);
    // Late web-font loads change pill text widths.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => this.schedulePillMeasure());
    }
  }

  /** After the host's width changes, find the pill cells whose own
   * width actually changed with it: reset those budgets to the full
   * cap (the measure walks them back down to what now fits) and
   * leave every other cell untouched. */
  private syncPillCellWidths(): void {
    const containers = this.shadowRoot.querySelectorAll('.pills[data-fit]');
    let resetBudgets: Map<string, number> = null;
    let needMeasure = false;
    containers.forEach((el: Element) => {
      const key = (el as HTMLElement).dataset.fit;
      const cell = el.closest('td');
      if (!cell) return;
      const width = cell.clientWidth;
      const last = this.pillCellWidths.get(key);
      if (last != null && Math.abs(width - last) <= 1) return;
      this.pillCellWidths.set(key, width);
      needMeasure = true;
      if (this.pillBudgets.has(key)) {
        resetBudgets = resetBudgets || new Map(this.pillBudgets);
        resetBudgets.delete(key);
      }
    });
    if (resetBudgets) {
      this.pillBudgets = resetBudgets;
      this.updateComplete.then(() => this.schedulePillMeasure());
    } else if (needMeasure) {
      this.schedulePillMeasure();
    }
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this.hostResizeObserver.disconnect();
    window.clearTimeout(this.pillSyncTimeout);
    this.pillSyncTimeout = 0;
    if (this.pillMeasureFrame) {
      cancelAnimationFrame(this.pillMeasureFrame);
      this.pillMeasureFrame = 0;
    }
  }

  protected updated(changes: PropertyValues): void {
    super.updated(changes);
    // Only a new set of rows warrants a fresh measure — re-renders
    // from scroll state (header shadows etc.) don't move any pills.
    if (changes.has('items')) {
      this.schedulePillMeasure();
    }
  }

  private schedulePillMeasure(): void {
    if (this.pillMeasureFrame) return;
    this.pillMeasureFrame = requestAnimationFrame(() => {
      this.pillMeasureFrame = 0;
      this.measurePillFit();
    });
  }

  /** Walk each pill row's budget down one pill per pass while its
   * content overflows its box. Shrinking a budget re-renders (the
   * hidden pill moves into the "+N" summary), which schedules the
   * next measure — so a cell converges to the largest count that
   * fits within a few frames. Budgets floor at zero: a cell too
   * narrow for even one pill shows just the "+N" summary, whose
   * tooltip still names everything. */
  private measurePillFit(): void {
    const containers = this.shadowRoot.querySelectorAll('.pills[data-fit]');
    let next: Map<string, number> = null;
    containers.forEach((el: Element) => {
      const key = (el as HTMLElement).dataset.fit;
      const budget = this.pillBudgets.get(key) ?? MAX_PILLS;
      // record the cell width this budget was computed at, so a later
      // resize can tell which cells actually moved
      const cell = el.closest('td');
      if (cell) {
        this.pillCellWidths.set(key, cell.clientWidth);
      }
      // +1 tolerance for fractional layout rounding
      if (budget > 0 && el.scrollWidth > el.clientWidth + 1) {
        next = next || new Map(this.pillBudgets);
        next.set(key, budget - 1);
      }
    });
    if (next) {
      this.pillBudgets = next;
      // keep converging after the fold re-renders — updated() no
      // longer measures on every pass, so chain explicitly
      this.updateComplete.then(() => this.schedulePillMeasure());
    }
  }

  /** The visible-pill budget for a cell — MAX_PILLS until
   * measurement has folded it down. */
  private pillBudget(item: Trigger, cellKey: string): number {
    return this.pillBudgets.get(`${this.rowId(item)}:${cellKey}`) ?? MAX_PILLS;
  }

  protected getRowIcon(item: Trigger): string | null {
    return (Icon as any)[`trigger_${item?.type}`] || Icon.trigger;
  }

  /** Navigate a pill click through the SPA, suppressing the row's
   * own click (which opens the update modal). Shared by the flow,
   * channel, group, and contact pills. */
  private handlePillClick(href: string, event: MouseEvent): void {
    // Stop the click from bubbling to the row's modal handler.
    event.stopPropagation();
    // Guard the JSON-driven href against open-redirect, same as the
    // row-click path in ContentList.handleRowClick.
    if (!href || !this.isSafeHref(href)) return;
    // Meta/ctrl-click opens a new tab, matching ordinary links and
    // the row-click behavior.
    if (event.metaKey || event.ctrlKey) {
      window.open(href, '_blank');
      return;
    }
    this.fireCustomEvent(CustomEventType.Redirected, { url: href });
  }

  protected renderCell(
    item: Trigger,
    column: ContentListColumn
  ): TemplateResult | string {
    switch (column.key) {
      case 'trigger':
        return this.renderTrigger(item);
      case 'filters':
        return this.renderFilters(item);
      case 'flow':
        return this.renderFlow(item);
      case 'created_on':
        return item.created_on
          ? html`<temba-date
              value=${item.created_on}
              display="timedate"
            ></temba-date>`
          : EMPTY;
      default:
        return super.renderCell(item, column);
    }
  }

  /** Overflow summary pill — "+N" for the pills past the visible
   * cap, with the hidden names in its tooltip. Not clickable itself,
   * so a click on it falls through to the row (the update modal),
   * where the full set is editable. */
  private renderOverflowPill(hiddenNames: string[]): TemplateResult | null {
    if (!hiddenNames.length) return null;
    return html`<temba-label
      class="overflow"
      type="neutral"
      title=${hiddenNames.join(', ')}
      >+${hiddenNames.length}</temba-label
    >`;
  }

  /** The trigger cell: every row leads with a word at the type-name
   * weight — "Message" for keywords, "Scheduled" for schedules,
   * "Referral" for referrals, or the type name itself for types with
   * no details — followed by the muted per-type specifics. */
  private renderTrigger(item: Trigger): TemplateResult | string {
    switch (item.type) {
      case 'keyword': {
        const keywords = item.keywords || [];
        if (!keywords.length) break;
        const budget = this.pillBudget(item, 'keywords');
        const visible = keywords.slice(0, budget);
        return html`<span class="details">
          <span class="type-name">${msg('Message')}</span>
          <span class="lead-in"
            >${item.match_type === 'O'
              ? msg('matches')
              : msg('starts with')}</span
          >
          <span class="pills" data-fit="${this.rowId(item)}:keywords">
            ${visible.map(
              (k) =>
                html`<temba-label
                  type="keyword"
                  class=${k.length > WIDE_KEYWORD_CHARS ? 'wide' : ''}
                  >${k}</temba-label
                >`
            )}
            ${this.renderOverflowPill(keywords.slice(budget))}
          </span>
        </span>`;
      }
      case 'schedule':
        // a paused or exhausted schedule has no next fire — matching
        // the legacy list's "is not scheduled" copy
        return item.schedule?.next_fire && item.schedule?.display
          ? html`<span class="details">
              <span class="type-name">${msg('Scheduled')}</span>
              <span class="lead-in">${item.schedule.display}</span>
            </span>`
          : html`<span class="type-name">${msg('Not scheduled')}</span>`;
      case 'referral':
        if (!item.referrer_id) break;
        return html`<span class="details">
          <span class="type-name">${msg('Referral')}</span>
          <span class="lead-in">${msg('from')}</span>
          <span class="detail-text">${item.referrer_id}</span>
        </span>`;
    }
    return html`<span class="type-name"
      >${TYPE_NAMES()[item.type] || item.type || EMPTY}</span
    >`;
  }

  /** The filter pills scoping the trigger: the channel first (there
   * is only ever one), then the contacts a scheduled trigger starts,
   * the groups it's limited to, and — tinted red — the groups it
   * excludes. At most the cell's measured budget (≤ {@link MAX_PILLS})
   * renders; the rest fold into a "+N" summary pill so a crowded row
   * never squeezes its pills down to bare icons or clips them. */
  private renderFilters(item: Trigger): TemplateResult | string {
    const channel = item.channel;
    const filters: FilterPill[] = [];
    if (channel) {
      filters.push({
        type: 'channel',
        icon: channel.icon || Icon.channel,
        name: channel.name,
        href: `/channels/channel/read/${channel.uuid}/`
      });
    }
    for (const c of item.contacts || []) {
      filters.push({
        type: 'contact',
        name: c.name,
        href: `/contact/read/${c.uuid}/`
      });
    }
    for (const g of item.groups || []) {
      filters.push({
        type: 'group',
        icon: Icon.group_include,
        name: g.name,
        href: `/contact/group/${g.uuid}/`
      });
    }
    for (const g of item.exclude_groups || []) {
      filters.push({
        type: 'group',
        icon: Icon.group_exclude,
        name: g.name,
        href: `/contact/group/${g.uuid}/`,
        exclude: true
      });
    }
    if (!filters.length) {
      return EMPTY;
    }

    const budget = this.pillBudget(item, 'filters');
    const visible = filters.slice(0, budget);
    // excluded names keep their meaning in the summary tooltip
    const hidden = filters
      .slice(budget)
      .map((f) => (f.exclude ? `not ${f.name}` : f.name));

    return html`<span class="pills" data-fit="${this.rowId(item)}:filters">
      ${visible.map(
        (f) =>
          html`<temba-label
            class="${f.exclude ? 'exclude' : ''} ${f.name.length >
            WIDE_PILL_CHARS
              ? 'wide'
              : ''}"
            type=${f.type}
            icon=${ifDefined(f.icon)}
            clickable
            @click=${(e: MouseEvent) => this.handlePillClick(f.href, e)}
            >${f.name}</temba-label
          >`
      )}
      ${this.renderOverflowPill(hidden)}
    </span>`;
  }

  private renderFlow(item: Trigger): TemplateResult | string {
    const flow = item.flow;
    if (!flow?.uuid) return EMPTY;
    return html`<temba-label
      type="flow"
      primary
      clickable
      @click=${(e: MouseEvent) =>
        this.handlePillClick(`/flow/editor/${flow.uuid}/`, e)}
      >${flow.name}</temba-label
    >`;
  }
}
