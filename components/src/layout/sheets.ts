import type { Sheet } from './Sheet';

const SHARED = 'temba-sheet[data-shared]';

let closesOnHistory = false;

/** The sheet shared by links which open in one, over whatever page is showing */
const getSharedSheet = (): Sheet => {
  let sheet = document.querySelector(SHARED) as Sheet;
  if (!sheet) {
    sheet = document.createElement('temba-sheet') as Sheet;
    sheet.setAttribute('data-shared', '');
    document.body.appendChild(sheet);
  }

  // it outlives the page it was opened over, so going back or forward closes it
  if (!closesOnHistory) {
    closesOnHistory = true;
    window.addEventListener('popstate', () =>
      (document.querySelector(SHARED) as Sheet)?.close()
    );
  }
  return sheet;
};

/**
 * A click handler for a link to a view which opens in a sheet elsewhere, e.g.
 * a message's channel logs, to open it in one over the page. The view gives
 * its own header and icon, and the link's label stands in until it loads.
 *
 * The click is the link's alone - it goes no further, so that neither a row
 * the link is in nor the page takes it as its own to navigate with. One asking
 * for a new tab or window is left to the browser, which opens the view as a
 * page of its own.
 */
export const openLinkInSheet = (event: MouseEvent): void => {
  event.stopPropagation();
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
    return;
  }
  const link = event.currentTarget as HTMLAnchorElement;
  event.preventDefault();
  getSharedSheet().showTitled(
    link.getAttribute('href'),
    link.getAttribute('aria-label') || ''
  );
};
