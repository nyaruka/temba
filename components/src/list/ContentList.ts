import { css, html, PropertyValues, TemplateResult } from 'lit';
import { LOCALE_STATUS_EVENT, msg, str } from '@lit/localize';
import { property, state } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { Icon } from '../Icons';
import { CustomEventType, ObjectReference } from '../interfaces';
import { formatCount, getUrl, postJSON, postUrl } from '../utils';
import { designTokens } from '../styles/designTokens';
import { openLinkInSheet } from '../layout/sheets';
import {
  buttonChrome,
  buttonChromeCompact,
  buttonChromeActive,
  buttonChromeHover
} from '../styles/buttonChrome';

/** A single column in the list. Subclasses typically define a static
 * set via {@link ContentList.columns}; consumers may also set it as
 * an attribute / property for ad-hoc lists. */
export interface ContentListColumn {
  key: string;
  label?: string;
  sortable?: boolean;
  align?: 'left' | 'right' | 'center';
  /** Fixed column width (e.g. "150px"). Pins the column to an exact
   * size regardless of content. Most columns instead leave this
   * unset and size to their content within {@link minWidth} /
   * {@link maxWidth} bounds. */
  width?: string;
  /** Optional lower bound for a content-sized column (one with no
   * `width`). When unset the column floors at its own content —
   * typically the width of the header label. */
  minWidth?: string;
  /** Upper bound for a content-sized column (one with no `width`).
   * Defaults to "320px" — the column grows to fit its widest value
   * up to this cap, then ellipsis-truncates. */
  maxWidth?: string;
  /** Greedily absorb the leftover table width — the column's cell
   * stretches to fill the slack between the fixed/content-sized
   * columns, so it always reaches the card edge. At most one column
   * should set this; it stands in for the slack {@link spacer}, so
   * the spacer is skipped when a grow column is present. A `grow`
   * column ignores `maxWidth` but still honours `minWidth` as a
   * floor for when the table overflows. */
  grow?: boolean;
  /** Text shown in a tip when the header's label is hovered, for
   * something about the column its label alone doesn't say, e.g. the
   * period it counts over. */
  tip?: string;
  /** Pin the column so it stays visible while the table scrolls
   * horizontally. `true` / `'left'` freezes it against the left
   * edge; `'right'` freezes it against the right edge. Left-pinned
   * columns must be contiguous from the first column; right-pinned
   * columns contiguous to the last. */
  pinned?: boolean | 'left' | 'right';
  /** Whether the column can be resized from its trailing edge. Resizing is
   * opt-in so list types can expose it only where the interaction is useful. */
  resizable?: boolean;
  /** Whether the column can be reordered by dragging its header.
   * Reorderable columns must form one contiguous run — drags are
   * constrained to slots inside that run so the system columns on
   * either side stay put. Takes effect once two or more columns opt
   * in (there's nothing to reorder against otherwise). The table does
   * not scroll while a drag is in flight, so dragging beyond the
   * visible frame isn't supported — drops clamp to the headers on
   * screen. */
  reorderable?: boolean;
  /** Optional resize-only floor. Unlike minWidth, this does not affect the
   * table's native layout before the user resizes the column. */
  resizeMinWidth?: string;
}

/** A bulk action surfaced in the toolbar when one or more rows are
 * selected. When {@link ContentList.actionEndpoint} is set the
 * component POSTs the action there directly and re-fetches the
 * current page so the user stays put — the `temba-bulk-action`
 * event then fires after the round-trip for consumers that need to
 * react (refresh a sidebar count, etc.). When `actionEndpoint` is
 * empty the component just fires the event and leaves the POST to
 * the host. The label-toggle action is a special case — when
 * `labelsEndpoint` is set, the component renders a dropdown of
 * label checkboxes and POSTs the apply/remove directly to
 * `actionEndpoint`, mirroring rapidpro's
 * `runActionOnObjectRows('label', …)` flow. */
export interface ContentListBulkAction {
  key: string;
  label: string;
  icon?: string;
  destructive?: boolean;
  /** When set, the component shows window.confirm(message) before
   * applying the action — used for destructive operations whose
   * wording is localized server-side. */
  confirm?: string;
  /** GET endpoint returning `{ results: [{ uuid, name, count? }] }`.
   * Setting this turns the action into a label-toggle dropdown
   * instead of a fire-and-forget bulk-action event. */
  labelsEndpoint?: string;
  /** The item field holding each row's current memberships (`[{uuid}]`)
   * used to pre-check / partially-check the dropdown against the
   * selected rows. Defaults to `labels` (messages); the contact list
   * sets it to `groups`. */
  labelsKey?: string;
  /** When true (and `labelsEndpoint` is set), the dropdown gets a
   * trailing "New Label…" row that fires `temba-label-create` with
   * the selected ids — the host opens its create modal seeded with
   * them. Sent by the server only when the viewer holds the create
   * permission. */
  allowCreate?: boolean;
  /** When true, the component does not POST the action to
   * `actionEndpoint` — it only fires the `temba-bulk-action` event
   * with the selected ids and leaves the work to the host. Used for
   * actions that open a modal (e.g. send / start-flow) rather than
   * mutating rows server-side. */
  clientOnly?: boolean;
}

interface FetchResponse<T = any> {
  results: T[];
  count?: number;
  next?: string;
  previous?: string;
  /** How the endpoint paginates — `cursor` or `page`. The internal API
   * always says; it's the only thing that distinguishes the two when
   * the results fit on one page. See {@link detectCursorMode}. */
  paged_by?: string;
  /** Server-adjusted/normalized form of the search that produced these
   * results (rapidpro's contact search echoes the parsed `query`).
   * When present after a search, it's adopted as the basis of the
   * results and mirrored back into the search input. */
  query?: string;
  /** A query-validation error message (e.g. an unparseable search like
   * `age >`). The server still returns a list-shaped, empty response;
   * this message is surfaced over the empty table instead of the plain
   * "nothing to show" copy. */
  error?: string;
}

/**
 * Generic JSON-driven list for CRUDL-style pages. Renders search +
 * sortable column headers + multi-select rows + bulk-action toolbar
 * + paged pagination, fully styled from the TextIt design tokens.
 *
 * Subclasses set `columns` / `bulkActions` / `valueKey` and override
 * {@link renderCell} for non-trivial cells (pills, attachments,
 * progress bars, etc.). The base class handles selection, sorting,
 * search debouncing, pagination, URL state, and fetch lifecycle.
 *
 * No polling — list refresh is explicit (`refresh()` method or
 * `refresh-key` attribute change). CRUDL pages should not auto-poll.
 */
export class ContentList<T = any> extends RapidElement {
  static get styles() {
    return css`
      ${designTokens}

      :host {
        /* Flex column so the panel fills the host's height — when
           the host is given a bounded height (see fillWindow) the
           table scrolls internally instead of growing the page. */
        display: flex;
        flex-direction: column;
        min-height: 0;
        font-family: var(--font);
        color: var(--text-1);
        font-size: 13.5px;
        /* Fixed-width slot for a column's sort arrow. It is reserved
           on the inboard side of the label so the arrow never shifts
           the label, and the label stays flush with the column's
           values. */
        --sort-gutter: 16px;
        /* Selected-row wash — accent-50 on its own reads grey, so a
           touch of the accent-400 rail colour is mixed in to give
           the selection a faint accent tint. Statics pre-mixed from
           the default accent for browsers without color-mix(); the
           @supports block below re-derives them from the tokens. */
        --cl-selected: #e5ecf8;
        /* The dividers bracketing a selected row — the plain grey
           --border reads as a seam against the wash, so this is the
           same accent pushed a little further. */
        --cl-selected-border: #cbdaf1;
        /* Tint shared by the frozen (pinned) columns and the header
           row, so the header reads as the same quiet sub-panel as the
           pinned section. */
        --cl-pin-bg: #fafbfc;
      }
      @supports (color: color-mix(in srgb, red, red)) {
        :host {
          --cl-selected: color-mix(
            in oklab,
            var(--accent-400) 9%,
            var(--accent-50)
          );
          --cl-selected-border: color-mix(
            in oklab,
            var(--accent-400) 24%,
            var(--accent-50)
          );
          --cl-pin-bg: color-mix(in oklab, var(--sunken) 35%, var(--surface));
        }
      }
      /* fillWindow — take the slack of a height-bounded flex-column
         parent so the table scrolls internally; min-height: 0 (set
         above) lets the host shrink enough for that scroll. */
      :host([fill-window]) {
        flex: 1 1 auto;
      }

      /* The header — title + content menu — is temba-page-header.
         The list slots its search / bulk-action controls into that
         header's actions area through this row. When rows are
         selected the search is replaced inline by bulk-action chips
         so the toolbar stays in the same spot visually. */
      .header-actions {
        display: flex;
        align-items: center;
        gap: 14px;
        color: var(--text-2);
        font-size: 13px;
      }

      /* Built-in action button (Search). Bordered text + icon on a
         transparent ground; host's slotted buttons can match this
         style or bring their own. */
      .action {
        ${buttonChrome}
        ${buttonChromeCompact}
      }
      .action:hover {
        ${buttonChromeHover}
      }
      .action:active {
        ${buttonChromeActive}
      }
      .action temba-icon {
        --icon-color: currentColor;
      }

      /* When rows are selected, the bulk actions overlay the column-
         header row (covering the column labels) starting just right of
         the select-all checkbox — rather than replacing the page header.
         Positioned in the table-frame (not the scrolling table) so it
         stays put horizontally, with an opaque header-tint background to
         hide the labels underneath, above every header layer — pinned
         header cells reach z 5 (see tr.header th.pinned), so the bar
         sits at 6 to cover them too. */
      .bulk-bar {
        position: absolute;
        top: 0;
        /* The first chip's left edge sits at the row's leading content
           (--cl-firstcol-left) — the icon on icon lists, the text on
           text lists — so the bulk bar starts at the same point as the
           row content on every list, matching the message list. */
        left: var(--cl-firstcol-left, 44px);
        right: var(--cl-scrollbar-w, 0px);
        height: var(--cl-header-height, 36px);
        z-index: 6;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 0 8px 0 0;
        background: var(--cl-pin-bg);
        /* keep the header's bottom rule visible — the bar sits on top of
           it, so carry the same inset border the header th uses */
        box-shadow: inset 0 -1px 0 0 var(--border);
      }
      .bulk-action {
        display: inline-flex;
        align-items: center;
        /* Compact chips — the bar is an overlay centered in the table's
           header row, so the chips size to themselves (they no longer
           need to match the page-header button height). Kept small and
           lightly padded so a full set fits the header strip. */
        height: 22px;
        box-sizing: border-box;
        padding: 0 6px;
        border-radius: var(--r-sm);
        background: var(--accent-100);
        color: var(--accent-800);
        font-size: 12px;
        cursor: pointer;
        user-select: none;
        /* labels never wrap; when the bar runs out of room they collapse
           to icon-only (see .bulk-bar.collapsed .bulk-label) */
        white-space: nowrap;
      }
      /* The label sits a gap to the right of the icon. Both the width and
         that gap collapse to 0 when the bar is too narrow, animating the
         chips down to icon-only — the same max-width trick the tabs use. */
      .bulk-label {
        display: inline-block;
        overflow: hidden;
        white-space: nowrap;
        max-width: 160px;
        margin-left: 4px;
        transition:
          max-width 220ms ease,
          margin-left 220ms ease;
      }
      .bulk-bar.collapsed .bulk-label {
        max-width: 0;
        margin-left: 0;
      }
      /* While measuring the expanded width, suppress the label animation
         so scrollWidth reflects the final (not mid-transition) size. */
      .bulk-bar.measuring .bulk-label {
        transition: none;
      }
      .bulk-action:hover {
        background: var(--accent-200);
      }
      .bulk-action.destructive {
        background: var(--danger-bg);
        color: var(--danger);
      }
      .bulk-action.destructive:hover {
        /* pre-mixed fallback for browsers without color-mix() */
        background: #f6d9d9;
      }

      @supports (color: color-mix(in srgb, red, red)) {
        .bulk-action.destructive:hover {
          background: color-mix(in oklab, var(--danger) 20%, white);
        }
      }
      .bulk-action temba-icon {
        --icon-color: currentColor;
      }
      /* Quiet, muted selection tally — right-aligned (margin-left: auto)
         so the action chips stay fixed against the checkbox regardless
         of the count's width. */
      .bulk-count {
        color: var(--text-3);
        font-size: 12.5px;
        margin-left: auto;
        padding-left: 12px;
        /* keep the tally on one line — it must never wrap even when the
           bar is tight (the chips collapse to make room instead) */
        white-space: nowrap;
        flex-shrink: 0;
      }

      /* Label-toggle dropdown — temba-dropdown wraps the bulk-
         action button, and the slotted content is a list of
         per-label checkbox rows. The menu padding/width matches
         the rapidpro pattern in short_pagination.html. */
      .label-menu {
        min-width: 220px;
        max-height: 320px;
        overflow-y: auto;
        padding: 8px 4px;
        font-size: 13px;
      }
      .label-menu-empty {
        padding: 12px 16px;
        color: var(--text-3);
        font-size: 12.5px;
      }
      /* "New Label…" creation row — separated from the toggle rows
         above it (mirrors the legacy dropdown's add-label row). */
      .lbl-create {
        border-top: 1px solid var(--border-1);
        margin-top: 4px;
        padding: 10px 12px 6px;
        cursor: pointer;
        color: var(--text-2);
        border-radius: var(--r-sm);
      }
      .lbl-create:hover {
        background: var(--accent-50);
        color: var(--text-1);
      }
      /* Blocked while a label-toggle POST is in flight, matching the
         treatment of the label rows above. */
      .lbl-create.blocked,
      .lbl-create.blocked:hover {
        cursor: not-allowed;
        background: transparent;
        color: var(--text-3);
      }
      .lbl-create:first-child {
        border-top: none;
        margin-top: 0;
        padding-top: 6px;
      }
      .lbl-menu {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: var(--r-sm);
        cursor: pointer;
        color: var(--text-1);
      }
      .lbl-menu:hover {
        background: var(--accent-50);
      }
      .lbl-menu.pending {
        background: var(--accent-50);
      }
      /* During an in-flight toggle, the other rows are blocked.
         Keep them readable (no opacity dim) but disable hover and
         cursor so the user can't fire conflicting POSTs. */
      .lbl-menu.blocked,
      .lbl-menu.blocked:hover {
        cursor: not-allowed;
        background: transparent;
        color: var(--text-3);
      }
      .lbl-menu .lbl-name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Inline search bar — slides below the title row inside the
         panel when the search trigger is active. Bare single-line
         input, no border, --sunken background. */
      .searchbar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        /* Pull up under the header — the header carries its own bottom
           padding, so without this the searchbar sits a full gap below
           the title row. The negative top margin tightens that gap. */
        margin: -6px 0 12px 0;
        background: var(--sunken);
        border-radius: var(--r-sm);
        color: var(--text-3);
      }
      .searchbar input {
        flex: 1 1 auto;
        border: 0;
        background: transparent;
        outline: 0;
        font: inherit;
        color: var(--text-1);
        min-width: 0;
      }
      .searchbar input::placeholder {
        color: var(--text-3);
      }
      /* Trailing controls — a run-search icon and a close (✕), both
         always present while the bar is open so the bar's height stays
         put. The close is the way out (the header's Search button hides
         itself while the bar is open). The "↵ to search" hint sits just
         left of the run icon and fades in only when there's a pending
         draft to apply — the same trigger that lights the icon. */
      .searchbar .search-hint {
        flex: 0 0 auto;
        font-size: 0.75em;
        color: var(--text-3);
        white-space: nowrap;
        user-select: none;
      }
      .searchbar .search-hint .enter-key {
        position: relative;
        top: 2px;
      }
      /* Both are our standard clickable icons — bare glyph at rest, a
         circular wash only on hover. The left margin opens a bit of
         breathing room between the icons (and the hint). The default
         hover wash is near-white, which washes out against the sunken
         (grey) box, so each carries a more saturated one. */
      .searchbar .search-go,
      .searchbar .search-cancel {
        flex: 0 0 auto;
        margin-left: 5px;
        --icon-color: var(--text-3);
        --icon-color-circle-hover: rgba(15, 22, 36, 0.1);
      }
      /* Run search only renders once a draft is pending (alongside the
         "↵ to search" hint), so it's always the primary action — its
         hover wash warms to accent. */
      .searchbar .search-go {
        --icon-color-circle-hover: var(--accent-200);
      }

      /* Card panel — surface white wrapping the header and table.
         Soft shadow + radius gives it the contained-card feel from
         the styleguide. The 20px horizontal padding insets the
         header and table from the card edges. A flex column so the
         header stays put and the table region takes the slack —
         when the host is height-bounded the table scrolls inside it
         rather than growing the page. */
      .panel {
        background: var(--surface);
        border-radius: var(--r);
        overflow: hidden;
        box-shadow: var(--shadow-1);
        padding: 0 20px;
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      /* A window-filling list isn't a floating card — it fills its
         container flush, so it drops the card radius + shadow that
         would otherwise reveal the page background at its corners. The
         panel keeps a horizontal inset (so the header and search bar
         stay padded, not full-bleed) but tightens it to 12px — the
         check-cell's lead padding — so the title text lines up with the
         row checkboxes below it. */
      :host([fill-window]) .panel {
        border-radius: 0;
        box-shadow: none;
        padding: 0 12px;
      }
      /* The rule and the table go full-bleed — escape the panel's 12px
         inset on both sides so the rows use the full width of the
         parent while the header/search bar above them stay padded. */
      :host([fill-window]) .header-rule,
      :host([fill-window]) .table-frame {
        margin: 0 -12px;
      }
      /* The header holds its size; the table frame takes the slack. */
      temba-page-header,
      .header-rule,
      .searchbar {
        flex: 0 0 auto;
      }

      /* Full-bleed rule between the titlebar/searchbar and the
         table. Negative horizontal margin escapes the panel's 20px
         padding so the line reaches the card chrome on both sides
         — the table itself (rows, lines, hover wash) stays inset. */
      .header-rule {
        height: 1px;
        background: var(--border);
        margin: 0 -20px;
      }

      /* Scroll frame — flexes to fill the panel's slack and is the
         positioning context for the right-edge scroll shadow. The
         negative margin escapes the panel's 20px panel padding so
         both the vertical scrollbar AND the right-pinned column ride
         the component's edge — .table-scroll deliberately carries no
         padding because position: sticky resolves offsets against
         the scroller's padding-box, and any padding here would leave
         a transparent gap where overflowing content shows through
         behind the pinned cell. The lead/trail inset comes from the
         first/last cell padding instead. The inner .table-scroll
         scrolls the table both ways (vertically within this frame,
         horizontally for overflow) so the header row and data rows
         scroll together as one table. */
      .table-frame {
        position: relative;
        flex: 1 1 auto;
        min-height: 0;
        /* Extend only the right side past the panel's 20px padding
           so the vertical scrollbar (and any right-pinned column)
           rides the card chrome instead of stranding whitespace
           between the bar and the panel edge. The left side stays
           within the panel padding so row dividers don't bleed full-
           width. */
        margin-right: -20px;
        /* Keep the table's internal layering (sticky header, pinned
           columns and their hover/shadow layers, z-index 1-6) inside
           its own stacking context so those values can only order
           against each other and never interleave with page-level
           layers like floating windows or open dropdowns. Without it
           the frame is z-index auto, so the table's 1-6 would join the
           nearest ancestor stacking context — normally the root — and
           tie against page chrome using comparably small values. Note
           this also caps this list's own label dropdown, which renders
           inside the frame and so cannot escape it. */
        isolation: isolate;
      }
      .table-scroll {
        overflow: auto;
        height: 100%;
      }
      /* With no rows to show (empty / loading / search-error state) the
         body is just the centered state message, so a wide column set
         shouldn't arm a horizontal scrollbar under it. */
      .table-scroll.no-rows {
        overflow-x: hidden;
      }

      /* auto layout lets the contact-field columns size to the
         content shown in them; system columns are instead held to a
         fixed size by their .cell-inner width. width: 100% makes the
         table fill the card, then overflow once the fixed widths
         outgrow it — which is what arms the horizontal scroll. */
      table.table {
        width: 100%;
        border-collapse: collapse;
        table-layout: auto;
      }
      /* A fixed-layout list sizes every column up front, so the
         table is exactly its container width and never arms a
         horizontal scroll — overflowing cells truncate instead. The
         leading cells need an explicit width here, since the auto-
         layout shrink trick (width 1%) collapses them to nothing
         under fixed layout. */
      table.table.fixed {
        table-layout: fixed;
      }
      /* Just wide enough for the checkbox glyph (~15px); the cell's
         lead inset and trailing padding supply the breathing room
         on either side. Anything wider strands the checkbox in dead
         space ahead of column one. */
      table.table.fixed th.check-cell {
        width: 16px;
      }

      /* The header row sticks to the top of the scroll frame so the
         column labels stay put while the rows scroll under them.
         z-index 2 lifts it above the body; a pinned header cell needs
         more to also clear the body's pinned column (z-index 1) and the
         resize-handle layers (z 4) — but must stay under the bulk-action
         bar (z 6), which overlays the whole header row on selection. */
      tr.header th {
        height: 36px;
        vertical-align: middle;
        text-align: left;
        color: var(--text-3);
        font-size: 11px;
        font-weight: var(--w-medium);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        white-space: nowrap;
        background: var(--cl-pin-bg);
        /* The header's bottom border is an inset shadow, not a real
           border: the header is position: sticky and border-collapse
           drops a sticky cell's actual border, so a real border would
           scroll away as rows pass under it. The shadow stays put, so
           the header always keeps a bottom rule to scroll under. */
        box-shadow: inset 0 -1px 0 0 var(--border);
        position: sticky;
        top: 0;
        z-index: 2;
      }
      tr.header th.pinned {
        z-index: 5;
      }

      tr.row td {
        height: 38px;
        vertical-align: middle;
        color: var(--text-1);
        border-bottom: 1px solid var(--border);
      }
      tr.row:hover {
        background: var(--accent-50);
      }
      /* Selection — a light accent wash (--cl-selected) carrying a
         hint of the accent-400 rail colour so it reads clearly as
         accent rather than grey. The accent-400 leading rail (below)
         still sets a selected row apart from a hovered one. */
      tr.row.selected {
        background: var(--cl-selected);
      }
      /* Recolour the dividers that bracket a selected row — its own
         bottom border and the bottom border of the row above it —
         so the grey row seam doesn't cut across the accent wash.
         Between two adjacent selected rows both rules agree. */
      tr.row.selected td,
      tr.row:has(+ tr.row.selected) td {
        border-bottom-color: var(--cl-selected-border);
      }
      /* Grey pills (label / neutral / keyword variants) border off
         --pill-border; setting it on a selected row's cells retints
         those borders to the same colour as the row dividers. The
         custom property inherits into the pill's shadow DOM, where
         --border itself is re-declared and so can't be overridden. */
      tr.row.selected td {
        --pill-border: var(--cl-selected-border);
      }
      /* Solid accent-400 rail down the row's leading edge — the
         design system's "active rail" selection affordance. Drawn
         as a ::before on the first cell so it never competes with
         the pinned cells' own box-shadow divider; bottom: -1px
         bridges the row border so a run of selected rows reads as
         one continuous rail. */
      tr.row.selected td:first-child::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: -1px;
        width: 3px;
        background: var(--accent-400);
      }
      /* A pinned first cell is position: sticky and already a
         containing block for the rail; an unpinned one needs an
         explicit positioning context. */
      tr.row td:first-child:not(.pinned) {
        position: relative;
      }
      tr.row.clickable {
        cursor: pointer;
      }

      .head-cell,
      .cell {
        padding: 0 8px;
      }

      /* The inner wrapper carries each column's width contract: a
         fixed width for system columns, a max-width cap for the
         content-fit field columns. overflow/ellipsis keeps a long
         value from blowing the column out. */
      .cell-inner {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* Right-aligned values sit flush against the column edge; the
         header label matches because its sort slot is inboard (left
         of the label), not between the label and the edge. */
      .cell.right .cell-inner {
        margin-left: auto;
        text-align: right;
      }
      .cell.center .cell-inner {
        margin-left: auto;
        margin-right: auto;
        text-align: center;
      }
      /* No gap between label and sort slot — the slot's fixed width
         is the whole gutter, which keeps the header-to-content
         alignment math down to a single value. */
      .head-inner {
        display: flex;
        align-items: center;
        gap: 0;
        overflow: hidden;
      }
      /* The label never shrinks — its full width becomes the
         column's minimum, so a header is never truncated and a
         content-sized column is always at least as wide as its
         name. */
      .head-inner .label {
        flex: 0 0 auto;
        white-space: nowrap;
      }
      /* a label with a tip is the tip, which hugs it like the plain label,
         dotted underneath to say there's more to it */
      .head-inner temba-tip.label {
        display: inline-block;
        cursor: help;
        text-decoration: underline dotted;
        text-decoration-color: var(--text-3, currentColor);
        text-underline-offset: 3px;
      }
      .head-cell.right .head-inner {
        margin-left: auto;
        justify-content: flex-end;
      }
      .head-cell.center .head-inner {
        margin-left: auto;
        margin-right: auto;
        justify-content: center;
      }

      /* Column resize affordance. The hit target straddles the column
         boundary from the leading edge of the following header, which
         keeps both halves clickable above that cell's stacking context.
         Its rule remains visible so column boundaries are
         discoverable without hovering; interaction strengthens it.
         A real element (rather than a pseudo-element) gives keyboard and
         screen-reader users the same control. */
      .resize-handle {
        position: absolute;
        top: 0;
        left: -5px;
        bottom: 0;
        z-index: 4;
        width: 10px;
        cursor: col-resize;
        touch-action: none;
        outline: none;
      }
      .resize-handle::after {
        content: '';
        position: absolute;
        top: 7px;
        left: 50%;
        bottom: 7px;
        width: 1px;
        border-radius: 1px;
        background: var(--border);
        transform: translateX(-50%);
        transition:
          width 0.12s ease,
          background 0.12s ease;
      }
      :host(:not([column-resizing])) .resize-handle:hover::after,
      :host(:not([column-resizing])) .resize-handle:focus-visible::after,
      .resize-handle.resizing::after {
        width: 3px;
        background: var(--border-strong);
      }
      /* A header hosting the preceding column's handle must paint above
         its neighbour so the target stays centered across the boundary. */
      tr.header th:has(> .resize-handle.leading) {
        z-index: 4;
      }
      /* Keep the final column's target inside the table so it doesn't
         create a few pixels of horizontal overflow. Its rule stays in
         the target's center, just inboard of the table edge. */
      .resize-handle.trailing {
        left: auto;
        right: -5px;
      }
      .resize-handle.trailing.outer {
        right: 0;
      }
      :host([column-resizing]),
      :host([column-resizing]) * {
        cursor: col-resize !important;
      }

      /* Column reorder. A reorderable header is a drag surface: past a
         small pointer threshold the label lifts into a floating ghost,
         the origin column dims, and an accent insertion bar tracks the
         drop slot. touch-action: none lets the same drag work on touch
         — the 36px sticky header row is a negligible scroll-start
         surface, so claiming its gestures (including the vertical
         swipe that would otherwise scroll the list) costs little. */
      .head-cell.reorderable {
        touch-action: none;
      }
      /* Advertise the drag while idle. The th prefix out-specifies
         .head-cell.sortable's pointer cursor, which is declared later
         in this sheet and would otherwise win on a sortable column. */
      th.head-cell.reorderable {
        cursor: grab;
      }
      .head-cell.dragging {
        opacity: 0.35;
      }
      /* The insertion bar sits flush inside the boundary it marks
         rather than straddling it — an overhanging bar would be painted
         over by the neighbouring header cell, which is opaque and wins
         the stacking order. The header cell is the positioning context
         (it's position: sticky). */
      .head-cell.drop-before::before,
      .head-cell.drop-after::after {
        content: '';
        position: absolute;
        top: 4px;
        bottom: 4px;
        width: 3px;
        border-radius: 2px;
        background: var(--accent-400);
        z-index: 5;
      }
      .head-cell.drop-before::before {
        left: 0;
      }
      .head-cell.drop-after::after {
        right: 0;
      }
      :host([column-dragging]),
      :host([column-dragging]) * {
        cursor: grabbing !important;
      }

      /* Pinned columns stay fixed against their edge while the rest
         of the table scrolls under them. The frozen-region look —
         the tint and the divider — only kicks in once the table
         actually overflows (.overflowing); until then a pinned
         column is indistinguishable from a plain one. */
      th.pinned,
      td.pinned {
        position: sticky;
        z-index: 1;
      }
      /* A faint tint sets the frozen region apart as its own sub-
         panel — and, being opaque, stops scrolled content bleeding
         through. The header/row selectors out-specify the plain
         cell backgrounds so the tint actually lands. */
      .table-frame.overflowing tr.header th.pinned,
      .table-frame.overflowing tr.row td.pinned {
        background: var(--cl-pin-bg);
      }
      /* The hover/selected wash still wins over the tint so a
         hovered/selected row reads as one continuous strip. */
      .table-frame.overflowing tr.row:hover td.pinned {
        background: var(--accent-50);
      }
      .table-frame.overflowing tr.row.selected td.pinned {
        background: var(--cl-selected);
      }
      /* Body cells retain a subtle vertical rule where the pinned section
         ends. Header boundaries are already represented by resize
         separators, so they only keep the standard bottom rule. */
      .table-frame.overflowing td.pin-last {
        box-shadow: inset -1px 0 0 0 var(--border);
      }
      /* Mirror of the rule for the right-pinned group — the divider
         sits on the inboard (left) edge of its first cell. */
      .table-frame.overflowing td.pin-first {
        box-shadow: inset 1px 0 0 0 var(--border);
      }
      /* Once scrolled, the frozen edge casts the same soft scroll
         shadow as the sticky header — a gradient (matching th::after
         and .scroll-shadow) drawn just outside the pinned edge, over
         the content sliding under it. It's a ::before so it composes
         with the header's own ::after scroll shadow on a pinned header
         cell. */
      .table-frame th.pin-last::before,
      .table-frame td.pin-last::before {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: 100%;
        width: 8px;
        pointer-events: none;
        background: linear-gradient(
          to right,
          rgba(15, 23, 42, 0.12),
          rgba(15, 23, 42, 0)
        );
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      .table-frame.scrolled th.pin-last::before,
      .table-frame.scrolled td.pin-last::before {
        opacity: 1;
      }
      .table-frame th.pin-first::before,
      .table-frame td.pin-first::before {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        right: 100%;
        width: 8px;
        pointer-events: none;
        background: linear-gradient(
          to left,
          rgba(15, 23, 42, 0.12),
          rgba(15, 23, 42, 0)
        );
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      .table-frame.can-scroll-right th.pin-first::before,
      .table-frame.can-scroll-right td.pin-first::before {
        opacity: 1;
      }

      /* Slack-absorbing column between the pinned and scrolling
         sections — width: 100% makes it greedily take all leftover
         table width, so extra space pools here as a gap instead of
         stretching the real columns. It collapses to nothing once
         the columns outgrow the viewport and the table scrolls. */
      .spacer {
        width: 100%;
        padding: 0;
      }

      /* A 'grow' column does the spacer's job inline — width: 100%
         makes its cell pool the leftover table width so the column
         stretches to the card edge. It collapses back toward its
         content (held at minWidth) once the table overflows. */
      th.grow,
      td.grow {
        width: 100%;
      }
      /* Under auto layout a grow column also claims zero intrinsic
         width (max-width: 0) so its content can't widen the table:
         the other columns size to their content first, the grow column
         takes only the leftover, and a long value ellipsis-truncates
         against it (via .cell-inner's overflow). This gives a long
         free-text column — e.g. the message list's body — truncation
         without forcing the whole table to table-layout: fixed (which
         would make every column a declared width). Fixed-layout lists
         keep the spacer-style width:100% behaviour, so this is scoped
         to the auto path. */
      table.table:not(.fixed) td.grow {
        max-width: 0;
        overflow: hidden;
      }

      /* Right-edge horizontal scroll cue — fades in while there is more
         table to the right. It sits inboard of the right-pinned group
         (--cl-rpin-total, 0 when nothing is right-pinned) and the
         vertical scrollbar (--cl-scrollbar-w) so it fades the scrolling
         content rather than the frozen columns or the scrollbar track,
         and is sized to the rows' height (--cl-rows-height) so it stops
         at the bottom of the table instead of running down the empty
         space below a short list. Its width and intensity match the
         sticky header's scroll shadow (.header-shadow) so the two read
         as the same affordance on different axes; pointer-events: none
         keeps it from eating row clicks. */
      .scroll-shadow {
        position: absolute;
        top: 0;
        height: var(--cl-rows-height, 100%);
        right: calc(var(--cl-rpin-total, 0px) + var(--cl-scrollbar-w, 0px));
        width: 8px;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s ease;
        background: linear-gradient(
          to right,
          rgba(15, 23, 42, 0),
          rgba(15, 23, 42, 0.12)
        );
      }
      .table-frame.can-scroll-right .scroll-shadow {
        opacity: 1;
      }

      /* Soft drop shadow under the sticky header once the body scrolls
         beneath it — the horizontal counterpart of the .scroll-shadow.
         A single full-width element (rather than a per-cell shadow) so
         it reads as one consistent shadow left-to-right and never
         doubles up where a pinned header cell overlaps a scrolling one.
         Sits just below the header (--cl-header-height) and stops short
         of the vertical scrollbar (--cl-scrollbar-w). */
      .header-shadow {
        position: absolute;
        top: var(--cl-header-height, 36px);
        left: 0;
        right: var(--cl-scrollbar-w, 0px);
        height: 8px;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s ease;
        background: linear-gradient(
          to bottom,
          rgba(15, 23, 42, 0.12),
          rgba(15, 23, 42, 0)
        );
      }
      .table-frame.scrolled-down .header-shadow {
        opacity: 1;
      }

      /* Checkbox column — shrink-to-fit (width: 1% is the table-
         cell trick for that). The cell-level @click owns selection;
         the inner checkbox is display-only (pointer-events: none)
         so it can't double-fire on the same click. temba-checkbox
         sizes its icon in em, so .check-inner pins the font-size to
         keep header + row checkboxes the same visual scale. */
      .check-cell {
        width: 1%;
        white-space: nowrap;
        /* 12px lead from the card edge to the checkbox, then a tight 4px
           trail to the row's leading content — so every list (icon or
           text) starts its content at the same point past the checkbox. */
        padding: 0 4px 0 12px;
        cursor: pointer;
        --icon-color: var(--text-3);
      }
      .check-inner {
        display: flex;
        align-items: center;
        font-size: 13.5px;
      }
      .check-cell temba-checkbox {
        pointer-events: none;
      }
      tr.row.selected .check-cell {
        --icon-color: var(--accent-700);
      }

      .head-cell.sortable {
        cursor: pointer;
        user-select: none;
      }
      .head-cell.sortable:hover {
        color: var(--text-2);
      }
      /* The sort arrow trails the label in a fixed-width slot. The
         slot is reserved whenever a column is sortable or right-
         aligned, so the label never shifts when the arrow appears
         and the gutter math holds. The arrow itself is invisible
         until the column is the active sort — or, for an inactive
         sortable column, while its header is hovered. */
      .sort-slot {
        flex: 0 0 var(--sort-gutter);
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .sort-icon {
        --icon-color: var(--text-3);
        opacity: 0;
        transition: opacity 0.12s ease;
      }
      .head-cell.sortable:hover .sort-icon {
        opacity: 0.55;
      }
      .head-cell.sortable.active .sort-icon {
        --icon-color: var(--accent-700);
        opacity: 1;
      }
      .head-cell.sortable.active {
        color: var(--accent-700);
      }

      /* Leading entity-type icon — a small icon flagging a row (contact
         silhouette, voice/background flow, etc.). It rides inside the
         first column's cell rather than in its own column, so the column
         header aligns with the row's leading content. Subclasses
         override {@link getRowIcon}; a row whose icon is null renders
         its value flush at the column edge with no reserved gutter. */
      .lead-wrap {
        display: flex;
        align-items: center;
        min-width: 0;
      }
      .lead-wrap .cell-inner {
        min-width: 0;
      }
      /* The icon's 1em footprint plus a snug 5px gap to the value.
         The fixed box keeps the column's intrinsic width stable while
         <temba-icon> upgrades — without it the column briefly measures
         narrow and downstream pinned columns jump, which races with
         whatever moment we snapshot. Rows without an icon don't render
         this box at all — their value sits flush at the column edge. */
      .lead-icon {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1em;
        height: 1em;
        margin-right: 5px;
        --icon-color: var(--text-3);
      }
      tr.row.selected .lead-icon {
        --icon-color: var(--accent-700);
      }

      /* The first column follows the checkbox directly and drops its
         left padding, so its content starts right at the checkbox
         cell's 4px trailing gap: the leading icon on icon lists, the
         value otherwise — and the header label lines up at that same
         point. The table-frame sits inside the panel's 20px padding, so
         that edge already aligns with the page-header content; the last
         cell trims its padding-right (below) so content doesn't crowd
         the card chrome. */
      .check-cell + .head-cell,
      .check-cell + .cell {
        padding-left: 0;
      }
      tr.header th:last-child,
      tr.row td:last-child {
        padding-right: 20px;
      }

      /* Empty / loading / searching message — rendered after the table
         (not as a colspan row inside it) and positioned over the body
         area so it stays centered in the visible container rather than
         the full, possibly-overflowing table width. Sits below the
         header (--cl-header-height) and inboard of the vertical
         scrollbar (--cl-scrollbar-w). */
      .list-state {
        position: absolute;
        top: var(--cl-header-height, 36px);
        left: 0;
        right: var(--cl-scrollbar-w, 0px);
        bottom: 0;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 40px;
        color: var(--text-3);
        pointer-events: none;
      }
      /* Query-validation error — the same centered empty-table slot,
         but a danger-tinted pill (icon + message) so a bad search reads
         as something to fix rather than an empty result set. */
      .list-state.error {
        color: var(--danger);
      }
      .list-state .state-error {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        max-width: min(560px, 80%);
        padding: 8px 14px;
        border: 1px solid var(--danger-border);
        border-radius: var(--r);
        background: var(--danger-bg);
        --icon-color: var(--danger);
      }

      /* Pager — a compact stepper that lives in the header's actions
         cluster: chevron-only paging buttons bracketing a plain count,
         no borders or labels, matching the quiet Search action it sits
         beside. */
      .pager {
        display: flex;
        align-items: center;
        gap: 2px;
      }
      .pager-status {
        padding: 0 4px;
        color: var(--text-3);
        font-size: 12.5px;
        white-space: nowrap;
      }

      .page-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: var(--r-sm);
        color: var(--text-3);
        cursor: pointer;
        user-select: none;
      }
      .page-btn:hover {
        background: var(--sunken);
        color: var(--text-1);
      }
      .page-btn[disabled],
      .page-btn[disabled]:hover {
        opacity: 0.35;
        cursor: not-allowed;
        background: transparent;
        color: var(--text-3);
      }
      .page-btn temba-icon {
        --icon-color: currentColor;
      }

      /* Status pill: small rounded chip with a leading colored
         dot. Subclasses use {@link renderStatusPill} to surface
         per-row state (active/pending/stopped/archived/etc.). */
      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px 2px 8px;
        border-radius: 999px;
        font-size: 11.5px;
        font-weight: var(--w-medium);
        line-height: 1.4;
      }
      .status-pill::before {
        content: '';
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
      }
      .status-active {
        background: var(--success-bg);
        color: var(--success);
      }
      .status-pending {
        background: var(--info-bg);
        color: var(--info);
      }
      .status-stopped,
      .status-warning {
        background: var(--warning-bg);
        color: var(--warning);
      }
      .status-archived,
      .status-neutral {
        background: var(--neutral-bg);
        color: var(--neutral);
      }
      .status-error {
        background: var(--danger-bg);
        color: var(--danger);
      }

      /* Channel log icon link, rendered by renderChannelLogLink beside
         a row's date cell. */
      .log-link {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        padding: 2px;
        border-radius: var(--r-sm);
        color: var(--text-3);
        text-decoration: none;
      }
      .log-link:hover {
        background: var(--sunken);
        color: var(--text-1);
      }
      .log-link temba-icon {
        --icon-color: currentColor;
      }
    `;
  }

  /** JSON endpoint URL. The component appends `sort` and `search`
   * params. Two pagination shapes are supported, picked per
   * response: a page-counted list — `{ results, count }`, navigated
   * by appending `page` — or a cursor list — `{ results, next,
   * previous }` with no `count`, navigated by following the opaque
   * `next` / `previous` URLs (rapidpro's `CursorPagination`). */
  @property({ type: String })
  endpoint: string;

  /** Endpoint for the page's content menu. Passed straight through
   * to the embedded {@link PageHeader}, which fetches it and renders
   * the menu's action buttons + overflow in the list header — so the
   * list header doubles as the page header instead of the page
   * chrome carrying a separate title + menu bar. */
  @property({ type: String, attribute: 'content-menu-endpoint' })
  contentMenuEndpoint = '';

  /** The content-menu endpoint with the current committed search folded
   * in, so the server's build_context_menu sees the same query the list
   * is showing. This is what surfaces search-dependent menu items — e.g.
   * the contact list's "Create Smart Group" button, which only appears
   * when the active query is saveable as a group. Binding the
   * page-header attribute to this (rather than the raw endpoint) makes
   * the menu re-fetch whenever the committed search changes. */
  private contentMenuEndpointWithSearch(): string {
    if (!this.contentMenuEndpoint) {
      return this.contentMenuEndpoint;
    }
    try {
      const url = new URL(this.contentMenuEndpoint, window.location.origin);
      // With no committed search, *strip* any search param rather than
      // passing the endpoint through — hosts typically bake the
      // original request's query string into the attribute (so a
      // deep-linked search seeds the menu), and clearing the search in
      // the list must also clear it from the menu fetch or
      // search-dependent items (e.g. "Create Smart Group") linger.
      if (this.search) url.searchParams.set('search', this.search);
      else url.searchParams.delete('search');
      return url.pathname + url.search;
    } catch {
      return this.contentMenuEndpoint;
    }
  }

  /** Column definitions. Subclasses build these in {@link buildColumns};
   * consumers may also override at the element level. */
  @property({ type: Array, attribute: false })
  columns: ContentListColumn[] = [];

  /** Bulk actions surfaced in the toolbar when rows are selected. */
  @property({ type: Array, attribute: false })
  bulkActions: ContentListBulkAction[] = [];

  /** Data key used to identify each row (default `uuid`). */
  @property({ type: String })
  valueKey = 'uuid';

  @property({ type: Number })
  pageSize = 50;

  /** Whether the search action and bar render at all, and whether search
   * state is picked up from the URL / history. Opt-in: a list only gets a
   * search box once its host says the contents are usefully searchable and
   * its endpoint knows what to do with a `search` param. */
  @property({ type: Boolean })
  searchable = false;

  /** ISO timestamp before which channel logs have been deleted by
   * retention. The host page sets it only when the viewer may read
   * channel logs, so it doubles as the permission gate: rows created
   * after it link to their channel logs (see
   * {@link getChannelLogsUrl}), and without it no row does. */
  @property({ type: String, attribute: 'show-logs-after' })
  showLogsAfter: string = null;

  /** Enables the multi-select checkbox column. The column only
   * actually renders when this is true AND {@link bulkActions} has
   * entries — a list with no bulk actions has nothing for selection
   * to drive, so checkboxes would just take up space. See
   * {@link hasCheckboxes}. */
  @property({ type: Boolean })
  selectable = true;

  /** Whether the selection column actually renders — true only when
   * the list is `selectable` AND has at least one bulk action. */
  protected get hasCheckboxes(): boolean {
    return this.selectable && this.bulkActions.length > 0;
  }

  /** When true, the table uses a fixed layout: every column is
   * sized up front (from each column's `width`, with the `grow`
   * column taking the remainder), so a cell whose content doesn't
   * fit ellipsis-truncates rather than stretching its column.
   * Intended for lists whose columns are all `width`-set or `grow`.
   * Pair with {@link minTableWidth} to allow a horizontal scroll
   * once the container is too narrow for those column shares. */
  @property({ type: Boolean, attribute: 'fixed-layout' })
  fixedLayout = false;

  /** Minimum table width (e.g. "640px"). The table won't shrink
   * below it — once the container is narrower, the list scrolls
   * horizontally instead. With {@link fixedLayout} this is what
   * lets the table scroll at all: fixed layout keeps each column's
   * share stable and truncates overflow, and this floor decides
   * when that share stops shrinking and the scroll takes over. */
  @property({ type: String, attribute: 'min-table-width' })
  minTableWidth = '';

  /** When true, the list grows to fill its container — the table
   * body scrolls inside it rather than the page. The host's parent
   * must be a height-bounded flex column (the list takes the slack
   * via `flex: 1`); anything below the list in that column, such as
   * a page footer, stays visible. Off by default; a full-page list
   * (e.g. the inbox) opts in. */
  @property({ type: Boolean, attribute: 'fill-window' })
  fillWindow = false;

  /** When true, sort/search/page state is reflected to the URL via
   * `history.pushState` so the page is deep-linkable and back/forward
   * navigates between list states. This mode has no history stash, so
   * the URL is its only position store: page-counted lists round-trip
   * `page=N` (a cursor slice has no page number to round-trip). Off
   * by default — opt in; mutually exclusive with
   * {@link historyStateKey}, which keeps position out of the URL. */
  @property({ type: Boolean })
  urlState = false;

  /** Prefix for URL parameter names — set this when multiple lists
   * share a page (e.g. `messages` → `?messages_page=2&messages_sort=...`). */
  @property({ type: String })
  urlParamPrefix = '';

  /** Key under which restorable list state (page, sort, search) is
   * stashed in the browser's history entry — set this to opt into
   * history-state restoration without touching the URL. On every
   * user-driven page/sort/search change the list fires a
   * `temba-history-change` event carrying `{key, state, replace}`;
   * the host (e.g. an SPA frame) is expected to merge `state` into
   * the current history entry and either `pushState` (when
   * `replace` is false — paging, sort, committed search) or
   * `replaceState` (when `replace` is true — typing in the search
   * box, or other no-history-entry updates). On mount the list
   * reads back `history.state?.[key]` and resumes from those values
   * before its initial fetch, and an in-list `popstate` re-reads
   * the active entry and re-fetches so back/forward navigates
   * between the user's page/sort/search states. Picks one slot per
   * list, so multiple lists on a page coexist by using distinct
   * keys. */
  @property({ type: String, attribute: 'history-state-key' })
  historyStateKey = '';

  /** Saved widths for every list, keyed first by the list's
   * {@link historyStateKey}, then by column key. The host can seed this
   * from user settings so each list remembers its own layout. This is
   * the same `list_columns` value that {@link settingsEndpoint} saves —
   * the attribute is the read side of that round trip. */
  @property({ type: Object, attribute: 'column-width-settings' })
  columnWidthSettings: Record<string, Record<string, number>> = {};

  /** Endpoint that accepts user-setting updates. Width persistence is
   * disabled when this or {@link historyStateKey} is unset. */
  @property({ type: String, attribute: 'settings-endpoint' })
  settingsEndpoint = '';

  /** Debounce window for settings saves. Public so tests can shorten it. */
  saveDelay = 500;

  /** Placeholder for the search input. When unset, falls back to
   * {@link defaultSearchPlaceholder}. */
  @property({ type: String })
  searchPlaceholder: string = null;

  /** Default search placeholder, resolved at render time so it reflects
   * the locale, which is only known once the store has loaded. Subclasses
   * override this rather than assigning {@link searchPlaceholder} in their
   * constructors, which would freeze the source-locale string. */
  protected defaultSearchPlaceholder(): string {
    return msg('Search');
  }

  /** Page-level title rendered above the panel. Either set this or
   * slot custom content via `<div slot="title">…</div>`. */
  @property({ type: String, attribute: 'list-title' })
  listTitle = '';

  /** Smaller subtitle below the title. */
  @property({ type: String })
  subtitle = '';

  /** Message shown when the list is empty. When unset, falls back to
   * {@link defaultEmptyMessage}. */
  @property({ type: String, attribute: 'empty-message' })
  emptyMessage: string = null;

  /** Default empty message, resolved at render time so it reflects the
   * locale, which is only known once the store has loaded. Subclasses
   * override this rather than assigning {@link emptyMessage} in their
   * constructors, which would freeze the source-locale string. */
  protected defaultEmptyMessage(): string {
    return msg('Nothing to show');
  }

  /** Label for the pager's total when the list is cursor-paginated.
   * A cursor slice has no ordinal position — the rows keep their
   * identity while the total moves underneath them — so the pager
   * reports how many rows exist rather than which of them you are
   * looking at. Says "matches" when the rows are the result of a
   * search, plain "total" otherwise — what the rows *are* is already
   * evident from the list itself. */
  protected totalLabel(): string {
    return this.search
      ? msg(str`${formatCount(this.total)} matches`)
      : msg(str`${formatCount(this.total)} total`);
  }

  /** Bump to force a refetch — useful after a bulk action so the host
   * can re-pull from the server. */
  @property({ type: String })
  refreshKey = '';

  /** URL the component POSTs bulk-action changes to (currently
   * label-toggle). Form-data shape mirrors rapidpro's smartmin
   * `BulkActionMixin`: `action=label`, `objects[]=<id>`,
   * `label=<uuid>`, `add=true|false`. */
  @property({ type: String, attribute: 'action-endpoint' })
  actionEndpoint = '';

  @state()
  protected items: T[] = [];

  @state()
  protected total = 0;

  /** Whether the last response carried a server `count`. Distinct
   * from {@link total} because cursor lists fall back to the visible
   * page length so the empty-state math still works — only an actual
   * server count is reliable enough to surface in the UI (e.g. the
   * search result indicator). */
  @state()
  protected hasCount = false;

  @state()
  protected page = 1;

  /** Whether the last response was a cursor list. Detected from the
   * shape of `next` / `previous` (a `cursor=` query param marks DRF
   * CursorPagination) so the mode survives a count being returned
   * alongside cursor URLs — a searched cursor endpoint may include
   * `count` for the result indicator without abandoning cursor
   * navigation. Falls back to count-absent on single-page responses
   * where neither nav URL is set. In cursor mode the pager follows
   * {@link nextCursor} / {@link prevCursor} instead of computing
   * page numbers off {@link total}. */
  @state()
  protected cursorMode = false;

  /** Same-origin path+query of the cursor list's `next` page, or ''
   * when there is none. Only meaningful in {@link cursorMode}. */
  @state()
  protected nextCursor = '';

  /** Same-origin path+query of the cursor list's `previous` page, or
   * '' when there is none. Only meaningful in {@link cursorMode}. */
  @state()
  protected prevCursor = '';

  /** URL of the most recent fetch — re-requested by {@link refresh}
   * (and after a bulk action) so a cursor list stays on its current
   * page rather than snapping back to the first. */
  private currentUrl = '';

  /** URL to fetch on the next initial-fetch pass, lifted from the
   * host's `history.state` by {@link readHistoryState}. Lets a
   * cursor-paginated list resume on the exact slice the user was on
   * (cursor URLs are opaque, so reconstructing them from page/sort
   * isn't possible). Cleared after use. */
  private restoreUrl = '';

  /** Sort key; prefix with `-` for descending. Empty = server default. */
  @state()
  protected sort = '';

  @state()
  protected search = '';

  @state()
  protected loading = false;

  @state()
  protected searching = false;

  /** Query-validation error from the last search (e.g. `age >`). Shown
   * over the empty table in place of the "nothing to show" copy, and
   * cleared on the next fetch. */
  @state()
  protected searchError = '';

  @state()
  protected selectedIds: Set<string> = new Set();

  /** Whether the inline search input is expanded. The "Search"
   * action button toggles it; the styleguide hides the input until
   * the user asks for it so the toolbar stays clean. */
  @state()
  protected searchOpen = false;

  /** Uncommitted input text — what's in the textbox while the user
   * is typing. Distinct from {@link search}, which is the committed
   * query that drives the fetch; the draft is only promoted to
   * `search` when the user presses Enter or clicks the search icon.
   * Bound to the input's `.value` so re-renders preserve typing. */
  @state()
  protected searchDraft = '';

  /** Cache of labels fetched per label-toggle action key.
   * Populated lazily the first time a label dropdown opens. */
  @state()
  protected labelsByActionKey: { [key: string]: any[] } = {};

  /** Uuid of the label currently being toggled. While set, the
   * dropdown's other toggles are blocked so the user can't fire
   * conflicting POSTs before the server confirms + the list
   * re-fetches. */
  @state()
  protected pendingLabel: string | null = null;

  /** When the bulk-action bar's chips would overflow the available
   * width, their labels collapse to icon-only (animated). Measured in
   * {@link updateBulkCollapse}. */
  @state()
  private bulkCollapsed = false;

  /** Pending rAF handle for the deferred collapse re-measure (0 when
   * none is scheduled). See {@link updateBulkCollapse}. */
  private bulkCollapseFrame = 0;

  private pending: AbortController = null;
  private popstateHandler: () => void;
  private resizeHandler: () => void;

  /** Active pointer-driven column resize. Window listeners keep the drag
   * alive when the pointer outruns the narrow header handle. */
  private columnResize:
    | {
        key: string;
        startX: number;
        startWidth: number;
        minWidth: number;
        nativeFloor: boolean;
        initialSavedWidth: number | undefined;
        changed: boolean;
        handle: HTMLElement;
      }
    | undefined;
  private previousBodyUserSelect = '';

  /** Active pointer-driven header drag-reorder. The drag only "starts"
   * once the pointer travels past a small threshold, so a plain click
   * on a reorderable (and typically sortable) header still sorts. */
  private columnDrag:
    | {
        key: string;
        pointerId: number;
        startX: number;
        grabOffsetX: number;
        started: boolean;
        header: HTMLElement;
        ghost?: HTMLElement;
      }
    | undefined;

  /** The drag keeps its own copy of body user-select: a resize started
   * mid-drag cancels the drag, and sharing one field would let whichever
   * finished last restore the other's (already overwritten) value. */
  private previousBodyUserSelectDrag = '';

  /** Pointer travel, in px, that separates a click (sort) from a drag
   * (reorder). Only horizontal travel counts — that's the axis the
   * reorder happens on. */
  private static readonly DRAG_DEAD_ZONE = 5;

  /** Key of the column being drag-reordered, '' when idle — drives the
   * dimmed treatment on the origin header. */
  @state()
  private draggingColumnKey = '';

  /** Insertion slot the drag is currently over: the `columns` index
   * the dragged column would be inserted before (one past the
   * reorderable run for an end drop), or -1 when idle. */
  @state()
  private columnDropSlot = -1;

  private columnWidths: Record<string, number> = {};
  private columnWidthSaveTimeout: ReturnType<typeof setTimeout> = null;
  private suppressHeaderClick = false;
  private headerClickSuppressionTimeout: ReturnType<typeof setTimeout> = null;

  /** Pin index assigned to each left-pinned column / leading cell,
   * used to resolve its sticky `left`. Recomputed each render. */
  private pinIndexByColumn = new Map<ContentListColumn, number>();
  /** Pin index assigned to each right-pinned column, counted from
   * the right edge (0 = rightmost), used to resolve its sticky
   * `right`. Recomputed each render. */
  private rightPinIndexByColumn = new Map<ContentListColumn, number>();
  private checkPinIndex = -1;
  private lastPinIndex = -1;
  /** Right-pin index of the leftmost right-pinned column — the one
   * that carries the divider against the scrolling section. */
  private firstRightPinIndex = -1;
  /** Column index after which the slack-absorbing spacer cell is
   * rendered (the last pinned column), or -1 when nothing is
   * pinned. Extra table width pools in that spacer. */
  private spacerAfterIndex = -1;
  /** Whether the current items reserve leading-icon space in the first
   * column (true when a representative row carries an icon). */
  private reservesIcon = false;

  constructor() {
    super();
  }

  /** Gives specialized lists a chance to normalize a fetched page before it
   * becomes visible. The default keeps the server response unchanged. */
  protected prepareItems(items: T[]): T[] {
    return items;
  }

  /** Builds this list's columns. Subclasses override this rather than
   * assigning `columns` directly, because their labels are msg()
   * strings and the workspace locale only arrives once the store has
   * fetched it — well after the elements are constructed — so the list
   * builds them at render time and rebuilds them when the locale
   * lands. Returning null leaves `columns` to whatever the subclass or
   * the host set. */
  protected buildColumns(): ContentListColumn[] | null {
    return null;
  }

  /** Rebuilds the columns from {@link buildColumns} — a no-op for a
   * list which doesn't override it. Subclasses call this when the
   * inputs to their column set change, e.g. custom fields arriving. */
  protected refreshColumns(): void {
    const columns = this.buildColumns();
    if (columns) {
      this.columns = columns;
    }
  }

  /** Whether the columns have been built yet. */
  private columnsBuilt = false;

  /** The workspace locale is only known once the store has fetched it,
   * so a list mounted before then built its columns from the source
   * strings — build them again now they can be translated. A list
   * mounted after it lands gets translated labels first time. */
  private handleLocaleStatus(event: Event): void {
    if ((event as CustomEvent).detail?.status === 'ready') {
      this.refreshColumns();
    }
  }

  protected willUpdate(changes: PropertyValues): void {
    // Build before anything reads `columns` this cycle — notably the
    // column-width sync below, which needs to see them. Setting a
    // reactive property here folds into the update in progress, so
    // `changes` picks up `columns` rather than scheduling another pass.
    if (!this.columnsBuilt) {
      this.columnsBuilt = true;
      this.refreshColumns();
    }

    super.willUpdate(changes);
    if (
      changes.has('columnWidthSettings') ||
      changes.has('historyStateKey') ||
      changes.has('columns')
    ) {
      const saved = this.columnWidthSettings?.[this.historyStateKey];
      const widths: Record<string, number> = {};
      if (saved && typeof saved === 'object') {
        Object.entries(saved).forEach(([key, value]) => {
          if (typeof value === 'number' && Number.isFinite(value)) {
            const column = this.columns.find(
              (candidate) => candidate.key === key
            );
            widths[key] = this.clampColumnWidth(
              value,
              column
                ? this.minimumColumnWidth(column)
                : ContentList.MIN_COLUMN_WIDTH
            );
          }
        });
      }
      // A columns rebuild (custom fields arriving, anon flipping) must
      // not discard widths dragged this session that haven't round-tripped
      // through the settings attribute — only a new settings payload or a
      // different list replaces them outright.
      const preserved =
        changes.has('columnWidthSettings') || changes.has('historyStateKey')
          ? {}
          : this.columnWidths;
      this.columnWidths = { ...widths, ...preserved };
    }
  }

  public connectedCallback(): void {
    super.connectedCallback();
    // Deliberately not a getEventHandlers() entry: RapidElement reads
    // that with no super-merging, so a subclass overriding it would
    // silently stop re-translating its headers. listenTo removes the
    // listener when we disconnect either way.
    this.listenTo(window, LOCALE_STATUS_EVENT, this.handleLocaleStatus);
    if (this.urlState) {
      this.readUrlState();
      this.popstateHandler = () => {
        this.readUrlState();
        this.fetchPage();
      };
      window.addEventListener('popstate', this.popstateHandler);
    } else if (this.historyStateKey) {
      // Restore from the host SPA's history entry on mount so the
      // list resumes on whatever page it was on the last time the
      // user was here — works in tandem with the host's
      // `temba-history-change` listener (which pushes a new entry
      // for paging/sort/committed-search and replaces in place for
      // search-typing, per the event's `replace` flag). The
      // popstate handler covers in-list back/forward, where the
      // URL doesn't change so the SPA frame doesn't remount the
      // list — we re-read state from the active entry and re-fetch
      // ourselves. Cross-URL back navigation still goes through
      // the SPA frame and remounts a fresh list, which then reads
      // state on mount.
      this.readHistoryState();
      this.popstateHandler = () => {
        this.readHistoryState();
        const restore = this.restoreUrl;
        this.restoreUrl = '';
        this.fetchPage(restore || undefined, !!restore);
      };
      window.addEventListener('popstate', this.popstateHandler);
    }
    // A viewport resize changes whether the table overflows, so the
    // right-edge scroll affordance has to be re-evaluated.
    this.resizeHandler = () => {
      this.syncScrollAffordance();
      this.updateBulkCollapse();
    };
    window.addEventListener('resize', this.resizeHandler);
    // Pinned columns now size to their content, so a late web-font
    // load shifts their widths — re-measure the sticky offsets once
    // fonts settle so the pinned cells don't drift out of alignment.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        this.measurePinOffsets();
        this.syncScrollAffordance();
      });
    }
  }

  public disconnectedCallback(): void {
    if (this.popstateHandler) {
      window.removeEventListener('popstate', this.popstateHandler);
    }
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }
    this.stopColumnResize();
    this.cancelColumnDrag();
    if (this.columnWidthSaveTimeout) {
      clearTimeout(this.columnWidthSaveTimeout);
      this.columnWidthSaveTimeout = null;
      this.saveColumnWidths();
    }
    if (this.headerClickSuppressionTimeout) {
      clearTimeout(this.headerClickSuppressionTimeout);
      this.headerClickSuppressionTimeout = null;
    }
    if (this.bulkCollapseFrame) {
      cancelAnimationFrame(this.bulkCollapseFrame);
      this.bulkCollapseFrame = 0;
    }
    if (this.pending) {
      // Null the pending pointer before aborting so fetchPage's
      // finally block — which gates cleanup on `this.pending ===
      // controller` — skips firing FetchComplete on a disconnected
      // component.
      const controller = this.pending;
      this.pending = null;
      controller.abort();
    }
    super.disconnectedCallback();
  }

  protected updated(changes: PropertyValues): void {
    super.updated(changes);
    // Only watch endpoint and refreshKey here — both are typically
    // set externally and have no other handler that already fires a
    // fetch. Sort/page/search are mutated by internal handlers that
    // call fetchPage themselves, so tracking them here would
    // double-fire the request.
    if (
      (changes.has('endpoint') || changes.has('refreshKey')) &&
      this.endpoint
    ) {
      // If readHistoryState staged a restoreUrl, the first fetch
      // follows that URL so a cursor list lands on the saved slice.
      // Clear it so subsequent fetches use the live state.
      const restore = this.restoreUrl;
      this.restoreUrl = '';
      this.fetchPage(restore || undefined, !!restore);
    }
    // Pinned-column offsets and the scroll affordances both depend
    // on the freshly-laid-out DOM, so settle them after each render.
    this.measurePinOffsets();
    this.syncScrollAffordance();
    this.updateBulkCollapse();
  }

  /** Collapse the bulk-action labels to icon-only when the chips would
   * overflow the bar. Measures synchronously for immediate feedback,
   * then re-measures on the next frame: the chip `<temba-icon>`s are
   * child custom elements that render their SVG in a *later* update
   * cycle, so the moment the bar first appears they still have zero
   * width and the chips read as narrow — the bar looks like it fits and
   * doesn't collapse until a later nudge (a second selection or a
   * resize) re-runs the measurement. The deferred pass settles it on
   * first show, once the icons have laid out. */
  private updateBulkCollapse(): void {
    this.measureBulkCollapse();
    if (this.bulkCollapseFrame) cancelAnimationFrame(this.bulkCollapseFrame);
    this.bulkCollapseFrame = requestAnimationFrame(() => {
      this.bulkCollapseFrame = 0;
      this.measureBulkCollapse();
    });
  }

  /** One overflow measurement. The decision is made against the
   * fully-expanded width with transitions suppressed (the `measuring`
   * class) — reading scrollWidth mid-animation otherwise returns a width
   * between the collapsed and expanded states, which made the collapse
   * flip-flop and never settle. The expanded layout is forced and the
   * current state restored synchronously (no paint in between) so
   * there's no flash, then transitions are re-enabled so a real state
   * change animates. */
  private measureBulkCollapse(): void {
    const bar = this.shadowRoot?.querySelector(
      '.bulk-bar'
    ) as HTMLElement | null;
    if (!bar) return;
    bar.classList.add('measuring');
    bar.classList.remove('collapsed');
    const overflows = bar.scrollWidth > bar.clientWidth + 1;
    bar.classList.toggle('collapsed', this.bulkCollapsed);
    void bar.offsetWidth;
    bar.classList.remove('measuring');
    if (overflows !== this.bulkCollapsed) this.bulkCollapsed = overflows;
  }

  /** Read sort/page/search from the URL on first load / popstate. In
   * history-state mode the page param is read-only compatibility — we
   * never write it there (see {@link buildBrowserUrl}), but an old
   * bookmarked URL may carry one and page-counted endpoints still
   * honor it. In urlState mode it's the round-tripped position. */
  private readUrlState(): void {
    const params = new URLSearchParams(window.location.search);
    const k = (name: string) =>
      this.urlParamPrefix ? `${this.urlParamPrefix}_${name}` : name;
    const previousSearch = this.search;
    // a non-searchable list ignores any search the URL carries, so a stale
    // bookmark can't leave it silently filtered with no search bar to show
    // or clear the term
    this.search = (this.searchable && params.get(k('search'))) || '';
    this.sort = params.get(k('sort')) || '';
    const pageParam = parseInt(params.get(k('page')) || '1', 10);
    this.page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
    // Reveal the search input when the URL carries an active query —
    // see readHistoryState for the equivalent treatment. The
    // close-on-empty branch only fires when the navigation actually
    // cleared a prior search; an unrelated popstate that arrives
    // while the user has the searchbar open and is mid-typing must
    // not slam their draft.
    if (this.search) {
      this.searchOpen = true;
      this.searchDraft = this.search;
    } else if (previousSearch) {
      this.searchOpen = false;
      this.searchDraft = '';
    }
  }

  /** Push current sort/page/search to the URL and/or bubble it up
   * to the host for stashing in history.state — call this on every
   * user-driven page/sort/search change. `replace` is true while the
   * user is typing in the search box (don't pollute history). */
  private writeUrlState(replace = false): void {
    this.bubbleHistoryState(replace);
    if (!this.urlState) return;
    const url = this.buildBrowserUrl();
    if (replace) {
      window.history.replaceState({}, '', url);
    } else {
      window.history.pushState({}, '', url);
    }
  }

  /** The address-bar URL reflecting the current list state: the
   * page's path with the list's search/sort/page params folded into
   * the existing query string (set when active, removed when not —
   * so a cleared search drops its param). Params the list doesn't
   * own are preserved. */
  private buildBrowserUrl(): string {
    const params = new URLSearchParams(window.location.search);
    const k = (name: string) =>
      this.urlParamPrefix ? `${this.urlParamPrefix}_${name}` : name;

    const setOrDelete = (name: string, value: string) => {
      if (value) params.set(name, value);
      else params.delete(name);
    };
    setOrDelete(k('search'), this.search);
    setOrDelete(k('sort'), this.sort);
    // In history-state mode list position never reaches the URL — a
    // cursor slice has no meaningful page number, and page-counted
    // lists restore their position from the history stash instead, so
    // all list pages keep the same clean URL while paging (passing ''
    // also scrubs a stale page param arriving on an old bookmarked
    // URL). A pure urlState list is the exception: it has no history
    // stash — the URL is its only position store — so a page-counted
    // one keeps round-tripping `page=N` there.
    setOrDelete(
      k('page'),
      this.urlState && !this.cursorMode && this.page > 1
        ? String(this.page)
        : ''
    );

    const qs = params.toString();
    return window.location.pathname + (qs ? '?' + qs : '');
  }

  /** Read saved list state out of the host's history entry under
   * {@link historyStateKey}. Mirrors {@link readUrlState} but pulls
   * from `history.state` rather than the query string. The `url`
   * field, when present, is the cursor-or-page URL of the slice the
   * user was on — staged in {@link restoreUrl} so the very next
   * fetch follows it (the only way to land on a specific slice of a
   * cursor-paginated list, whose pages have no numeric identifier). */
  private readHistoryState(): void {
    const key = this.historyStateKey;
    if (!key) return;
    const state = window.history.state || {};
    // A fresh navigation has no stash for this list yet, but the link
    // itself may deep-link a query (e.g. /contact/?search=age%3E10) —
    // fall back to the URL params so the list initializes on them.
    // Once the list has bubbled state for this entry the stash exists
    // (even with an empty search) and takes precedence, so a cleared
    // search isn't resurrected by a stale query string.
    if (!(key in state)) {
      this.restoreUrl = '';
      this.readUrlState();
      return;
    }
    const stash = state[key] || {};
    const previousSearch = this.search;
    this.search =
      this.searchable && typeof stash.search === 'string' ? stash.search : '';
    this.sort = typeof stash.sort === 'string' ? stash.sort : '';
    const p = parseInt(stash.page, 10);
    this.page = isNaN(p) || p < 1 ? 1 : p;
    this.restoreUrl = typeof stash.url === 'string' ? stash.url : '';
    // A restored search needs visible affordance — open the search
    // bar and seed the draft so the user sees the active query and
    // can edit or clear it without having to click the search
    // toggle and discover the term was retained. Only auto-close on
    // empty when the navigation actually cleared a prior search, so
    // an unrelated popstate that arrives while the user is mid-
    // typing doesn't slam their draft.
    if (this.search) {
      this.searchOpen = true;
      this.searchDraft = this.search;
    } else if (previousSearch) {
      this.searchOpen = false;
      this.searchDraft = '';
    }
  }

  /** Bubble the current page/sort/search/url up to the host so it
   * can stash them in the active history entry. The `url` field
   * carries `currentUrl` (the URL of the most recent successful
   * fetch) — page-mode lists can rebuild that from page/sort/search,
   * but cursor-mode lists rely on it to land on the exact slice the
   * user was on. `replace` tells the host whether this change should
   * create a new back-history entry (false — paging, sort,
   * committed search) or overwrite the current one (true — typing
   * in the search box, cursor-page snap-back). The component never
   * touches `history` itself in this mode — that keeps the host's
   * SPA navigation in charge of history mutations and lets multiple
   * lists on a page coexist under distinct {@link historyStateKey}s. */
  private bubbleHistoryState(replace: boolean): void {
    if (!this.historyStateKey) return;
    // For a page-mode list, page/sort/search are enough — the
    // initial fetch on restore rebuilds the request URL from them.
    // For a cursor list, page numbers are meaningless, so we also
    // stash the most recent cursor URL (set synchronously by
    // fetchPage(target)) so restore can land on the exact slice.
    const state: Record<string, any> = {
      page: this.page,
      sort: this.sort,
      search: this.search
    };
    if (this.cursorMode && this.currentUrl) {
      state.url = this.currentUrl;
    }
    // `url` (distinct from `state.url`, the fetch cursor) is the
    // address-bar URL for this list state — the host should pass it
    // as the url argument of its pushState/replaceState so a
    // committed or cleared search is reflected in the address bar,
    // while keeping its own stashed page URL (frame.js's
    // `state.url`) stable so in-list back/forward isn't mistaken
    // for a cross-page navigation.
    this.fireCustomEvent(CustomEventType.HistoryChange, {
      key: this.historyStateKey,
      state,
      replace,
      url: this.buildBrowserUrl()
    });
  }

  /** Build the request URL by appending sort/search/page params to
   * the configured endpoint. */
  private buildRequestUrl(): string {
    const url = new URL(this.endpoint, window.location.origin);
    if (this.search) url.searchParams.set('search', this.search);
    if (this.sort) url.searchParams.set('sort', this.sort);
    if (this.page > 1) url.searchParams.set('page', String(this.page));
    if (this.pageSize !== 50)
      url.searchParams.set('page_size', String(this.pageSize));
    return url.pathname + url.search;
  }

  /** Tell a cursor list from a page-counted one. The internal API
   * says which it used in `paged_by`, and that's authoritative —
   * nothing else in the response distinguishes the two once the
   * results fit on a single page, since a lone page carries no nav
   * URLs to inspect.
   *
   * Without it, fall back to those URLs — DRF CursorPagination always
   * emits a `cursor=` query param, PageNumberPagination uses `page=`.
   * A response that carries `count` alongside cursor URLs — e.g. a
   * searched cursor endpoint that returns a result tally for the UI
   * indicator — must still be navigated by following the cursor URLs,
   * so we can't use count presence alone. Last of all comes the
   * count-absent heuristic, which is the ambiguous single-page case
   * `paged_by` exists to settle. */
  private detectCursorMode(data: FetchResponse<T>): boolean {
    if (data.paged_by) return data.paged_by === 'cursor';
    const hasCursor = (raw: string | undefined | null): boolean => {
      if (!raw) return false;
      try {
        return new URL(raw, window.location.origin).searchParams.has('cursor');
      } catch {
        return false;
      }
    };
    if (hasCursor(data.next) || hasCursor(data.previous)) return true;
    return data.count == null;
  }

  /** Reduce a cursor `next` / `previous` URL — which the server
   * returns absolute — to a same-origin path+query for `getUrl`.
   * A cross-origin URL is rejected (returns '') so a malformed
   * response can't redirect the fetch off-site. */
  private toRequestUrl(raw: string): string {
    try {
      const url = new URL(raw, window.location.origin);
      if (url.origin !== window.location.origin) return '';
      return url.pathname + url.search;
    } catch {
      return '';
    }
  }

  /** Fetch a page. With no argument this builds a fresh request from
   * the endpoint + current sort/search/page (resetting a cursor list
   * to its first page); pass an explicit `url` to follow a cursor or
   * to re-request {@link currentUrl}. `restash` marks a restore fetch
   * (one following a {@link restoreUrl} out of history state): on
   * success the list re-bubbles its state with `replace` so the stash
   * is written back onto the freshly loaded entry — the SPA frame's
   * history bootstrap rebuilds entry state on every page load, so
   * without this a stash would only reliably survive one refresh. */
  private async fetchPage(url?: string, restash = false): Promise<void> {
    if (!this.endpoint) return;
    if (this.pending) this.pending.abort();
    const controller = new AbortController();
    this.pending = controller;
    this.loading = true;
    // Drop any prior query error so it doesn't linger behind the new
    // request's loading/searching state.
    this.searchError = '';
    // Whether this fetch is a search commit (vs. paging/refresh) —
    // captured up front since `searching` is cleared in `finally`. Only
    // a search adopts a server-adjusted query and refocuses the input.
    const wasSearch = this.searching;
    const requestUrl = url || this.buildRequestUrl();
    this.currentUrl = requestUrl;
    try {
      const response = await getUrl(requestUrl, controller);
      const data = (response.json || {}) as FetchResponse<T>;
      // A query-validation error comes back list-shaped (status 200,
      // empty results) with an `error` message — surface it over the
      // empty table rather than the plain empty-state copy.
      this.searchError = typeof data.error === 'string' ? data.error : '';
      this.items = this.prepareItems(data.results || []);
      this.nextCursor = data.next ? this.toRequestUrl(data.next) : '';
      this.prevCursor = data.previous ? this.toRequestUrl(data.previous) : '';
      // Cursor mode is detected from the shape of next/previous,
      // not the absence of `count` — a cursor endpoint may include
      // `count` (e.g. during search) without switching to page-mode
      // navigation. See {@link detectCursorMode}.
      this.cursorMode = this.detectCursorMode(data);
      this.hasCount = data.count != null;
      this.total = data.count ?? this.items.length;
      // `page` carries no meaning for a cursor list, and nothing
      // reads it in that mode. Pin it so a stale value restored from
      // an older history entry can't leak into a request URL or a
      // later page-mode render.
      if (this.cursorMode) {
        this.page = 1;
      }
      // drop any selected ids that aren't visible anymore — selection
      // is per-page, not cross-page, so users don't accidentally bulk
      // act on rows they can't see.
      const visible = new Set(this.items.map((i) => this.rowId(i)));
      const next = new Set<string>();
      this.selectedIds.forEach((id) => {
        if (visible.has(id)) next.add(id);
      });
      this.selectedIds = next;
      // If the server echoed an adjusted/normalized query for this
      // search, adopt it as the basis of the results and mirror it back
      // into the input — so the box shows exactly what the results
      // reflect (and the Search button stays hidden until the user
      // edits away from it again). Keep the URL in step via a replacing
      // write so it carries the normalized form without a new entry.
      if (wasSearch && typeof data.query === 'string') {
        this.search = data.query;
        this.searchDraft = data.query;
        this.writeUrlState(true);
      }
      // A restore fetch re-writes its stash onto the current entry
      // (replacing, so no new back-history) now that the state it was
      // restored from is live again.
      if (restash) {
        this.writeUrlState(true);
      }
    } catch (err) {
      // aborted or failed; leave items as-is and let the caller see
      // the empty/error state via console — no toast to keep the
      // component dependency-free.
      if ((err as DOMException)?.name !== 'AbortError') {
        // eslint-disable-next-line no-console
        console.error('ContentList fetch failed', err);
      }
    } finally {
      if (this.pending === controller) {
        this.pending = null;
        this.loading = false;
        this.searching = false;
        // The input was disabled while the search ran; once it
        // re-enables, restore focus and drop the cursor at the end of
        // the (possibly adjusted) query so the user can keep editing
        // without re-clicking into the box.
        if (wasSearch && this.searchOpen) {
          this.updateComplete.then(() => this.focusSearchEnd());
        }
        this.fireCustomEvent(CustomEventType.FetchComplete);
      }
    }
  }

  /** Focus the search input and place the caret at the end of its
   * value — used after a search settles and the box re-enables. */
  private focusSearchEnd(): void {
    const input = this.shadowRoot?.querySelector(
      '.searchbar input'
    ) as HTMLInputElement | null;
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }

  /** Public API — programmatic refresh, mirrors `refreshKey` bump.
   * Re-requests the current page (cursor lists included) rather than
   * resetting to the first. Also drops the cached label-dropdown
   * lists — a refresh often follows label/group creation, and the
   * next dropdown open should see the new entry. */
  public refresh(): void {
    this.labelsByActionKey = {};
    this.fetchPage(this.currentUrl || undefined);
  }

  /** Identity helper — uses the `valueKey` to pull a stable id from
   * the row, falling back to JSON.stringify for objects without one. */
  protected rowId(item: T): string {
    const v = (item as any)?.[this.valueKey];
    return v != null ? String(v) : JSON.stringify(item);
  }

  /** Override in subclasses to customize per-column rendering. The
   * default reads `item[column.key]` and renders as text. */
  protected renderCell(
    item: T,
    column: ContentListColumn
  ): TemplateResult | string {
    const value = (item as any)?.[column.key];
    if (value == null) return '';
    return String(value);
  }

  /** Override in subclasses to make rows navigate on click. Return
   * a URL to navigate, or null to leave the click as event-only. */
  protected getRowHref(_item: T): string | null {
    return null;
  }

  /** Whether a row reads as clickable — the pointer cursor that says
   * the click leads somewhere. A row with an href always does;
   * override for a list whose rows are opened by the host off
   * `temba-row-click` rather than by navigating, so it keeps the
   * affordance without a URL to link to. */
  protected isRowClickable(item: T): boolean {
    return !!this.getRowHref(item);
  }

  /** Extra classes a subclass wants on a row — e.g. to animate rows
   * arriving in or leaving the list. */
  protected getRowClass(_item: T): string {
    return '';
  }

  /** Extra inline style a subclass wants on a row — e.g. custom
   * properties timing that row's part of a shared animation. */
  protected getRowStyle(_item: T): string {
    return '';
  }

  /** Update the uncommitted input value as the user types. The
   * fetch is deferred until the user submits (Enter / search-icon
   * click) so we don't pound the server on every keystroke. */
  private handleSearchInput(event: any): void {
    this.searchDraft = event.target.value || '';
  }

  /** Commit on Enter; let other keys through. Escape closes the bar
   * outright (clearing any active search, mirroring toggleSearch's
   * close path) — the keyboard counterpart to the close (✕) button. */
  private handleSearchKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitSearch();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.toggleSearch();
    }
  }

  /** Promote the input's draft to the committed search and fetch.
   * fetchPage runs first so currentUrl reflects the new search before
   * the state bubbles — bubbling first would stash the pre-search URL
   * and break history restoration on the way back. Pushes a new
   * history entry so the prior search (or unsearched view) is one
   * "back" away, matching paging and sort semantics. */
  private commitSearch(): void {
    if (this.search === this.searchDraft) return;
    this.search = this.searchDraft;
    this.page = 1;
    this.searching = true;
    this.fetchPage();
    this.writeUrlState();
  }

  private handleSortClick(column: ContentListColumn): void {
    if (!column.sortable) return;
    if (this.sort === column.key) {
      this.sort = '-' + column.key;
    } else if (this.sort === '-' + column.key) {
      this.sort = '';
    } else {
      this.sort = column.key;
    }
    this.page = 1;
    // fetchPage first so currentUrl reflects the new sort before the
    // state bubbles — see commitSearch for the full reasoning.
    this.fetchPage();
    this.writeUrlState();
  }

  private handleColumnHeaderClick(
    event: MouseEvent,
    column: ContentListColumn
  ): void {
    // Releasing a resize over the header label can synthesize a click on
    // the shared <th>. Consume that click so resizing never changes sort.
    if (this.suppressHeaderClick) {
      event.preventDefault();
      event.stopPropagation();
      this.suppressHeaderClick = false;
      clearTimeout(this.headerClickSuppressionTimeout);
      this.headerClickSuppressionTimeout = null;
      return;
    }
    this.handleSortClick(column);
  }

  private handleRowClick(item: T, event: MouseEvent): void {
    // Ignore clicks originating from the checkbox cell so toggling
    // selection doesn't double as navigation.
    const path = event.composedPath();
    if (path.some((n: any) => n?.classList?.contains?.('check-cell'))) {
      return;
    }
    const rowHref = this.getRowHref(item);
    const href = rowHref && this.isSafeHref(rowHref) ? rowHref : null;
    // Meta/ctrl-click opens a new tab, matching ordinary links. Skip
    // RowClick entirely — host pages navigate on it unconditionally,
    // which would also swap out the current page.
    if (href && (event.metaKey || event.ctrlKey)) {
      window.open(href, '_blank');
      return;
    }
    this.fireCustomEvent(CustomEventType.RowClick, { item });
    if (href) {
      // Fire Redirected rather than assigning window.location so the
      // host SPA frame swaps content in place instead of doing a full
      // page reload — the frame listens for this event on document and
      // routes it through its in-app loader.
      this.fireCustomEvent(CustomEventType.Redirected, { url: href });
    }
  }

  /** The URL of a row's channel logs, or null when the host hasn't
   * enabled log links, the row has no channel, or it was created
   * before the retention cutoff. `type` is the log owner's kind as
   * the logs page addresses it (`msg` or `call`). */
  protected getChannelLogsUrl(
    item: { uuid?: string; created_on?: string; channel?: ObjectReference },
    type: 'msg' | 'call'
  ): string | null {
    if (!this.showLogsAfter || !item?.uuid || !item.channel?.uuid) {
      return null;
    }
    const createdOn = item.created_on ? new Date(item.created_on) : null;
    if (!createdOn || createdOn < new Date(this.showLogsAfter)) {
      return null;
    }
    return `/channels/channel/logs/${item.channel.uuid}/${type}/${item.uuid}/`;
  }

  /** A row's channel log icon link, or '' when {@link getChannelLogsUrl}
   * yields nothing. It opens the log in a sheet over the list, and
   * keeps its click from the row's own navigation. */
  protected renderChannelLogLink(
    item: { uuid?: string; created_on?: string; channel?: ObjectReference },
    type: 'msg' | 'call'
  ): TemplateResult | string {
    const href = this.getChannelLogsUrl(item, type);
    if (!href) return '';
    return html`
      <a
        class="log-link"
        href=${href}
        @click=${openLinkInSheet}
        aria-label=${msg('Channel log')}
      >
        <temba-icon name=${Icon.log} size="0.95"></temba-icon>
      </a>
    `;
  }

  /** Guard against open-redirect: row hrefs come from JSON-driven
   * subclasses and could contain externally-influenced values. Only
   * permit same-origin navigation — absolute URLs must match the
   * current origin, relative URLs must be path-only (starting with
   * `/` and not `//`, which would be protocol-relative). */
  protected isSafeHref(href: string): boolean {
    if (typeof href !== 'string' || href.length === 0) return false;
    // Reject protocol-relative URLs ("//evil.com/...") and any
    // scheme-prefixed URL that isn't same-origin.
    if (href.startsWith('//')) return false;
    if (href.startsWith('/')) return true;
    try {
      const url = new URL(href, window.location.origin);
      return url.origin === window.location.origin;
    } catch {
      return false;
    }
  }

  private handleRowToggle(item: T): void {
    const id = this.rowId(item);
    const next = new Set(this.selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selectedIds = next;
    this.fireCustomEvent(CustomEventType.SelectionChange, {
      ids: Array.from(next)
    });
  }

  private handleSelectAll(): void {
    const allIds = this.items.map((i) => this.rowId(i));
    const allSelected =
      allIds.length > 0 && allIds.every((id) => this.selectedIds.has(id));
    this.selectedIds = allSelected ? new Set() : new Set(allIds);
    this.fireCustomEvent(CustomEventType.SelectionChange, {
      ids: Array.from(this.selectedIds)
    });
  }

  /** Run a non-label bulk action. With an `actionEndpoint` set, POST
   * the action server-side (form-encoded to match smartmin's
   * `BulkActionMixin`), then re-fetch the current page so the user
   * stays where they were — rather than letting the host trigger a
   * full SPA page replacement that drops them back to page 1. With
   * no `actionEndpoint`, just fire the event for the host to
   * handle. Destructive actions can carry a `confirm` string for a
   * window.confirm() prompt (text comes from the host so it can be
   * localized). The event fires after the POST/refresh so a host
   * sidebar can refresh counts when notified. */
  private async handleBulkAction(action: ContentListBulkAction): Promise<void> {
    if (action.confirm && !window.confirm(action.confirm)) return;

    const ids = Array.from(this.selectedIds);

    if (this.actionEndpoint && !action.clientOnly) {
      const params = new URLSearchParams();
      params.append('action', action.key);
      ids.forEach((id) => params.append('objects', id));
      try {
        await postUrl(this.actionEndpoint, params);
        // Re-request the current page so a filtered view (e.g.
        // archive removes rows from inbox) drops the acted-on rows,
        // staying on the user's page rather than resetting to one.
        await this.fetchPage(this.currentUrl || undefined);
        // Drop selection for any ids the server filtered out of the
        // refreshed view; survivors stay selected.
        this.recheckSelection(ids);
        // Only fire after the server confirms — a failed POST
        // shouldn't trigger consumers to refresh based on a
        // non-event.
        this.fireCustomEvent(CustomEventType.BulkAction, {
          action: action.key,
          ids
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('bulk action POST failed', err);
      }
    } else {
      // No server round-trip — leave the action entirely up to the
      // host and let it know.
      this.fireCustomEvent(CustomEventType.BulkAction, {
        action: action.key,
        ids
      });
    }
  }

  private handlePage(delta: number): void {
    // One page step at a time: while a fetch is in flight the buttons
    // render disabled, but guard here too so a click that lands before
    // the re-render can't fire a second request — in cursor mode it
    // would re-follow the same stale next/previous URL and land on the
    // wrong slice.
    if (this.loading) return;
    // A cursor list has no page numbers — step by following the
    // opaque next/previous URL the last response handed back. Call
    // fetchPage first so currentUrl is updated synchronously, then
    // bubble state so the saved URL points at the new view. `page` is
    // deliberately left alone: a cursor slice has no ordinal position
    // to track, and the cursor URL stashed in history.state is what
    // drives restoration.
    if (this.cursorMode) {
      const target = delta > 0 ? this.nextCursor : this.prevCursor;
      if (target) {
        this.fetchPage(target);
        this.writeUrlState();
      }
      return;
    }
    const lastPage = Math.max(1, Math.ceil(this.total / this.pageSize));
    const next = Math.min(lastPage, Math.max(1, this.page + delta));
    if (next !== this.page) {
      this.page = next;
      this.fetchPage();
      this.writeUrlState();
    }
  }

  private renderTitlebar(): TemplateResult {
    const hasSubtitle =
      this.subtitle || this.querySelector('[slot="subtitle"]');
    // The header — title + content menu — is temba-page-header. The
    // list forwards its own title/subtitle slots into it and slots its
    // pager / search into the header's actions area. The bulk actions
    // are NOT here — when rows are selected they overlay the column-
    // header row instead (see renderBulkBar), so the page header stays
    // put rather than swapping its contents.
    return html`
      <temba-page-header
        content-menu-endpoint=${this.contentMenuEndpointWithSearch()}
      >
        <slot name="title" slot="title">${this.listTitle}</slot>
        ${hasSubtitle
          ? html`<slot name="subtitle" slot="subtitle">${this.subtitle}</slot>`
          : null}
        <div slot="actions" class="header-actions">
          ${this.renderPager()}
          ${this.searchable && !this.searchOpen
            ? html`
                <span class="action" @click=${() => this.toggleSearch()}>
                  <temba-icon name=${Icon.search} size="0.95"></temba-icon>
                  ${msg('Search')}
                </span>
              `
            : null}
          <slot name="actions"></slot>
        </div>
      </temba-page-header>
      ${this.searchable && this.searchOpen
        ? html`
            <div class="searchbar">
              <input
                type="text"
                placeholder=${this.searchPlaceholder ??
                this.defaultSearchPlaceholder()}
                .value=${this.searchDraft}
                ?disabled=${this.searching}
                @input=${this.handleSearchInput}
                @keydown=${this.handleSearchKey}
              />
              ${!this.searching && this.searchDraft !== this.search
                ? html`
                    <span class="search-hint">
                      <span class="enter-key">↵</span> ${msg('to search')}
                    </span>
                    <temba-icon
                      class="search-go"
                      name=${Icon.search}
                      size="1.1"
                      clickable
                      title=${msg('Search')}
                      aria-label=${msg('Run search')}
                      @click=${() => this.commitSearch()}
                    ></temba-icon>
                  `
                : null}
              <temba-icon
                class="search-cancel"
                name=${Icon.close}
                size="1.1"
                clickable
                title=${msg('Cancel search')}
                aria-label=${msg('Cancel search')}
                @click=${() => this.toggleSearch()}
              ></temba-icon>
            </div>
          `
        : null}
    `;
  }

  /** True when there's a selection and actions to run on it. */
  private get bulkVisible(): boolean {
    return this.selectedIds.size > 0 && this.bulkActions.length > 0;
  }

  /** The bulk-action bar — overlaid on the column-header row (just
   * right of the select-all checkbox) when rows are selected, rather
   * than replacing the page header. Positioned absolutely in the
   * table-frame so it doesn't scroll horizontally with the columns. */
  private renderBulkBar(): TemplateResult {
    // Actions lead (fixed against the checkbox) and the count trails,
    // right-aligned, so the buttons don't shift as the count's width
    // changes ("1 selected" vs "100 selected").
    return html`
      <div class="bulk-bar ${this.bulkCollapsed ? 'collapsed' : ''}">
        ${this.bulkActions.map((a) => this.renderBulkAction(a))}
        <span class="bulk-count"
          >${msg(str`${formatCount(this.selectedIds.size)} selected`)}</span
        >
      </div>
    `;
  }

  private renderBulkAction(action: ContentListBulkAction): TemplateResult {
    if (action.labelsEndpoint) {
      return this.renderLabelDropdown(action);
    }
    return html`
      <span
        class="bulk-action ${action.destructive ? 'destructive' : ''}"
        title=${action.label}
        @click=${() => this.handleBulkAction(action)}
      >
        ${action.icon
          ? html`<temba-icon name=${action.icon} size="0.9"></temba-icon>`
          : null}
        <span class="bulk-label">${action.label}</span>
      </span>
    `;
  }

  private renderLabelDropdown(action: ContentListBulkAction): TemplateResult {
    // Undefined means the list hasn't been fetched yet (the dropdown
    // fetches lazily on first open); an empty array is a real
    // "no labels exist" state.
    const labels = this.labelsByActionKey[action.key];
    return html`
      <temba-dropdown
        class="label-dropdown"
        @temba-opened=${() => this.handleLabelDropdownOpened(action)}
      >
        <span
          slot="toggle"
          class="bulk-action ${action.destructive ? 'destructive' : ''}"
          title=${action.label}
        >
          ${action.icon
            ? html`<temba-icon name=${action.icon} size="0.9"></temba-icon>`
            : null}
          <span class="bulk-label">${action.label}</span>
        </span>
        <div slot="dropdown" class="label-menu">
          ${!labels
            ? html`<div class="label-menu-empty">${msg('Loading…')}</div>`
            : labels.length === 0 && !action.allowCreate
              ? html`<div class="label-menu-empty">${msg('No labels')}</div>`
              : labels.map((label) => this.renderLabelOption(label, action))}
          ${labels && action.allowCreate
            ? html`<div
                class="lbl-create ${this.pendingLabel !== null
                  ? 'blocked'
                  : ''}"
                @click=${() => this.handleLabelCreate(action)}
              >
                ${msg('New Label…')}
              </div>`
            : null}
        </div>
      </temba-dropdown>
    `;
  }

  /** The dropdown's "New Label…" row — fire the event with the
   * current selection and let the click bubble so the dropdown
   * closes; the host opens its create modal seeded with the ids.
   * Blocked while a toggle POST is in flight, like the label rows. */
  private handleLabelCreate(action: ContentListBulkAction): void {
    if (this.pendingLabel !== null) return;
    this.fireCustomEvent(CustomEventType.LabelCreate, {
      action: action.key,
      ids: Array.from(this.selectedIds)
    });
  }

  private renderLabelOption(
    label: any,
    action: ContentListBulkAction
  ): TemplateResult {
    const state = this.computeLabelState(label.uuid, action.labelsKey);
    const isPending = this.pendingLabel === label.uuid;
    const isBlocked = this.pendingLabel !== null && !isPending;
    return html`
      <div
        class="lbl-menu ${isPending ? 'pending' : ''} ${isBlocked
          ? 'blocked'
          : ''}"
        @click=${(e: MouseEvent) => {
          e.stopPropagation();
          if (this.pendingLabel !== null) return;
          this.toggleLabel(label, state);
        }}
      >
        <temba-checkbox
          size="1.1"
          ?checked=${state === 'all'}
          ?partial=${state === 'some'}
          ?busy=${isPending}
          ?disabled=${isBlocked}
        ></temba-checkbox>
        <span class="lbl-name">${label.name}</span>
      </div>
    `;
  }

  private async handleLabelDropdownOpened(
    action: ContentListBulkAction
  ): Promise<void> {
    if (this.labelsByActionKey[action.key] || !action.labelsEndpoint) return;
    try {
      const response = await getUrl(action.labelsEndpoint);
      const labels = (response.json?.results || [])
        .slice()
        .sort((a: any, b: any) =>
          String(a.name || '').localeCompare(String(b.name || ''))
        );
      this.labelsByActionKey = {
        ...this.labelsByActionKey,
        [action.key]: labels
      };
    } catch (err) {
      // Mark the list as fetched-empty rather than leaving it
      // undefined — otherwise the dropdown shows "Loading…" until
      // it's closed and reopened. A later refresh() clears the cache
      // so a retry still happens.
      this.labelsByActionKey = {
        ...this.labelsByActionKey,
        [action.key]: []
      };
      // eslint-disable-next-line no-console
      console.error('failed to fetch labels', err);
    }
  }

  /** Compute the tri-state across the selected rows for a given
   * label/group uuid: 'all' if every selected row has it, 'some' if
   * at least one but not all do, 'none' otherwise. Membership is read
   * from the `labelsKey` item field (default 'labels'; contacts use
   * 'groups'). */
  private computeLabelState(
    labelUuid: string,
    labelsKey = 'labels'
  ): 'none' | 'some' | 'all' {
    const selected = this.items.filter((item) =>
      this.selectedIds.has(this.rowId(item))
    );
    if (selected.length === 0) return 'none';
    const withLabel = selected.filter((item) =>
      ((item as any)[labelsKey] || []).some((l: any) => l.uuid === labelUuid)
    );
    if (withLabel.length === 0) return 'none';
    if (withLabel.length === selected.length) return 'all';
    return 'some';
  }

  /** Toggle a label across the currently-selected rows. Mirrors
   * rapidpro's `labelObjectRows` semantics: if every selected row
   * already has the label, we're removing; otherwise we're adding.
   *
   * No optimistic local update — if the list is filtered (e.g. a
   * view showing only messages with this label), removing the label
   * means the row no longer belongs in the view, and the only
   * correct thing to do is re-fetch from the server and let the
   * filtered result decide which rows stay. We POST first, then
   * refresh once the server confirms. The `pendingLabel` state
   * blocks further toggles until the round-trip completes. */
  private async toggleLabel(label: any, state: string): Promise<void> {
    if (this.pendingLabel !== null) return;
    const add = state !== 'all';
    const originalSelectedIds = Array.from(this.selectedIds);
    this.pendingLabel = label.uuid;
    try {
      // The dropdown is left open so several labels/groups can be
      // toggled in one pass — each checkbox updates in place as the
      // list re-fetches.
      if (this.actionEndpoint) {
        // application/x-www-form-urlencoded matches what Django's
        // smartmin `BulkActionMixin` reads from `request.POST`, and
        // is trivial to parse server-side (URLSearchParams) without
        // pulling in a multipart parser for the demo mock.
        const params = new URLSearchParams();
        params.append('action', 'label');
        params.append('label', label.uuid);
        if (!add) params.append('add', 'false');
        originalSelectedIds.forEach((id) => params.append('objects', id));
        try {
          await postUrl(this.actionEndpoint, params);
          // Re-fetch the current page so a filtered view (e.g. a
          // label-filter) drops rows that no longer match — staying on
          // the page being acted on rather than resetting to the first.
          await this.fetchPage(this.currentUrl || undefined);
          // Re-check the ids we were operating on. Items that survived
          // the refresh stay selected; items the server filtered out
          // (label removed → no longer matches the view) are absent
          // from `this.items` and won't be re-selected. Mirrors
          // rapidpro's `recheckIds()` after a `spaPost`.
          this.recheckSelection(originalSelectedIds);
          // Only fire after the server confirms — a failed POST
          // shouldn't tell consumers (e.g. a sidebar refreshing
          // counts) that the label actually changed.
          this.fireCustomEvent(CustomEventType.BulkAction, {
            action: 'label',
            ids: originalSelectedIds,
            label: label.uuid,
            add
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('label toggle POST failed', err);
        }
      } else {
        // No server round-trip — the host is fully responsible for the
        // action, so fire so it can react.
        this.fireCustomEvent(CustomEventType.BulkAction, {
          action: 'label',
          ids: originalSelectedIds,
          label: label.uuid,
          add
        });
      }
    } finally {
      // Always release the toggle gate, even if an early return or a
      // throw from a future edit short-circuits the round-trip — the
      // dropdown's other rows must never get permanently wedged.
      this.pendingLabel = null;
    }
  }

  /** Re-apply a selection set against the current `items`. Used
   * after a refresh that follows a bulk action — only ids whose
   * rows are still visible stay selected. */
  private recheckSelection(ids: string[]): void {
    const visible = new Set(this.items.map((i) => this.rowId(i)));
    this.selectedIds = new Set(ids.filter((id) => visible.has(id)));
  }

  private toggleSearch(): void {
    this.searchOpen = !this.searchOpen;
    if (this.searchOpen) {
      // Reopen with the committed query in the input so the user
      // can edit it rather than starting over.
      this.searchDraft = this.search;
      this.updateComplete.then(() => {
        const input = this.shadowRoot?.querySelector(
          '.searchbar input'
        ) as HTMLInputElement | null;
        input?.focus();
      });
    } else if (this.search) {
      // Closing while a search is active is the same as clearing
      // it — keeps the toolbar from misleading once the input is
      // gone (no clear-X to signal the active filter).
      this.clearSearch();
    } else {
      // No committed search, but a draft may have been typed; toss
      // it so reopening starts clean.
      this.searchDraft = '';
    }
  }

  private clearSearch(): void {
    this.searchDraft = '';
    if (!this.search) return;
    this.search = '';
    this.page = 1;
    // fetchPage's `finally` will clear this once the kicked-off
    // request settles, but doing it synchronously here is a UX
    // optimization: "Searching…" disappears the instant the user
    // clears, rather than flickering until the in-flight request
    // resolves.
    this.searching = false;
    // fetchPage first so currentUrl reflects the cleared search before
    // the state bubbles — see commitSearch for the full reasoning.
    // Pushes a new entry so the cleared-search view is its own back
    // step, paired with commitSearch.
    this.fetchPage();
    this.writeUrlState();
  }

  /** Render a status pill — convenience for subclasses. The
   * `kind` keys match the `.status-{kind}` classes defined in
   * ContentList styles (active / pending / stopped / archived /
   * warning / neutral / error). */
  protected renderStatusPill(kind: string, label: string): TemplateResult {
    return html`<span class="status-pill status-${kind}">${label}</span>`;
  }

  /** Optional leading icon name for each row (e.g. the campaign
   * clock-refresh in the styleguide). Override in subclasses;
   * return `null` to skip the leading-icon column entirely. */
  protected getRowIcon(_item: T): string | null {
    return null;
  }

  /** Whether a column is pinned against the left edge. */
  private isLeftPinned(column: ContentListColumn): boolean {
    return column.pinned === true || column.pinned === 'left';
  }

  /** Whether a column is pinned against the right edge. */
  private isRightPinned(column: ContentListColumn): boolean {
    return column.pinned === 'right';
  }

  /** Recompute which leading cells + columns are pinned and assign
   * each a sticky "pin index". Called at the top of render() so the
   * header and rows agree. Left-pinned columns are expected to be
   * contiguous from the first column (the leading checkbox/icon
   * cells pin alongside them so identity stays anchored); right-
   * pinned columns contiguous to the last. */
  private computePinLayout(): void {
    // Whether any row on this page carries a leading icon — probe
    // every row (a page can lead with icon-less rows, e.g. message
    // flows). Rows render their icon inline (no gutter on icon-less
    // rows); this flag just marks the first column's cells as
    // lead-cells for alignment lookups.
    this.reservesIcon = this.items.some(
      (item) => this.getRowIcon(item) !== null
    );
    this.pinIndexByColumn = new Map();
    this.rightPinIndexByColumn = new Map();
    this.checkPinIndex = -1;
    this.lastPinIndex = -1;
    this.firstRightPinIndex = -1;
    this.spacerAfterIndex = -1;

    // Right-pinned columns are contiguous at the end; walk inward
    // from the last column, numbering 0 = rightmost.
    let ridx = 0;
    for (let i = this.columns.length - 1; i >= 0; i--) {
      if (!this.isRightPinned(this.columns[i])) break;
      this.rightPinIndexByColumn.set(this.columns[i], ridx++);
    }
    this.firstRightPinIndex = ridx - 1;

    // Left-pinned columns + the leading checkbox cell. The leading icon
    // rides inside the first column's cell, so it adds no pin slot of
    // its own.
    const leftPinnedCount = this.columns.filter((c) =>
      this.isLeftPinned(c)
    ).length;
    if (leftPinnedCount === 0) return;
    let idx = 0;
    if (this.hasCheckboxes) this.checkPinIndex = idx++;
    this.columns.forEach((c) => {
      if (this.isLeftPinned(c)) this.pinIndexByColumn.set(c, idx++);
    });
    this.lastPinIndex = idx - 1;
    // Left-pinned columns are contiguous from the start, so the last
    // one sits at column index leftPinnedCount - 1; the spacer
    // follows it — unless a `grow` column is present, in which case
    // that column already pools the slack and a spacer would only
    // split it.
    this.spacerAfterIndex = this.columns.some((c) => c.grow)
      ? -1
      : leftPinnedCount - 1;
  }

  /** `pinned` (+ `pin-last` for the rightmost left-pinned cell)
   * class string for a left-pinned leading cell at the given pin
   * index, or '' when unpinned. */
  private pinClass(index: number): string {
    if (index < 0) return '';
    return index === this.lastPinIndex ? 'pinned pin-last' : 'pinned';
  }

  /** Sticky `left` for a left-pinned cell — resolved from a per-
   * index CSS var that {@link measurePinOffsets} sets from the real
   * header cell widths after each render. */
  private pinStyle(index: number): string {
    return index < 0 ? '' : `left: var(--cl-pin-${index}, 0px);`;
  }

  /** Pin class string for a column cell (header or body) — handles
   * both edges: `pin-last` marks the inboard edge of the left group,
   * `pin-first` the inboard edge of the right group. */
  private columnPinClass(column: ContentListColumn): string {
    const left = this.pinIndexByColumn.get(column);
    if (left != null) return this.pinClass(left);
    const right = this.rightPinIndexByColumn.get(column);
    if (right != null) {
      return right === this.firstRightPinIndex
        ? 'pinned pin-right pin-first'
        : 'pinned pin-right';
    }
    return '';
  }

  /** Sticky `left`/`right` style for a column cell, resolved from
   * the per-index CSS vars {@link measurePinOffsets} publishes. */
  private columnPinStyle(column: ContentListColumn): string {
    const left = this.pinIndexByColumn.get(column);
    if (left != null) return `left: var(--cl-pin-${left}, 0px);`;
    const right = this.rightPinIndexByColumn.get(column);
    if (right != null) return `right: var(--cl-rpin-${right}, 0px);`;
    return '';
  }

  /** Width contract for a column's inner wrapper — a hard `width`
   * when set, otherwise optional min/max bounds. With neither bound
   * the column simply sizes to its content (header label or widest
   * value) via the table's auto layout. */
  private cellWidthStyle(column: ContentListColumn): string {
    const savedWidth = this.savedColumnWidth(column);
    // Under fixed layout the column widths are set on the cells
    // themselves (see {@link renderHeaderCell}); the inner wrapper
    // just fills its cell and ellipsis-truncates against it.
    if (this.fixedLayout) return '';
    if (savedWidth != null) return `width: ${savedWidth}px;`;
    if (column.width) return `width: ${column.width};`;
    const parts: string[] = [];
    if (column.minWidth) parts.push(`min-width: ${column.minWidth};`);
    // A grow column drops the upper cap so it can stretch with the
    // table; every other column caps its content-driven width.
    if (!column.grow) parts.push(`max-width: ${column.maxWidth || '320px'};`);
    return parts.join(' ');
  }

  /** Numeric pixel value for a CSS width used by the list's column
   * contracts. Resizable columns use pixel widths because pointer movement
   * is measured in pixels; non-pixel bounds fall back to the defaults. */
  private columnWidthPixels(
    value: string | undefined,
    fallback: number
  ): number {
    if (!value || !value.trim().endsWith('px')) return fallback;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private static readonly MIN_COLUMN_WIDTH = 80;
  private static readonly MAX_COLUMN_WIDTH = 600;

  private clampColumnWidth(
    width: number,
    minWidth = ContentList.MIN_COLUMN_WIDTH
  ): number {
    const floor = Math.min(minWidth, ContentList.MAX_COLUMN_WIDTH);
    return Math.round(
      Math.min(Math.max(width, floor), ContentList.MAX_COLUMN_WIDTH)
    );
  }

  private isColumnResizable(column: ContentListColumn): boolean {
    return column.resizable === true && !column.grow;
  }

  private savedColumnWidth(column: ContentListColumn): number | undefined {
    return this.isColumnResizable(column)
      ? this.columnWidths[column.key]
      : undefined;
  }

  private effectiveColumnWidth(column: ContentListColumn): number {
    return (
      this.savedColumnWidth(column) ??
      this.columnWidthPixels(column.width, ContentList.MIN_COLUMN_WIDTH)
    );
  }

  private minimumColumnWidth(column: ContentListColumn): number {
    return this.columnWidthPixels(
      column.resizeMinWidth ?? column.minWidth,
      ContentList.MIN_COLUMN_WIDTH
    );
  }

  private maximumColumnWidth(column: ContentListColumn): number {
    return this.columnWidthPixels(
      column.maxWidth,
      ContentList.MAX_COLUMN_WIDTH
    );
  }

  private hasPrescribedColumnWidth(column: ContentListColumn): boolean {
    return this.savedColumnWidth(column) != null || column.width != null;
  }

  private hasColumnWidthSlackSink(): boolean {
    return (
      this.columns.some((column) => column.grow) || this.spacerAfterIndex >= 0
    );
  }

  private usesNativeWidthFloor(
    column: ContentListColumn,
    renderedWidth: number,
    prescribedWidth: number
  ): boolean {
    return (
      !this.hasColumnWidthSlackSink() &&
      this.hasPrescribedColumnWidth(column) &&
      renderedWidth > prescribedWidth + 1
    );
  }

  /** Store a user's width separately from the static column definition.
   * This keeps overrides intact when a list rebuilds dynamic columns. */
  private setColumnWidth(
    key: string,
    width: number,
    minWidth = ContentList.MIN_COLUMN_WIDTH
  ): number {
    const nextWidth = this.clampColumnWidth(width, minWidth);
    if (this.columnWidths[key] === nextWidth) return nextWidth;
    this.columnWidths = { ...this.columnWidths, [key]: nextWidth };
    this.requestUpdate();
    return nextWidth;
  }

  private restoreColumnWidth(key: string, width: number | undefined): void {
    if (this.columnWidths[key] === width) return;
    const widths = { ...this.columnWidths };
    if (width == null) delete widths[key];
    else widths[key] = width;
    this.columnWidths = widths;
    this.requestUpdate();
  }

  /** The width contract is carried by the inner wrapper, while the resize
   * handle sits on the outer table-cell boundary. Auto table layout can
   * distribute spare room to that cell, so derive the matching content
   * width from the rendered cell rather than trusting its prescribed width. */
  private renderedColumnWidth(
    header: HTMLElement | null,
    column: ContentListColumn
  ): number {
    if (!header) return this.effectiveColumnWidth(column);
    const style = getComputedStyle(header);
    const padding =
      Number.parseFloat(style.paddingLeft) +
      Number.parseFloat(style.paddingRight);
    const width = header.getBoundingClientRect().width - padding;
    return Number.isFinite(width) && width > 0
      ? width
      : this.effectiveColumnWidth(column);
  }

  private scheduleColumnWidthSave(): void {
    if (!this.settingsEndpoint || !this.historyStateKey) return;
    clearTimeout(this.columnWidthSaveTimeout);
    this.columnWidthSaveTimeout = setTimeout(() => {
      this.columnWidthSaveTimeout = null;
      this.saveColumnWidths();
    }, this.saveDelay);
  }

  private saveColumnWidths(): void {
    if (!this.settingsEndpoint || !this.historyStateKey) return;
    // This posts only the current list's widths, nested under the same
    // historyStateKey used to read them back out of columnWidthSettings.
    // The endpoint must merge list_columns at both the view and column
    // level (as temba's user-settings endpoint does) — replacing it
    // wholesale would wipe the widths saved for every other list.
    postJSON(this.settingsEndpoint, {
      list_columns: {
        [this.historyStateKey]: this.columnWidths
      }
    }).catch(() => {
      // Width persistence is a convenience; a failed save should not
      // interrupt list interaction. A later resize will retry it.
    });
  }

  private startColumnResize(
    event: PointerEvent,
    column: ContentListColumn
  ): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A second pointer should replace, not overlap, an active resize or
    // reorder — both stash the body's selection style, so leaving one
    // running would strand `user-select: none` on the body.
    this.stopColumnResize();
    this.cancelColumnDrag();
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    // Capture the pointer so the drag survives excursions outside the
    // window and its release retargets to the handle — the synthesized
    // click then lands on the handle (which swallows clicks) instead of
    // whichever header happens to be under the pointer.
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // synthetic pointers (tests) have no active pointer to capture
    }
    const header = this.resizeHeaderForHandle(handle);
    const prescribedWidth = this.effectiveColumnWidth(column);
    const startWidth = this.renderedColumnWidth(header, column);
    const resizeFloor = this.minimumRenderedColumnWidth(header, column);
    const nativeFloor = this.usesNativeWidthFloor(
      column,
      startWidth,
      prescribedWidth
    );
    this.columnResize = {
      key: column.key,
      startX: event.clientX,
      startWidth,
      minWidth: nativeFloor ? startWidth : resizeFloor,
      nativeFloor,
      initialSavedWidth: this.columnWidths[column.key],
      changed: false,
      handle
    };
    handle.setAttribute(
      'aria-valuemin',
      `${Math.round(nativeFloor ? startWidth : resizeFloor)}`
    );
    handle.classList.add('resizing');
    this.previousBodyUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    this.toggleAttribute('column-resizing', true);
    window.addEventListener('pointermove', this.handleColumnResizeMove);
    window.addEventListener('pointerup', this.stopColumnResize);
    window.addEventListener('pointercancel', this.stopColumnResize);
  }

  private handleColumnResizeMove = (event: PointerEvent): void => {
    if (!this.columnResize) return;
    event.preventDefault();
    const resize = this.columnResize;
    const requestedWidth = resize.startWidth + event.clientX - resize.startX;
    if (
      resize.nativeFloor &&
      (requestedWidth <= resize.minWidth ||
        resize.minWidth >= ContentList.MAX_COLUMN_WIDTH)
    ) {
      // The table is already rendering wider than the CSS contract. Treat
      // that native allocation as the floor without writing it back: doing
      // so would feed the spare width into the next auto-layout pass and
      // move the boundary even though the user dragged left.
      this.restoreColumnWidth(resize.key, resize.initialSavedWidth);
    } else {
      this.setColumnWidth(resize.key, requestedWidth, resize.minWidth);
    }
    resize.changed = this.columnWidths[resize.key] !== resize.initialSavedWidth;
  };

  private stopColumnResize = (event?: Event): void => {
    if (!this.columnResize) return;
    const { changed, handle } = this.columnResize;
    handle.classList.remove('resizing');
    this.columnResize = undefined;
    document.body.style.userSelect = this.previousBodyUserSelect;
    this.toggleAttribute('column-resizing', false);
    window.removeEventListener('pointermove', this.handleColumnResizeMove);
    window.removeEventListener('pointerup', this.stopColumnResize);
    window.removeEventListener('pointercancel', this.stopColumnResize);
    if (event?.type === 'pointerup') {
      this.suppressHeaderClick = true;
      clearTimeout(this.headerClickSuppressionTimeout);
      this.headerClickSuppressionTimeout = setTimeout(() => {
        this.suppressHeaderClick = false;
        this.headerClickSuppressionTimeout = null;
      }, 0);
    }
    if (changed) this.scheduleColumnWidthSave();
  };

  /** The contiguous run of reorderable columns as [first, last]
   * indexes, or null when fewer than two columns opt in. Mirroring the
   * pinning contract, reorderable columns must be contiguous — drops
   * are constrained to slots inside this run. */
  private reorderableRange(): [number, number] | null {
    const first = this.columns.findIndex((c) => c.reorderable);
    if (first === -1) return null;
    let last = first;
    while (
      last + 1 < this.columns.length &&
      this.columns[last + 1].reorderable
    ) {
      last++;
    }
    return last > first ? [first, last] : null;
  }

  private headerCellForColumn(key: string): HTMLElement | null {
    return this.shadowRoot?.querySelector(
      `th.head-cell[data-key="${CSS.escape(key)}"]`
    );
  }

  private startColumnDrag(
    event: PointerEvent,
    column: ContentListColumn
  ): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (this.columnResize || this.columnDrag) return;
    // No range check here: this only ever runs from the @pointerdown
    // render binds on headers inside the reorderable run.
    const header = event.currentTarget as HTMLElement;
    // No preventDefault and no pointer capture yet — until the pointer
    // clears the dead zone this may still be a plain sort click, which
    // must reach the header untouched.
    this.columnDrag = {
      key: column.key,
      pointerId: event.pointerId,
      startX: event.clientX,
      grabOffsetX: event.clientX - header.getBoundingClientRect().left,
      started: false,
      header
    };
    window.addEventListener('pointermove', this.handleColumnDragMove);
    window.addEventListener('pointerup', this.stopColumnDrag);
    window.addEventListener('pointercancel', this.cancelColumnDrag);
  }

  private handleColumnDragMove = (event: PointerEvent): void => {
    const drag = this.columnDrag;
    if (!drag) return;
    // A second (e.g. touch) pointer must not drive a drag it didn't
    // start.
    if (event.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      if (Math.abs(event.clientX - drag.startX) < ContentList.DRAG_DEAD_ZONE) {
        return;
      }
      drag.started = true;
      // Capture so the drag survives excursions outside the window and
      // the release's synthesized click retargets to the origin header,
      // where the post-drag suppression can consume it.
      try {
        drag.header.setPointerCapture(drag.pointerId);
      } catch {
        // synthetic pointers (tests) have no active pointer to capture
      }
      drag.ghost = this.createColumnDragGhost(drag.header);
      this.draggingColumnKey = drag.key;
      this.previousBodyUserSelectDrag = document.body.style.userSelect;
      document.body.style.userSelect = 'none';
      this.toggleAttribute('column-dragging', true);
    }
    event.preventDefault();
    if (drag.ghost) {
      drag.ghost.style.left = `${event.clientX - drag.grabOffsetX}px`;
    }
    this.columnDropSlot = this.computeColumnDropSlot(event.clientX);
  };

  /** Where a drop at clientX would insert the dragged column: the
   * `columns` index to insert before, clamped to the reorderable run. */
  private computeColumnDropSlot(clientX: number): number {
    const range = this.reorderableRange();
    if (!range) return -1;
    const [first, last] = range;
    let slot = first;
    for (let i = first; i <= last; i++) {
      const header = this.headerCellForColumn(this.columns[i].key);
      if (!header) continue;
      const rect = header.getBoundingClientRect();
      if (clientX > rect.left + rect.width / 2) slot = i + 1;
    }
    return slot;
  }

  private stopColumnDrag = (event?: Event): void => {
    const drag = this.columnDrag;
    if (!drag) return;
    // Ignore the release of any pointer other than the one that started
    // the drag. Teardown paths without an event (disconnect) still run.
    if (event instanceof PointerEvent && event.pointerId !== drag.pointerId) {
      return;
    }
    const slot = this.columnDropSlot;
    this.teardownColumnDrag();
    if (!drag.started) return;
    // The release retargets a synthesized click at the captured origin
    // header; consume it so completing a reorder never also re-sorts.
    if (event?.type === 'pointerup') {
      this.suppressHeaderClick = true;
      clearTimeout(this.headerClickSuppressionTimeout);
      this.headerClickSuppressionTimeout = setTimeout(() => {
        this.suppressHeaderClick = false;
        this.headerClickSuppressionTimeout = null;
      }, 0);
    }
    const from = this.columns.findIndex((c) => c.key === drag.key);
    if (from === -1 || slot < 0) return;
    const to = slot > from ? slot - 1 : slot;
    if (to === from) return;
    const columns = [...this.columns];
    const [moved] = columns.splice(from, 1);
    columns.splice(to, 0, moved);
    this.columns = columns;
    // Its own event type: the generic OrderChanged is a bubbling,
    // composed event whose other producers carry different payloads
    // (`ids`, `swap`), and its listeners would choke on this one.
    this.fireCustomEvent(CustomEventType.ColumnOrderChanged, {
      keys: columns.map((c) => c.key),
      from,
      to
    });
    this.onColumnOrderChanged(columns);
  };

  /** Abandons the drag without committing a drop. Doubles as the
   * pointercancel listener (where it only answers to its own pointer)
   * and as the unconditional cleanup hook for disconnect / resize. */
  private cancelColumnDrag = (event?: Event): void => {
    const drag = this.columnDrag;
    if (!drag) return;
    if (event instanceof PointerEvent && event.pointerId !== drag.pointerId) {
      return;
    }
    this.teardownColumnDrag();
  };

  private teardownColumnDrag(): void {
    const drag = this.columnDrag;
    this.columnDrag = undefined;
    this.columnDropSlot = -1;
    this.draggingColumnKey = '';
    window.removeEventListener('pointermove', this.handleColumnDragMove);
    window.removeEventListener('pointerup', this.stopColumnDrag);
    window.removeEventListener('pointercancel', this.cancelColumnDrag);
    if (drag?.started) {
      document.body.style.userSelect = this.previousBodyUserSelectDrag;
      this.toggleAttribute('column-dragging', false);
    }
    drag?.ghost?.remove();
  }

  /** Called after a header drag commits a new column order. Subclasses
   * persist it (e.g. the contact list saves featured-field priorities). */
  protected onColumnOrderChanged(_columns: ContentListColumn[]): void {}

  /** A floating copy of the header label that tracks the pointer during
   * a reorder. It lives on document.body — outside the shadow root —
   * so every style is inlined, with literal fallbacks for the design
   * tokens in case the host page doesn't define them globally. */
  private createColumnDragGhost(header: HTMLElement): HTMLElement {
    const rect = header.getBoundingClientRect();
    const style = getComputedStyle(header);
    const ghost = document.createElement('div');
    ghost.className = 'column-drag-ghost';
    // Purely decorative — it duplicates the header it was lifted from.
    ghost.setAttribute('aria-hidden', 'true');
    ghost.textContent =
      header.querySelector('.label')?.textContent?.trim() ?? '';
    Object.assign(ghost.style, {
      position: 'fixed',
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      height: `${rect.height}px`,
      minWidth: `${rect.width}px`,
      display: 'flex',
      alignItems: 'center',
      boxSizing: 'border-box',
      padding: '0 8px',
      font: style.font,
      letterSpacing: style.letterSpacing,
      textTransform: style.textTransform,
      color: style.color,
      background: 'var(--surface, #fff)',
      border: '1px solid var(--border, #e4e7ec)',
      borderRadius: 'var(--curvature, 6px)',
      boxShadow: 'var(--shadow-1, 0 2px 6px rgba(0, 0, 0, 0.12))',
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
      zIndex: '10000'
    });
    document.body.appendChild(ghost);
    return ghost;
  }

  /** Arrow keys resize in 10px steps (25px with Shift), providing an
   * accessible equivalent to dragging the separator. */
  private handleColumnResizeKeydown(
    event: KeyboardEvent,
    column: ContentListColumn
  ): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    const header = this.resizeHeaderForHandle(handle);
    const prescribedWidth = this.effectiveColumnWidth(column);
    const currentWidth = this.renderedColumnWidth(header, column);
    const resizeFloor = this.minimumRenderedColumnWidth(header, column);
    const nativeFloor = this.usesNativeWidthFloor(
      column,
      currentWidth,
      prescribedWidth
    );
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    if (
      nativeFloor &&
      (direction < 0 || currentWidth >= ContentList.MAX_COLUMN_WIDTH)
    ) {
      handle.setAttribute('aria-valuenow', `${Math.round(currentWidth)}`);
      return;
    }
    const width = this.setColumnWidth(
      column.key,
      currentWidth + direction * (event.shiftKey ? 25 : 10),
      nativeFloor ? currentWidth : resizeFloor
    );
    handle.setAttribute(
      'aria-valuemin',
      `${Math.round(nativeFloor ? currentWidth : resizeFloor)}`
    );
    handle.setAttribute('aria-valuenow', `${width}`);
    this.scheduleColumnWidthSave();
  }

  /** An auto-sized column has no saved or prescribed width at render
   * time, so the template's aria-valuenow is only a floor. Measure the
   * real rendered width when the separator gains focus so screen
   * readers announce the width the user actually sees. */
  private handleColumnResizeFocus(
    event: FocusEvent,
    column: ContentListColumn
  ): void {
    const handle = event.currentTarget as HTMLElement;
    const header = this.resizeHeaderForHandle(handle);
    handle.setAttribute(
      'aria-valuenow',
      `${Math.round(this.renderedColumnWidth(header, column))}`
    );
  }

  /** Fit the column to the widest rendered header/body value. Cell
   * contents are measured at max-content width without painting a layout
   * change; the configured column bounds keep outliers manageable. */
  private intrinsicWidth(element: HTMLElement): number {
    const previousStyle = element.getAttribute('style');
    element.style.width = 'max-content';
    element.style.minWidth = '0';
    element.style.maxWidth = 'none';
    element.style.position = 'absolute';
    const width = element.getBoundingClientRect().width;
    if (previousStyle == null) element.removeAttribute('style');
    else element.setAttribute('style', previousStyle);
    return width;
  }

  private minimumRenderedColumnWidth(
    header: HTMLElement | null,
    column: ContentListColumn
  ): number {
    const configuredFloor = this.minimumColumnWidth(column);
    const headerInner = header?.querySelector<HTMLElement>('.head-inner');
    return headerInner
      ? Math.max(configuredFloor, this.headerContentWidth(headerInner))
      : configuredFloor;
  }

  private headerContentWidth(headerInner: HTMLElement): number {
    return Math.ceil(
      Array.from(headerInner.children).reduce(
        (width, child) =>
          width + (child as HTMLElement).getBoundingClientRect().width,
        0
      )
    );
  }

  private handleColumnAutoFit(
    event: MouseEvent,
    column: ContentListColumn
  ): void {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    const header = this.resizeHeaderForHandle(handle);
    if (!header) return;

    const widths: number[] = [];
    const headerInner = header.querySelector<HTMLElement>('.head-inner');
    if (headerInner) widths.push(this.headerContentWidth(headerInner));

    const columnIndex = (header as HTMLTableCellElement).cellIndex;
    this.shadowRoot
      ?.querySelectorAll<HTMLTableRowElement>('tr.row')
      .forEach((row) => {
        const cell = row.cells.item(columnIndex);
        const inner = cell?.querySelector<HTMLElement>('.cell-inner');
        if (!inner) return;
        let contentWidth = this.intrinsicWidth(inner);
        const icon = cell.querySelector<HTMLElement>('.lead-icon');
        if (icon) {
          const iconStyle = getComputedStyle(icon);
          contentWidth +=
            icon.offsetWidth + Number.parseFloat(iconStyle.marginRight || '0');
        }
        widths.push(contentWidth);
      });

    const minWidth = this.minimumRenderedColumnWidth(header, column);
    const maxWidth = Math.max(this.maximumColumnWidth(column), minWidth);
    const contentWidth = widths.length ? Math.max(...widths) : minWidth;
    const width = this.setColumnWidth(
      column.key,
      Math.min(Math.max(contentWidth, minWidth), maxWidth),
      minWidth
    );
    handle.setAttribute('aria-valuenow', `${width}`);
    this.scheduleColumnWidthSave();
  }

  /** Leading handles live in the next header so that header owns both
   * clickable halves of the boundary. Pinned and outer-edge handles stay
   * in their own header so they follow that sticky/table boundary. */
  private resizeHeaderForHandle(handle: HTMLElement): HTMLElement | null {
    const host = handle.parentElement;
    return handle.classList.contains('leading')
      ? (host?.previousElementSibling as HTMLElement | null)
      : host;
  }

  /** Measure the header's pinned cells and publish a cumulative
   * `left` offset per pin index as a CSS var on the host. Pinned
   * cells (header + body) read these via {@link pinStyle}. Pinned
   * columns size to content, so this re-runs after every render. */
  private measurePinOffsets(): void {
    const headRow = this.shadowRoot?.querySelector('tr.header');
    if (!headRow) return;
    const cells = Array.from(headRow.children) as HTMLElement[];
    // Left group — cumulative `left` offset, walking from the start.
    let offset = 0;
    let idx = 0;
    for (const cell of cells) {
      if (!cell.classList.contains('pinned')) break;
      if (cell.classList.contains('pin-right')) break;
      this.style.setProperty(`--cl-pin-${idx}`, `${offset}px`);
      offset += cell.offsetWidth;
      idx++;
    }
    // Right group — cumulative `right` offset, walking from the end.
    let roffset = 0;
    let ridx = 0;
    for (let i = cells.length - 1; i >= 0; i--) {
      if (!cells[i].classList.contains('pin-right')) break;
      this.style.setProperty(`--cl-rpin-${ridx}`, `${roffset}px`);
      roffset += cells[i].offsetWidth;
      ridx++;
    }
    // Total width of the right-pinned group — the scroll gradient
    // is inset by this so it lands just left of the frozen columns.
    this.style.setProperty('--cl-rpin-total', `${roffset}px`);
  }

  /** Refresh the horizontal-scroll affordances — whether the table
   * overflows at all (`overflowing`, which gates the pinned-column
   * tint + divider), the pinned-column divider shadow (table
   * scrolled off its start) and the right-edge fade (more table
   * hidden to the right). These are purely presentational, so the
   * classes are toggled straight on the frame rather than through
   * reactive state — that keeps a scroll (or a post-render
   * re-measure) from scheduling another render. */
  private syncScrollAffordance(): void {
    const frame = this.shadowRoot?.querySelector(
      '.table-frame'
    ) as HTMLElement | null;
    const scroller = this.shadowRoot?.querySelector(
      '.table-scroll'
    ) as HTMLElement | null;
    if (!frame || !scroller) return;
    const maxScroll = scroller.scrollWidth - scroller.clientWidth;
    // Below a 1px slack the table fits and there is nothing to
    // scroll — the pinned columns then read as plain columns.
    frame.classList.toggle('overflowing', maxScroll > 1);
    frame.classList.toggle('scrolled', scroller.scrollLeft > 1);
    frame.classList.toggle(
      'can-scroll-right',
      scroller.scrollLeft < maxScroll - 1
    );
    // Vertical scroll lifts the sticky header above the rows passing
    // under it with the same soft drop shadow the pinned columns use.
    frame.classList.toggle('scrolled-down', scroller.scrollTop > 1);
    // The vertical scrollbar's width (0 for overlay scrollbars) pulls
    // the right-edge scroll gradient inboard so it never paints over
    // the scrollbar track.
    this.style.setProperty(
      '--cl-scrollbar-w',
      `${scroller.offsetWidth - scroller.clientWidth}px`
    );
    // Height of the visible rows — the lesser of the table's own height
    // and the visible area (clientHeight already excludes the horizontal
    // scrollbar). The right-edge scroll gradient is sized to this so it
    // stops at the bottom of the rows rather than running down the empty
    // space below a short table.
    const table = scroller.querySelector('table') as HTMLElement | null;
    const rowsHeight = table
      ? Math.min(scroller.clientHeight, table.offsetHeight)
      : scroller.clientHeight;
    this.style.setProperty('--cl-rows-height', `${rowsHeight}px`);
    // Header height positions the header's scroll shadow just below it.
    const headerRow = scroller.querySelector('tr.header') as HTMLElement | null;
    if (headerRow) {
      this.style.setProperty(
        '--cl-header-height',
        `${headerRow.offsetHeight}px`
      );
    }
    // Left edge of the row's leading content — the bulk-action bar's
    // first chip aligns here. That's the row icon when there is one
    // (e.g. the contact silhouette) and otherwise the first column's
    // text (e.g. the message contact), so the actions line up with the
    // row content rather than the checkbox cell.
    const frameRect = frame.getBoundingClientRect();
    const lead =
      (scroller.querySelector(
        'tr.row td.lead-cell .lead-icon'
      ) as HTMLElement | null) ||
      (scroller.querySelector(
        'tr.row td.cell .cell-inner'
      ) as HTMLElement | null) ||
      (scroller.querySelector(
        'tr.header th.head-cell .head-inner'
      ) as HTMLElement | null);
    if (lead) {
      this.style.setProperty(
        '--cl-firstcol-left',
        `${lead.getBoundingClientRect().left - frameRect.left}px`
      );
    }
  }

  private renderHeader(): TemplateResult {
    const allIds = this.items.map((i) => this.rowId(i));
    const allSelected =
      allIds.length > 0 && allIds.every((id) => this.selectedIds.has(id));
    const someSelected = !allSelected && this.selectedIds.size > 0;
    // Computed once for the whole row rather than per cell — every
    // header cell needs both to resolve its reorder affordances.
    const reorderableRange = this.reorderableRange();
    const dragFromIndex = this.draggingColumnKey
      ? this.columns.findIndex((c) => c.key === this.draggingColumnKey)
      : -1;

    return html`
      <thead>
        <tr class="header">
          ${this.hasCheckboxes
            ? html`
                <th
                  class="check-cell ${this.pinClass(this.checkPinIndex)}"
                  style=${this.pinStyle(this.checkPinIndex)}
                  @click=${() => this.handleSelectAll()}
                >
                  <div class="check-inner">
                    <temba-checkbox
                      size="1.1"
                      ?checked=${allSelected}
                      ?partial=${someSelected}
                    ></temba-checkbox>
                  </div>
                </th>
              `
            : null}
          ${this.columns.map((column, index) => {
            const previousColumn = this.columns[index - 1];
            const leadingResizeColumn =
              previousColumn &&
              !this.isLeftPinned(previousColumn) &&
              !this.isRightPinned(previousColumn) &&
              this.spacerAfterIndex !== index - 1
                ? previousColumn
                : undefined;
            const trailingResize =
              index === this.columns.length - 1 ||
              this.isLeftPinned(column) ||
              this.isRightPinned(column);
            const outerResize = index === this.columns.length - 1;
            return html`${this.renderHeaderCell(
              column,
              index,
              reorderableRange,
              dragFromIndex,
              leadingResizeColumn,
              trailingResize,
              outerResize
            )}${index === this.spacerAfterIndex
              ? html`<th class="spacer">
                  ${!this.isLeftPinned(column) && !this.isRightPinned(column)
                    ? this.renderResizeHandle(column, true)
                    : null}
                </th>`
              : null}`;
          })}
        </tr>
      </thead>
    `;
  }

  private renderResizeHandle(
    column: ContentListColumn | undefined,
    leading: boolean,
    outer = false
  ): TemplateResult | null {
    if (!column || !this.isColumnResizable(column)) return null;
    return html`<span
      class="resize-handle ${leading ? 'leading' : 'trailing'} ${outer
        ? 'outer'
        : ''} ${this.columnResize?.key === column.key ? 'resizing' : ''}"
      role="separator"
      aria-orientation="vertical"
      aria-label=${msg(str`Resize ${column.label ?? column.key} column`)}
      aria-valuemin=${this.minimumColumnWidth(column)}
      aria-valuemax=${ContentList.MAX_COLUMN_WIDTH}
      aria-valuenow=${this.effectiveColumnWidth(column)}
      tabindex="0"
      @pointerdown=${(event: PointerEvent) =>
        this.startColumnResize(event, column)}
      @keydown=${(event: KeyboardEvent) =>
        this.handleColumnResizeKeydown(event, column)}
      @focus=${(event: FocusEvent) =>
        this.handleColumnResizeFocus(event, column)}
      @click=${(event: MouseEvent) => event.stopPropagation()}
      @dblclick=${(event: MouseEvent) =>
        this.handleColumnAutoFit(event, column)}
    ></span>`;
  }

  private renderHeaderCell(
    column: ContentListColumn,
    index: number,
    range: [number, number] | null,
    fromIndex: number,
    leadingResizeColumn?: ContentListColumn,
    trailingResize = false,
    outerResize = false
  ): TemplateResult {
    const active = this.sort === column.key || this.sort === '-' + column.key;
    const desc = this.sort === '-' + column.key;
    // Reorder affordances: a column is only draggable when it sits in
    // the reorderable run of two or more — a stray `reorderable` column
    // outside that run has nowhere to go, so it gets no drag. During a
    // drag the origin header dims and an insertion bar marks the current
    // drop slot — suppressed when the slot would put the column right
    // back where it already is (a no-op drop needs no affordance).
    const reorderable = !!(
      column.reorderable &&
      range &&
      index >= range[0] &&
      index <= range[1]
    );
    const dragging = this.draggingColumnKey === column.key;
    const dropSlot = fromIndex === -1 ? -1 : this.columnDropSlot;
    const noopSlot = dropSlot === fromIndex || dropSlot === fromIndex + 1;
    const dropBefore = !noopSlot && dropSlot === index && reorderable;
    const dropAfter =
      !noopSlot && !!range && dropSlot === range[1] + 1 && index === range[1];
    const cls = `head-cell ${column.align || ''} ${
      column.sortable ? 'sortable' : ''
    } ${active ? 'active' : ''} ${column.grow ? 'grow' : ''} ${
      reorderable ? 'reorderable' : ''
    } ${dragging ? 'dragging' : ''} ${dropBefore ? 'drop-before' : ''} ${
      dropAfter ? 'drop-after' : ''
    } ${this.columnPinClass(column)}`;
    // The sort arrow sits on the inboard side of the label — left of
    // it for right-aligned columns, right of it otherwise — so the
    // label stays flush with the column's values whichever way the
    // column is aligned, with no offset to reconcile. Its slot is a
    // fixed width, reserved even while the arrow is hidden, so the
    // label never shifts when the arrow appears on hover.
    const label = column.tip
      ? html`<temba-tip class="label" text=${column.tip} position="top"
          >${column.label ?? column.key}</temba-tip
        >`
      : html`<span class="label">${column.label ?? column.key}</span>`;
    const slot = column.sortable
      ? html`<span class="sort-slot"
          ><temba-icon
            class="sort-icon"
            name=${active ? (desc ? Icon.sort_down : Icon.sort_up) : Icon.sort}
            size="0.85"
          ></temba-icon
        ></span>`
      : null;
    // Under fixed layout the header row drives the column widths, so
    // each `width`-set column carries its width on the cell itself;
    // the grow column is left unsized to claim the remainder.
    const savedWidth = this.savedColumnWidth(column);
    const widthStyle = this.fixedLayout
      ? savedWidth != null
        ? `width: ${savedWidth}px;`
        : column.width
          ? `width: ${column.width};`
          : ''
      : '';
    return html`
      <th
        class=${cls}
        data-key=${column.key}
        style="${this.columnPinStyle(column)} ${widthStyle}"
        @click=${column.sortable
          ? (event: MouseEvent) => this.handleColumnHeaderClick(event, column)
          : null}
        @pointerdown=${reorderable
          ? (event: PointerEvent) => this.startColumnDrag(event, column)
          : null}
      >
        ${this.renderResizeHandle(leadingResizeColumn, true)}
        <div class="head-inner" style=${this.cellWidthStyle(column)}>
          ${column.align === 'right'
            ? html`${slot}${label}`
            : html`${label}${slot}`}
        </div>
        ${trailingResize
          ? this.renderResizeHandle(column, false, outerResize)
          : null}
      </th>
    `;
  }

  private renderRow(item: T): TemplateResult {
    const id = this.rowId(item);
    const selected = this.selectedIds.has(id);
    return html`
      <tr
        class="row ${this.getRowClass(item)} ${selected
          ? 'selected'
          : ''} ${this.isRowClickable(item) ? 'clickable' : ''}"
        style=${this.getRowStyle(item)}
        @click=${(e: MouseEvent) => this.handleRowClick(item, e)}
      >
        ${this.hasCheckboxes
          ? html`
              <td
                class="check-cell ${this.pinClass(this.checkPinIndex)}"
                style=${this.pinStyle(this.checkPinIndex)}
                @click=${(e: MouseEvent) => {
                  // Cell-level click is the single source of truth
                  // for selection. The inner checkbox has
                  // pointer-events: none so it can't fire a second
                  // toggle on the same click.
                  e.stopPropagation();
                  this.handleRowToggle(item);
                }}
              >
                <div class="check-inner">
                  <temba-checkbox
                    size="1.1"
                    ?checked=${selected}
                  ></temba-checkbox>
                </div>
              </td>
            `
          : null}
        ${this.columns.map((c, i) =>
          i === this.spacerAfterIndex
            ? html`${this.renderBodyCell(item, c, i === 0)}
                <td class="spacer"></td>`
            : this.renderBodyCell(item, c, i === 0)
        )}
      </tr>
    `;
  }

  private renderBodyCell(
    item: T,
    column: ContentListColumn,
    isLead = false
  ): TemplateResult {
    const inner = html`
      <div class="cell-inner" style=${this.cellWidthStyle(column)}>
        ${this.renderCell(item, column)}
      </div>
    `;
    // The first column carries the row's leading icon (when the list
    // reserves one), so its header aligns with the icon rather than the
    // value. A row with no icon renders its value flush at the column
    // edge — the icon is an inline flag on the rows that have one (e.g.
    // voice flows), not a gutter every row indents around.
    const lead = isLead && this.reservesIcon;
    const icon = lead ? this.getRowIcon(item) : null;
    return html`
      <td
        class="cell ${lead ? 'lead-cell' : ''} ${column.align ||
        ''} ${column.grow ? 'grow' : ''} ${this.columnPinClass(column)}"
        style=${this.columnPinStyle(column)}
      >
        ${icon
          ? html`<div class="lead-wrap">
              <span class="lead-icon"
                ><temba-icon name=${icon} size="1"></temba-icon></span
              >${inner}
            </div>`
          : inner}
      </td>
    `;
  }

  /** The pager — chevron paging buttons bracketing a count, for the
   * header's actions cluster. The status (shown whenever the response
   * carried a count) depends on the pagination style: a page-counted
   * list has a real position, so it shows the "N–M of Total" range —
   * with a "matches" suffix when the rows are a search result — while
   * a cursor list has none and shows the plain total from
   * {@link totalLabel} whatever the folder size, so a folder that fits
   * on one page frames its count the same way as one that doesn't.
   * An uncounted cursor list falls back to chevrons only, gated on
   * whether the last response handed back a cursor for that direction.
   * Both buttons disable while a fetch is in flight so a second step
   * can't fire until the first comes back (or fails). Returns nothing
   * when there is neither a page to move to nor a count worth
   * showing. */
  private renderPager(): TemplateResult {
    const lastPage = Math.max(1, Math.ceil(this.total / this.pageSize));
    const first = this.total === 0 ? 0 : (this.page - 1) * this.pageSize + 1;
    // Derive `last` from the rows actually shown rather than page*pageSize,
    // so a short final page reports the true position instead of
    // overshooting the total.
    const last = first === 0 ? 0 : first + this.items.length - 1;
    const atStart = this.cursorMode ? !this.prevCursor : this.page <= 1;
    const atEnd = this.cursorMode ? !this.nextCursor : this.page >= lastPage;
    // Nothing to show: an empty counted list (the .list-state covers it),
    // or an uncounted cursor list with no other page to step to.
    if (this.hasCount ? this.total === 0 : atStart && atEnd) {
      return html``;
    }
    return html`
      <div class="pager">
        <span
          class="page-btn"
          ?disabled=${atStart || this.loading}
          @click=${() => this.handlePage(-1)}
          aria-label=${msg('Previous page')}
        >
          <temba-icon name=${Icon.arrow_left} size="1"></temba-icon>
        </span>
        ${this.hasCount
          ? html`<span class="pager-status"
              >${this.cursorMode
                ? this.totalLabel()
                : this.search
                  ? msg(
                      str`${formatCount(first)}–${formatCount(
                        last
                      )} of ${formatCount(this.total)} matches`
                    )
                  : msg(
                      str`${formatCount(first)}–${formatCount(
                        last
                      )} of ${formatCount(this.total)}`
                    )}</span
            >`
          : null}
        <span
          class="page-btn"
          ?disabled=${atEnd || this.loading}
          @click=${() => this.handlePage(1)}
          aria-label=${msg('Next page')}
        >
          <temba-icon name=${Icon.arrow_right} size="1"></temba-icon>
        </span>
      </div>
    `;
  }

  public render(): TemplateResult {
    // Pin layout depends on the current columns + items, so resolve
    // it once per render before the header and rows are built.
    this.computePinLayout();
    // The empty / loading / searching state is shown over the body area
    // (see .list-state) rather than as a colspan row, so it centers in
    // the visible container instead of the overflowing table width.
    // A query error takes over the empty-table treatment (with its own
    // error styling) in place of the plain "nothing to show" copy.
    const stateError = !this.searching && !this.loading && !!this.searchError;
    const stateMessage = this.searching
      ? msg('Searching…')
      : this.loading && this.items.length === 0
        ? msg('Loading…')
        : stateError
          ? this.searchError
          : this.items.length === 0
            ? (this.emptyMessage ?? this.defaultEmptyMessage())
            : null;
    return html`
      <div class="panel">
        ${this.renderTitlebar()}
        <div class="header-rule"></div>
        <div class="table-frame">
          <div
            class="table-scroll ${stateMessage ? 'no-rows' : ''}"
            @scroll=${() => this.syncScrollAffordance()}
          >
            <table
              class="table ${this.fixedLayout ? 'fixed' : ''}"
              style=${!stateMessage && this.minTableWidth
                ? `min-width: ${this.minTableWidth};`
                : ''}
            >
              ${this.renderHeader()}
              <tbody>
                ${stateMessage
                  ? null
                  : this.items.map((i) => this.renderRow(i))}
              </tbody>
            </table>
          </div>
          ${stateMessage
            ? html`<div class="list-state ${stateError ? 'error' : ''}">
                ${stateError
                  ? html`<span class="state-error">
                      <temba-icon name=${Icon.error} size="1"></temba-icon>
                      ${stateMessage}
                    </span>`
                  : stateMessage}
              </div>`
            : null}
          ${this.bulkVisible ? this.renderBulkBar() : null}
          <div class="header-shadow"></div>
          <div class="scroll-shadow"></div>
        </div>
      </div>
    `;
  }
}
