import type { Sheet } from './Sheet';

/** The sheet shared by links which open in one, over whatever page is showing */
const getSharedSheet = (): Sheet => {
  let sheet = document.querySelector('temba-sheet[data-shared]') as Sheet;
  if (!sheet) {
    sheet = document.createElement('temba-sheet') as Sheet;
    sheet.setAttribute('data-shared', '');
    document.body.appendChild(sheet);

    // it outlives the page it was opened over, so going back or forward closes it
    window.addEventListener('popstate', () => sheet.close());
  }
  return sheet;
};

/**
 * A click handler for a link to a view which opens in a sheet elsewhere, e.g.
 * a message's channel logs, to open it in one over the page. The view gives
 * its own header and icon, and the link's label stands in until it loads. A
 * click asking for a new tab or window is left to open the view as a page of
 * its own.
 */
export const openLinkInSheet = (event: MouseEvent): void => {
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
