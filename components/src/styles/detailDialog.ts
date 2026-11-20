import { css } from 'lit';
import {
  buttonChrome,
  buttonChromeActive,
  buttonChromeDestructive,
  buttonChromeDestructiveHover,
  buttonChromeHover
} from './buttonChrome';

/* The detail dialog drawn by renderDetailDialog — a page-like dialog (no
   colored header bar) standing in for an item's read page. The header pins
   to the top with a full-bleed rule and the body scrolls beneath it. */
export const detailDialogStyles = css`
  .detail {
    display: flex;
    flex-direction: column;
  }

  /* uniform padding, with the title vertically centered against the
     action buttons */
  .detail-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 1em;
    border-bottom: 1px solid var(--border, #e4e7ec);
  }

  .detail-title {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .detail-name {
    font-size: 15.5px;
    font-weight: var(--w-semibold, 600);
    color: var(--text-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .detail-subtitle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.9em;
    color: var(--text-3, #7b8593);
  }

  .detail-actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* match the page header's content-menu buttons so the dialog's actions
     read like page actions */
  .menu-button {
    ${buttonChrome}
  }
  .menu-button:hover {
    ${buttonChromeHover}
  }
  .menu-button:active {
    ${buttonChromeActive}
  }
  .menu-button.destructive {
    ${buttonChromeDestructive}
  }
  .menu-button.destructive:hover {
    ${buttonChromeDestructiveHover}
  }

  /* the close (✕) in the header's upper right - the square hover-wash
     button treatment (the pager buttons'), sitting just outboard of the
     action buttons */
  .detail-close {
    flex-shrink: 0;
    margin-left: -4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--r-sm);
    color: var(--text-3, #7b8593);
    cursor: pointer;
    user-select: none;
  }
  .detail-close:hover {
    background: var(--sunken);
    color: var(--text-1);
  }
  .detail-close temba-icon {
    --icon-color: currentColor;
  }

  .detail-body {
    display: flex;
    flex-direction: column;
    gap: 1.25em;
    overflow-y: auto;
    max-height: calc(100vh - 300px);
    padding: 1.25em 1.75em;
  }

  .detail-section-title {
    font-size: 0.75em;
    font-weight: var(--w-semibold, 600);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-3, #7b8593);
  }
`;
