import { css } from 'lit';
import {
  buttonChrome,
  buttonChromeActive,
  buttonChromeCompact,
  buttonChromeHover
} from './buttonChrome';

/* The page chrome shared by the content lists and the pages built like
   them (the field list, the campaign read page): the header bar, its
   actions and search bar, and the card panels below it. */

/* The header as a flush surface bar — full width, the lists' 12px inset,
   no card chrome — for a page that renders temba-page-header outside a
   card panel. */
export const headerPanelStyles = css`
  .header-panel {
    background: var(--surface);
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
  }
`;

/* The row slotted into temba-page-header's actions area, and its built-in
   action buttons (e.g. Search) — bordered text + icon on a transparent
   ground. A host's slotted buttons can match this style or bring their
   own. */
export const headerActionsStyles = css`
  .header-actions {
    display: flex;
    align-items: center;
    gap: 14px;
    color: var(--text-2);
    font-size: 13px;
  }

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
`;

/* Inline search bar drawn by renderSearchbar — slides in below the title
   row when the search action is active. Bare single-line input, no border,
   --sunken background. */
export const searchbarStyles = css`
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
  /* Trailing controls — an optional run-search icon and the close (✕),
     the way out (the header's Search action hides itself while the bar
     is open). The "↵ to search" hint sits just left of the run icon. */
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
  /* Run search is always the primary action when shown — its hover wash
     warms to accent. */
  .searchbar .search-go {
    --icon-color-circle-hover: var(--accent-200);
  }
`;

/* Card panel — the contained-card surface the lists and their sibling
   pages sit on. */
export const panelStyles = css`
  .panel {
    background: var(--surface);
    border-radius: var(--r);
    overflow: hidden;
    box-shadow: var(--shadow-1);
  }
`;
