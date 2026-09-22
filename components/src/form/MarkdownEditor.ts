import { PropertyValues, TemplateResult, css, html } from 'lit';
import { msg } from '@lit/localize';
import { property, state } from 'lit/decorators.js';
import { FieldElement } from './FieldElement';
import { Icon } from '../Icons';
import { Options } from '../display/Options';
import { getSelectionFromRoot } from '../excellent/caret-utils';
import { sessionParser } from '../excellent/helpers';
import { tokenize } from '../excellent/tokenizer';
import {
  EXPRESSION_TOKENS,
  getTokenClass,
  tokenCss
} from '../excellent/token-styles';
import { markdown } from '../markdown';
import { getUrl, postFormData } from '../utils';
import {
  Block,
  blockOf,
  ColumnStyle,
  columnStyle,
  columnStyleText,
  importBlocks,
  isSerializable,
  joinBlocks,
  renderBlock,
  splitBlocks
} from './MarkdownDocument';

/** what the toolbar can do to the document */
type Format =
  | 'bold'
  | 'italic'
  | 'code'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'number'
  | 'quote'
  | 'link'
  | 'columns'
  | 'callout'
  | 'hr';

interface Command {
  format: Format;
  /** shown when there's no icon - the headings, whose levels an icon can't say */
  label: string;
  title: string;
  icon?: Icon;
  /** the markers the same command writes in source mode, where there's nothing rendered to act on */
  prefix: string;
  suffix?: string;
  /** whether the markers go on the front of every line the selection covers */
  lines?: boolean;
}

/**
 * A run of rendered elements that one block turned into, so the block's own markdown can be handed back untouched for
 * as long as nothing in it has been edited. Most blocks render to a single element; a block only becomes several when
 * its markdown holds more than one construct without a blank line between them.
 */
interface Run {
  source: string;
  /** everything after the element this is filed under */
  rest: Element[];
  /** what the run looked like when it was rendered, so an edit to it can be spotted */
  signature: string;
}

interface Caret {
  index: number;
  offset: number;
}

// The document is a flat list of these. Anything else the browser leaves at the top level - a bare text node, or the
// <div> it wraps a new line in - is turned into one of them before the document is read back.
const TOP_LEVEL = new Set([
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'P',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'PRE',
  'HR',
  'TABLE'
]);

/** a block the editor can't write back out, kept exactly as it was authored */
const LOCKED = 'locked';

const EMPTY_BLOCK = '<p><br></p>';

const signatureOf = (elements: Element[]): string =>
  elements
    .map((element) => `${element.tagName}>${element.innerHTML}`)
    .join('|');

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const retag = (element: Element, tag: string): Element => {
  const replacement = document.createElement(tag);
  replacement.append(...element.childNodes);
  element.replaceWith(replacement);
  return replacement;
};

// An image's size and layout live in its url fragment - ![alt](url#size=small&layout=inline) - which is the one part
// of a markdown image reference with room for them. The url itself is untouched: a fragment means nothing to the
// server the image comes from, and a reference without one renders the way it always has.

/** the sizes an image can be capped to, which is everything a fragment is allowed to ask for */
const IMAGE_SIZES = new Set(['small', 'medium', 'large']);

/** how an image can sit in its text - as a block of its own or inline with what's around it */
const IMAGE_LAYOUTS = new Set(['block', 'inline']);

/** what an image's fragment asks for, with anything it can't ask for read as the default */
const imageOptions = (src: string): { size: string; layout: string } => {
  const at = src.indexOf('#');
  const params = new URLSearchParams(at === -1 ? '' : src.substring(at + 1));
  const size = params.get('size') || '';
  const layout = params.get('layout') || '';

  return {
    size: IMAGE_SIZES.has(size) ? size : '',
    layout: IMAGE_LAYOUTS.has(layout) ? layout : ''
  };
};

/** writes size and layout back into the fragment, dropping defaults so an untouched image stays a bare url */
const withImageOptions = (
  src: string,
  size: string,
  layout: string
): string => {
  const at = src.indexOf('#');
  const base = at === -1 ? src : src.substring(0, at);
  const params = new URLSearchParams(at === -1 ? '' : src.substring(at + 1));
  params.delete('size');
  params.delete('layout');

  const parts: string[] = [];
  if (size) {
    parts.push(`size=${size}`);
  }
  if (layout) {
    parts.push(`layout=${layout}`);
  }

  const rest = params.toString();
  if (rest) {
    parts.push(rest);
  }

  return parts.length > 0 ? `${base}#${parts.join('&')}` : base;
};

/** the one piece of markup a cell honors - a newline would end its row, so a break in a cell rides as literal <br> */
const CELL_BREAK = /<br\s*\/?>/i;

/**
 * Turns the literal <br>s in a cell's text into the line breaks they mean. The renderer escapes raw HTML, so they
 * arrive as text; a cell is one line of markdown and this is the only way it can carry a break. Inside cells and
 * nowhere else - everywhere else text that looks like a tag stays text.
 */
const revealBreaks = (cell: Element): boolean => {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  let node: Text;
  while ((node = walker.nextNode() as Text)) {
    if (CELL_BREAK.test(node.textContent)) {
      texts.push(node);
    }
  }

  for (const text of texts) {
    const fragment = document.createDocumentFragment();
    text.textContent.split(CELL_BREAK).forEach((part, index) => {
      if (index > 0) {
        fragment.appendChild(document.createElement('br'));
      }
      if (part) {
        fragment.appendChild(document.createTextNode(part));
      }
    });
    text.replaceWith(fragment);
  }

  return texts.length > 0;
};

/** a layout table is one whose header says nothing - what the Columns button makes, and what the styles hide */
const isLayoutTable = (table: Element): boolean => {
  const head = [...table.querySelectorAll(':scope > thead th')];
  return head.length > 0 && head.every((th) => !th.textContent.trim());
};

const hexToHsl = (color: string): { h: number; s: number; l: number } => {
  let hex = color.replace('#', '');
  if (hex.length === 3 || hex.length === 4) {
    hex = [...hex.substring(0, 3)].map((c) => c + c).join('');
  }
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) {
      h = ((g - b) / d) % 6;
    } else if (max === g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    h = (h * 60 + 360) % 360;
  }

  return { h, s, l };
};

const hslToHex = (h: number, s: number, l: number): string => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [rr, gg, bb] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];

  const channel = (value: number) =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${channel(rr)}${channel(gg)}${channel(bb)}`;
};

/**
 * A readable text color drawn from a cell's own background: a deep shade of the same hue over a light fill, a pale
 * one over a dark fill. Derived rather than stored, so the markdown carries only the one color the author chose -
 * and the server derives the same answer from it.
 */
const textOn = (background: string): string => {
  const { h, s, l } = hexToHsl(background);
  return l > 0.55
    ? hslToHex(h, Math.min(s, 0.55), 0.27)
    : hslToHex(h, Math.min(s, 0.45), 0.95);
};

/** The border a column can ask for, drawn from its own fill the same way its text is - the same hue, stepped a
 * fixed distance from the fill's own lightness so it reads against any fill: gently darker over a light one,
 * deeper still over a dark one, so a dark block sits inside a darker edge. A plain neutral when there's no fill
 * to draw from. */
const borderOn = (background: string): string => {
  if (!background) {
    return '#d0d5dd';
  }
  const { h, s, l } = hexToHsl(background);
  return l > 0.55
    ? hslToHex(h, Math.min(s, 0.5), Math.max(l - 0.16, 0.1))
    : hslToHex(h, Math.min(s, 0.6), Math.max(l - 0.14, 0.05));
};

/** paints a code block with the expression highlighting, rebuilt from its text alone - so it can run again after
 * any edit and settle on the same markup */
const highlightCode = (pre: Element): boolean => {
  const code = pre.querySelector('code') || pre;
  const markup = tokenize(code.textContent, sessionParser)
    .map((token) => {
      const mono = EXPRESSION_TOKENS.has(token.type) ? ' tok-mono' : '';
      return `<span class="${getTokenClass(token)}${mono}">${escapeHtml(
        token.text
      )}</span>`;
    })
    .join('');

  if (code.innerHTML === markup) {
    return false;
  }
  code.innerHTML = markup;
  return true;
};

/**
 * Applies a layout table's column stylesheet. Each header cell's stylesheet arrives as its text when freshly
 * rendered and is moved into a data-style attribute - leaving the header genuinely empty, which is what marks the
 * table as layout in the styles - and the styling itself is realized as a colgroup, where width and background
 * belong to a whole column rather than any one cell. A background is an index into the org's palette, resolved
 * here; an index the palette no longer answers for paints nothing. Idempotent: serialization reads the attributes
 * back out, and a second pass over the same palette rebuilds exactly what the first did.
 */
const decorateTable = (
  table: Element,
  colors: Record<string, string>
): boolean => {
  const head = [...table.querySelectorAll(':scope > thead th')];
  if (head.length === 0) {
    return false;
  }

  // any header cell whose text isn't a stylesheet makes this a data table, with nothing to apply
  const styles: ColumnStyle[] = [];
  for (const th of head) {
    const parsed = columnStyle(
      th.textContent.trim() || th.getAttribute('data-style') || ''
    );
    if (!parsed) {
      return false;
    }
    styles.push(parsed);
  }

  const fills = styles.map((style) =>
    style.background ? colors[style.background] || '' : ''
  );

  let changed = false;

  head.forEach((th, index) => {
    const value = columnStyleText(styles[index]);
    if (th.textContent) {
      th.textContent = '';
      changed = true;
    }
    if ((th.getAttribute('data-style') || '') !== value) {
      if (value) {
        th.setAttribute('data-style', value);
      } else {
        th.removeAttribute('data-style');
      }
      changed = true;
    }
  });

  const markup =
    styles.some((style) => style.width) || fills.some(Boolean)
      ? `<colgroup>${styles
          .map((style, index) => {
            const parts = [
              style.width && `width: ${style.width}`,
              fills[index] && `background: ${fills[index]}`
            ].filter(Boolean);
            return parts.length > 0
              ? `<col style="${parts.join('; ')}">`
              : '<col>';
          })
          .join('')}</colgroup>`
      : '';

  const existing = table.querySelector(':scope > colgroup');
  if ((existing ? existing.outerHTML : '') !== markup) {
    if (existing) {
      existing.remove();
    }
    if (markup) {
      table.insertAdjacentHTML('afterbegin', markup);
    }
    changed = true;
  }

  // a sized column only holds its size in a fixed layout, where the unsized columns share what's left
  const layout = styles.some((style) => style.width)
    ? 'table-layout: fixed; width: 100%'
    : '';
  if ((table.getAttribute('style') || '') !== layout) {
    if (layout) {
      table.setAttribute('style', layout);
    } else {
      table.removeAttribute('style');
    }
    changed = true;
  }

  // What belongs to the cells themselves: padding, and text drawn from the column's own color - a colgroup can
  // paint a background but can't reach the text over it. Any alignment the renderer put on a cell stays.
  for (const row of [...table.querySelectorAll(':scope > tbody > tr')]) {
    [...row.children].forEach((td, index) => {
      const style = styles[index];
      if (!style) {
        return;
      }

      const current = td.getAttribute('style') || '';
      const align = /text-align:\s*(left|center|right)/i.exec(current);
      const value = [
        align && `text-align: ${align[1].toLowerCase()}`,
        style.padding && `padding: ${style.padding}`,
        fills[index] && `color: ${textOn(fills[index])}`,
        style.border && `border: 1px solid ${borderOn(fills[index])}`
      ]
        .filter(Boolean)
        .join('; ');

      if (current !== value) {
        if (value) {
          td.setAttribute('style', value);
        } else {
          td.removeAttribute('style');
        }
        changed = true;
      }
    });
  }

  return changed;
};

/**
 * Dissolves the layout tables in a copied fragment into their contents, each cell a paragraph of its own. Layout
 * never travels on the clipboard - only the words and images do; styling belongs where it was authored. A table
 * with real header text is data and copies as the table it is. Returns whether anything had to be dissolved.
 */
const flattenLayoutTables = (root: Element): boolean => {
  let changed = false;

  for (const table of [...root.querySelectorAll('table')]) {
    // a partial copy can clip the header away entirely - headless is layout too, since data tables keep theirs
    if ([...table.querySelectorAll('th')].some((th) => th.textContent.trim())) {
      continue;
    }

    const parts: Element[] = [];
    for (const cell of [...table.querySelectorAll('td')]) {
      const paragraph = document.createElement('p');
      paragraph.append(...cell.childNodes);
      if (paragraph.childNodes.length > 0) {
        parts.push(paragraph);
      }
    }
    table.replaceWith(...parts);
    changed = true;
  }

  return changed;
};

/** whether an image reference is relative - a key in the org's public storage rather than an address of its own.
 * That's how uploads are written, so an article doesn't bake in wherever storage happens to be served from. */
export const isRelativeImage = (reference: string): boolean =>
  !!reference &&
  !/^[a-z][a-z0-9+.-]*:/i.test(reference) &&
  !reference.startsWith('/') &&
  !reference.startsWith('#');

/** the reference an image was written with - kept beside a relative one while its src carries the resolved
 * address the browser can actually load */
export const imageReference = (img: Element): string =>
  img.getAttribute('data-src') ?? (img.getAttribute('src') || '');

/** writes an image's reference, resolving a relative one against the storage root for display */
const setImageReference = (
  img: Element,
  reference: string,
  storageUrl: string
): void => {
  if (isRelativeImage(reference) && storageUrl) {
    img.setAttribute('data-src', reference);
    img.setAttribute('src', `${storageUrl.replace(/\/+$/, '')}/${reference}`);
  } else {
    img.removeAttribute('data-src');
    img.setAttribute('src', reference);
  }
};

/** applies what an image's fragment asks for as the classes the document styles render, touching nothing else */
const decorateImage = (img: HTMLImageElement): void => {
  const { size, layout } = imageOptions(imageReference(img));

  const classes = [...img.classList].filter(
    (name) => !name.startsWith('size-') && !name.startsWith('layout-')
  );
  if (size) {
    classes.push(`size-${size}`);
  }
  if (layout) {
    classes.push(`layout-${layout}`);
  }

  const value = classes.join(' ');
  if ((img.getAttribute('class') || '') !== value) {
    if (value) {
      img.setAttribute('class', value);
    } else {
      img.removeAttribute('class');
    }
  }
};

/**
 * An editor for markdown that is only ever shown as the article it renders to. Clicking into it puts the caret in the
 * rendered text and edits it there - no part of the document turns into its source at any point, whatever the caret is
 * doing. The one way to see markdown is the toggle, which swaps the whole document for its source.
 *
 * What gets stored is markdown, not rich text, so article bodies stay diffable, portable and cheap to chunk on heading
 * boundaries for search. That constraint is what shapes the implementation: the document is modelled as blocks that
 * hold the markdown they were authored with, and a block is only written back out from what it renders as once it has
 * actually been edited. Open an article, change one paragraph, save, and the diff is that paragraph - everything else
 * comes back byte for byte, including the setext headings, + bullets and hard wrapping that a round trip through an
 * AST would quietly rewrite.
 *
 * Editing itself is the browser's. The whole document is one contenteditable, so selecting across blocks, deleting a
 * range that spans them, select-all, and undo are all native and behave the way they do everywhere else. What this
 * class adds around that is the four things the browser gets wrong or doesn't know about: it tidies up the markup the
 * browser leaves behind (see normalize), it keeps a newline inside a fenced block from splitting it in two, it drives
 * formatting through execCommand so those edits land in the undo stack too, and it reads the result back to markdown.
 *
 * Rendering happens here rather than on the server. It used to go to the server on the grounds that a preview should
 * run the same renderer and the same sanitizing as the published article, so an author couldn't preview something we'd
 * refuse to publish. With rich editing there is no preview: an author is looking at their own draft in their own
 * browser, so the only content they can inject is their own and there's nobody else to injure. Readers still get server
 * rendered, server sanitized HTML, which is where sanitizing belongs. Remarkable is configured to escape rather than
 * pass through raw HTML, so even the author's own markup can't execute here.
 */
/** how a link names another article - by uuid, so the link holds through any retitling */
export const ARTICLE_LINK = 'article:';

/** an article as the articles endpoint lists it - what a link can be pointed at */
export interface ArticleTarget {
  uuid: string;
  title: string;
  status: string;
  parent: string | null;
  depth: number;
}

/** what a link points at for the instant between being made and being emptied - see startLink */
const NEW_LINK = 'about:blank#new';

/** whether what's been typed into the link bar is an address rather than a search: it has a scheme, or reads as a
 * path or a host. A title has none of those. */
export const isAddress = (text: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(text) ||
  text.startsWith('/') ||
  text.startsWith('#') ||
  /^www\./i.test(text) ||
  /^[\w-]+(\.[\w-]+)+(\/|$)/.test(text);

export class MarkdownEditor extends FieldElement {
  static get styles() {
    return css`
      ${super.styles}
      ${tokenCss}

      .container {
        background: var(--color-widget-bg);
        border: 1px solid var(--color-widget-border);
        border-radius: var(--curvature-widget);
        box-shadow: var(--widget-box-shadow);
        transition: all ease-in-out var(--transition-speed);
      }

      .container:focus-within {
        border-color: var(--color-focus);
        background: var(--color-widget-bg-focused);
        box-shadow: var(--widget-box-shadow-focused);
      }

      /* Filling the height it's given rather than growing to its content, with the document scrolling inside the
         editor. That's what lets a dialog be as tall as it wants to be and stay that way - a long article scrolls
         where it's being written instead of pushing the dialog past the bottom of the window. Every wrapper down to
         the document has to pass the height along, which is what the run of flex rules below is for. */
      :host([fill]) {
        display: flex;
        flex: 1 1 auto;
        min-height: 0;
      }

      /* the wrapper renderField puts around the widget - .field normally, anonymous when widget_only - and then
         everything between it and the document */
      :host([fill]) > div,
      :host([fill]) .widget,
      :host([fill]) .container {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
      }

      :host([fill]) .doc-frame,
      :host([fill]) textarea.document {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
      }

      /* the editor is the size of what holds it, so there's no slack for a drag handle to take up */
      :host([fill]) textarea.document {
        resize: none;
      }

      /* The frame around the document is where the overlays live: they're positioned in the document's own
         coordinate space, so when the document scrolls inside the frame they ride the content natively - and
         scroll off screen with it - rather than being chased by listeners. Its own stacking context keeps every
         overlay underneath the sticky chrome as it passes. */
      .doc-frame {
        position: relative;
        z-index: 0;
      }

      .overlays {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }

      .overlays .popover,
      .overlays .image-actions,
      .overlays .link-options {
        pointer-events: auto;
      }

      /* The controls stay put while the article scrolls under them - an article is usually taller than whatever is
         scrolling it, and reaching for a heading shouldn't mean scrolling back to the top for the toolbar. Sticky
         resolves against the nearest scrolling ancestor, which for the editor dialog is the modal body outside this
         shadow root, and against the container otherwise - so the controls leave with the editor rather than riding
         the rest of the page.

         The link bar sticks with the toolbar rather than under it, since it belongs to the command that opened it and
         would otherwise slide away beneath a toolbar that stayed. Both need the container's own background now that
         the document passes behind them, and the top corners rounded so they don't square off the container's. */
      .chrome {
        position: sticky;
        top: 0;
        z-index: 1;
        background: inherit;
        border-radius: var(--curvature-widget) var(--curvature-widget) 0 0;
      }

      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.25em;
        padding: 0.35em 0.5em;
        border-bottom: 1px solid var(--color-widget-border);
      }

      .toolbar > temba-icon,
      .toolbar .format {
        cursor: pointer;
        padding: 0.15em 0.4em;
        border-radius: var(--curvature);
        color: var(--color-text-dark);
        font-size: 0.85em;
        line-height: 1.4;
      }

      /* icon buttons and the text ones (the headings) share a height, so the row reads as one control */
      .toolbar .format {
        display: flex;
        align-items: center;
        min-height: 1.5em;
      }

      .toolbar > temba-icon:hover,
      .toolbar .format:hover {
        background: var(--color-selection);
      }

      /* what the caret is sitting in, so the toolbar reads as the state of the text rather than a row of buttons */
      .toolbar .format.on {
        background: var(--color-selection);
        color: var(--color-primary-dark);
      }

      /* a command with nothing it could do where the caret is - inside a cell, tables can't beget tables */
      .toolbar .format.disabled {
        opacity: 0.12;
        cursor: default;
      }

      .toolbar .format.disabled:hover {
        background: none;
      }

      /* none of it applies to the title or subtitle, which are lines of plain text - so while the caret is in one
         the toolbar goes quiet rather than offering formatting that would have nowhere to go */
      .toolbar.muted > temba-icon,
      .toolbar.muted .format {
        opacity: 0.3;
        pointer-events: none;
      }

      .toolbar .spacer {
        flex-grow: 1;
      }

      /* A small floating editor pinned just above what it acts on - a link's text, a column's cells. It lives in
         the document's own coordinate space, so it scrolls with the article - and under the chrome - like any
         other part of it. */
      .popover {
        position: absolute;
        z-index: 3;
        transform: translateY(-100%);
        display: flex;
        align-items: center;
        gap: 0.4em;
        padding: 0.3em 0.4em;
        background: var(--color-widget-bg);
        border: 1px solid var(--color-widget-border);
        border-radius: var(--curvature);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        font-size: 0.85em;
        /* Sized to its content rather than to the room right of its anchor - being placed near the right edge
           must never squeeze it into wrapping; the clamp shifts the whole thing left instead. Only an editor
           genuinely narrower than the controls makes them wrap. */
        width: max-content;
        max-width: calc(100% - 8px);
        flex-wrap: wrap;
      }

      /* a block at the very top of the article has no room above it, so its popover sits below instead */
      .popover.below {
        transform: none;
      }

      .popover input[type='text'] {
        width: 16em;
        min-width: 0;
        border: 1px solid var(--color-widget-border);
        border-radius: var(--curvature);
        padding: 0.2em 0.4em;
        font-family: inherit;
        font-size: inherit;
        color: var(--color-widget-text);
      }

      .popover .popover-action {
        cursor: pointer;
        color: var(--color-link-primary);
        white-space: nowrap;
      }

      /* The link bar: a card the width of the picker that hangs beneath it, and the card is the field - the box
         inside it draws no border of its own. A mark at its head says what the link is (an address, an article,
         or a search underway), and removing the link is a quiet icon at its foot. */
      .popover.link-popover {
        box-sizing: border-box;
        width: 380px;
        max-width: calc(100% - 8px);
        gap: 2px;
        padding: 3px 5px 3px 10px;
        border-radius: 10px;
        box-shadow:
          0 1px 2px rgba(16, 24, 40, 0.06),
          0 12px 32px -12px rgba(16, 24, 40, 0.25);
      }

      .link-popover .link-kind {
        flex-shrink: 0;
        color: var(--color-text-help);
      }

      .link-popover input[type='text'] {
        flex: 1;
        width: auto;
        min-width: 0;
        padding: 6px 6px;
        border: none;
        background: transparent;
        box-shadow: none;
        outline: none;
        font-size: 13.5px;
        color: var(--color-text-dark);
      }

      .link-popover input[type='text']::placeholder {
        color: var(--color-text-help);
      }

      .link-popover .link-remove {
        flex-shrink: 0;
        padding: 5px;
        border-radius: 6px;
        color: var(--color-text-help);
        cursor: pointer;
      }

      .link-popover .link-remove:hover {
        background: var(--color-selection);
        color: var(--color-text-dark);
      }

      /* The articles a search in the link bar matches, floated under the box as any options list is - it's the
         options control, so it reads and steers like every other list of choices. Roomier than a select's rows:
         each match is a rounded row of its own, inset from the edges and from its neighbours, wide enough to
         carry a title and the section it's filed under side by side. */
      .link-options temba-options {
        --temba-options-font-size: 13.5px;
        --temba-options-option-padding: 4px 12px;
        --temba-options-option-margin: 2px 4px;
        --temba-options-option-radius: 8px;
        --temba-options-option-min-height: 0;
      }

      /* The column whose styling is being edited, traced in dashed blue over the gray guidelines - just that
         column, so in a two column row the other column keeps its gray. */
      .column-ring {
        position: absolute;
        border: 1px dashed var(--color-focus);
        box-sizing: border-box;
        pointer-events: none;
      }

      /* the selection treatment around a clicked image, drawn over it rather than on it */
      .image-ring {
        position: absolute;
        z-index: 2;
        border: 2px solid var(--color-focus);
        border-radius: 3px;
        pointer-events: none;
      }

      /* the image's size controls, floated just inside its top edge */
      .image-actions {
        position: absolute;
        z-index: 3;
        display: flex;
        gap: 4px;
      }

      .image-actions .chip {
        cursor: pointer;
        padding: 2px 9px;
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.55);
        color: #fff;
        font-size: 11px;
        line-height: 1.5;
        white-space: nowrap;
      }

      .image-actions .chip:hover {
        background: rgba(0, 0, 0, 0.75);
      }

      .image-actions .chip.on {
        background: var(--color-primary-dark, #1a5a8a);
      }

      /* the column popover's color choices */
      .popover .swatch {
        position: relative;
        width: 18px;
        height: 18px;
        border-radius: 4px;
        border: 1px solid var(--color-widget-border);
        cursor: pointer;
        box-sizing: border-box;
      }

      .popover .swatch.on {
        outline: 2px solid var(--color-focus);
        outline-offset: 1px;
      }

      /* the no-color choice - blank with a slash, always first, and never the org's to edit or remove */
      .popover .swatch.none {
        background:
          linear-gradient(
            to top right,
            transparent calc(50% - 1px),
            #e05252 calc(50% - 1px),
            #e05252 calc(50% + 1px),
            transparent calc(50% + 1px)
          ),
          var(--color-widget-bg);
      }

      /* The column's padding, one segmented control: its three densities side by side, joined so they read as
         steps of one setting rather than three unrelated buttons. */
      .popover .pad-group {
        display: flex;
        align-items: stretch;
        border: 1px solid var(--color-widget-border);
        border-radius: var(--curvature);
        overflow: hidden;
      }

      .popover .pad {
        cursor: pointer;
        display: flex;
        align-items: center;
        padding: 3px 6px;
        border-radius: var(--curvature);
        color: var(--color-text-dark);
      }

      .popover .pad-group .pad {
        border-radius: 0;
      }

      .popover .pad-group .pad + .pad {
        border-left: 1px solid var(--color-widget-border);
      }

      .popover .pad:hover {
        background: var(--color-selection);
      }

      .popover .pad.on {
        background: var(--color-selection);
        color: var(--color-primary-dark);
      }

      .popover .divider {
        width: 1px;
        align-self: stretch;
        background: var(--color-widget-border);
        margin: 0 0.2em;
      }

      textarea.document {
        display: block;
        width: 100%;
        border: none;
        outline: none;
        margin: 0;
        background: transparent;
        color: var(--color-widget-text);
        font-weight: inherit;
        padding: 0.75em;
        resize: vertical;
        overflow: auto;
        font-family: var(--font-mono);
        font-size: 0.85em;
        line-height: 1.5;
      }

      /* The article as the help site serves it. From here to the guideline rule below is the site's own article
         styling - the .article card and the .doc typography of static/css/article.css, which the help site and the
         blog share, with the site's tokens set on the document - so what the author sees is what a reader gets, down
         to the font and the measure. The two are changed together. The document stands on the site's ground as a
         card of the width the site's article column gives it (its container less the sidebar and the gap between
         them), so lines break where they will on the page rather than running the width of the dialog. */
      .doc-frame {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 24px;
        background: #f7f7f9; /* the site's --ground */
      }

      /* the card: the site's .article, holding the title and then the body as the site's page does */
      .article {
        /* the site's tokens, as helpsite.css sets them on :root (and the blog on its card). The primary color is
           the one a site chooses for itself, and comes in as an attribute that overrides this default - which is
           the site's own default. */
        --primary: #2f6fed;
        --font:
          ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto,
          'Helvetica Neue', Arial, sans-serif;
        --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        --text: #1f2430;
        --text-muted: #6b7280;
        --surface: #ffffff;
        --border: #e6e8ec;
        --radius: 12px;

        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        width: 100%;
        max-width: 692px;
        /* and at least the height of the frame, so a short article is a page rather than a card afloat on the ground */
        flex: 1 0 auto;
        padding: 40px 48px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        color: var(--text);
        font-family: var(--font);
        -webkit-font-smoothing: antialiased;
        cursor: text;
      }

      /* The cover image, when the page slots a file field in for one - a blog post has one, a help article doesn't.
         Drawn as the site's .article > .cover: bleeding to the card's edges at its head, the way the page shows it.
         The slotted input itself is never seen; the cover is the control, and a press on it asks the input for a
         file. */
      .cover {
        position: relative;
        height: 20rem;
        margin: -40px -48px 32px;
        border-radius: var(--radius) var(--radius) 0 0;
        background: #eef0f4 center / cover no-repeat;
        cursor: pointer;
        outline: none;
      }

      .cover.empty {
        background: #f4f5f7;
      }

      .cover:focus-visible {
        box-shadow: inset 0 0 0 2px var(--color-focus);
      }

      /* what a press would do, said only when it's wanted: over an image on hover, and in the middle of an empty
         cover all the time, since an empty cover is nothing but the offer */
      .cover-prompt {
        position: absolute;
        left: 50%;
        bottom: 16px;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
        color: var(--text-muted);
        font-family: var(--font-family);
        font-size: 13px;
        white-space: nowrap;
        opacity: 0;
        transition: opacity var(--transition-speed);
        pointer-events: none;
      }

      .cover:hover .cover-prompt,
      .cover:focus-visible .cover-prompt,
      .cover.empty .cover-prompt {
        opacity: 1;
      }

      .cover.empty .cover-prompt {
        top: 50%;
        bottom: auto;
        transform: translate(-50%, -50%);
      }

      ::slotted([slot='hero']) {
        display: none !important;
      }

      /* The title and subtitle, slotted in as the form's own fields - inputs, so their names, values, lengths and
         errors are the form's business - and drawn as the site's .article > h1 and .subtitle, which is what the
         reader gets. They inherit the card's font and color through the slot. Textareas, so a long one wraps as the
         site's heading does - sized to its text by the editor, so it never scrolls inside itself or shows a grip. */
      ::slotted([slot='title']),
      ::slotted([slot='subtitle']) {
        display: block !important;
        box-sizing: border-box !important;
        width: 100% !important;
        margin: 0 0 24px !important;
        padding: 0 !important;
        border: none !important;
        background: none !important;
        font: inherit !important;
        color: inherit !important;
        outline: none !important;
        resize: none !important;
        overflow: hidden !important;
      }

      ::slotted([slot='title']) {
        font-size: clamp(26px, 3.5vw, 34px) !important;
        font-weight: 700 !important;
        line-height: 1.25 !important;
        letter-spacing: -0.01em !important;
      }

      /* a subtitle hangs close under its title, as on the page */
      .head.with-subtitle ::slotted([slot='title']) {
        margin-bottom: 8px !important;
      }

      ::slotted([slot='subtitle']) {
        font-size: 18px !important;
        line-height: 1.4 !important;
        color: var(--text-muted) !important;
      }

      /* the form's word on any of them, in the app's own voice rather than the article's */
      ::slotted([slot='hero-errors']),
      ::slotted([slot='title-errors']),
      ::slotted([slot='subtitle-errors']) {
        margin: -16px 0 24px;
        font-family: var(--font-family);
        font-size: 0.85em;
        color: var(--color-error);
      }

      .doc {
        flex: 1 0 auto;
        font-size: 16.5px;
        line-height: 1.7;
        cursor: text;
        outline: none;
      }

      .doc > * {
        margin: 0 0 1em;
      }

      .doc > *:last-child {
        margin-bottom: 0;
      }

      /* a body that opens with a heading starts where any body does, rather than a heading's distance below the
         title */
      .doc > *:first-child {
        margin-top: 0;
      }

      .doc h1,
      .doc h2,
      .doc h3,
      .doc h4,
      .doc h5,
      .doc h6 {
        margin-top: 1.6em;
        font-weight: 650;
        line-height: 1.25;
        letter-spacing: -0.01em;
      }

      .doc h1 {
        font-size: 1.5em;
      }

      .doc h2 {
        font-size: 1.3em;
      }

      .doc h3 {
        font-size: 1.12em;
      }

      .doc h4,
      .doc h5,
      .doc h6 {
        font-size: 1em;
      }

      .doc ul,
      .doc ol {
        padding-left: 1.5em;
      }

      .doc li + li {
        margin-top: 0.25em;
      }

      .doc blockquote {
        margin-left: 0;
        padding-left: 1em;
        border-left: 3px solid var(--primary);
        color: var(--text-muted);
      }

      .doc pre {
        font-family: var(--font-mono);
        font-size: 0.85em;
        background: #f4f5f7;
        border-radius: 8px;
        padding: 0.75em 1em;
        white-space: pre-wrap;
        overflow-x: auto;
      }

      .doc pre code {
        background: transparent;
        padding: 0;
        font-size: inherit;
      }

      .doc code {
        font-family: var(--font-mono);
        font-size: 0.88em;
        background: #f4f5f7;
        border-radius: 4px;
        padding: 0.1em 0.35em;
      }

      /* Inline rather than block, which is also what markdown calls an image. A block level image would make the
         browser split the paragraph in two to insert one, leaving the image in a block of its own - so a screenshot
         dropped mid-sentence would land somewhere other than where the caret was. */
      .doc img {
        max-width: 100%;
        height: auto;
        display: inline-block;
        vertical-align: bottom;
        border-radius: 8px;
      }

      /* What the image's own fragment asks for. One value caps both axes, so it's the long side of any aspect
         ratio that lands on it. */
      .doc img.size-small {
        max-width: min(200px, 100%);
        max-height: 200px;
        width: auto;
      }

      .doc img.size-medium {
        max-width: min(400px, 100%);
        max-height: 400px;
        width: auto;
      }

      .doc img.size-large {
        max-width: min(640px, 100%);
        max-height: 640px;
        width: auto;
      }

      .doc img.layout-block {
        display: block;
      }

      .doc img.layout-inline {
        display: inline-block;
      }

      .doc a {
        color: var(--primary);
        text-decoration: none;
      }

      .doc a:hover {
        text-decoration: underline;
      }

      /* a divider is a breath in the article, not the browser's ruled-off box: a hairline that fades out at its
         ends, with room around it */
      .doc hr {
        border: none;
        height: 1px;
        margin: 2em 0;
        background: linear-gradient(
          to right,
          transparent,
          var(--border) 18%,
          var(--border) 82%,
          transparent
        );
      }

      .doc table {
        border-collapse: collapse;
        max-width: 100%;
      }

      .doc th,
      .doc td {
        border: 1px solid var(--border);
        padding: 0.4em 0.7em;
        vertical-align: top;
      }

      .doc th {
        background: #f4f5f7;
        text-align: left;
        font-weight: 600;
      }

      /* A table whose header says nothing is layout rather than data - the two cell row the Columns button inserts,
         for putting a screenshot beside the text that explains it. The header is hidden instead of shown blank, the
         data-table chrome goes away, and the row always spans the full width - the columns share it, sized by
         their content until the author drags them to taste. A table with a real header keeps the bordered look
         of data. */
      .doc table:not(:has(th:not(:empty))) {
        width: 100%;
        table-layout: auto;
      }

      .doc table:not(:has(th:not(:empty))) thead {
        display: none;
      }

      .doc table:not(:has(th:not(:empty))) td {
        border: none;
        padding: 16px;
      }

      /* A link over a column's own color keeps that color rather than the article-wide link blue, which can
         vanish into a tint - the underline is what says it's a link there. The color: in the cell's style is only
         ever the one derived from its column's fill. */
      .doc td[style*='color:'] a {
        color: inherit;
        text-decoration: underline;
      }

      /* Guidelines while the row is editable, so the author can see the cells they're filling. They're editor
         chrome rather than part of the article - the served rendering draws no borders on a layout row - so they
         come and go with the editing itself. */
      .doc[contenteditable='true'] table:not(:has(th:not(:empty))) td {
        border: 1px dashed var(--border);
        /* an empty cell still has to be something the author can click into */
        min-width: 2em;
      }

      /* a block the editor can't write back out - it renders, but it isn't edited here */
      .doc .locked {
        cursor: default;
      }

      .doc .locked.empty {
        display: none;
      }

      .uploading {
        opacity: 0.5;
      }

      .error {
        color: var(--color-error);
        padding: 0 0.75em 0.5em 0.75em;
        font-size: 0.85em;
      }
    `;
  }

  /** where screenshots are uploaded, returning {url} to reference from the markdown */
  @property({ type: String })
  endpoint: string;

  /** The root of the public storage that uploaded images live in. Their references are written relative to it -
   * the storage key alone - so the article holds no address that storage moving would break; this is what turns a
   * reference back into something the browser can show while it's being edited. */
  @property({ type: String, attribute: 'storage-url' })
  storageUrl = '';

  /** Where the org's shared color palette lives - GET {colors: {index: hex}}. It's set in the help site's settings,
   * so it's read here rather than written; articles embed the index, so recoloring an entry there restyles its
   * every use across every article. */
  @property({ type: String, attribute: 'colors-endpoint' })
  colorsEndpoint = '';

  /** Where the helpdesk's articles are listed - GET {results: [{uuid, title, status, parent, depth}]} - so a link
   * to another article can be picked by title. Such a link is written as article:<uuid>, the target's identity
   * rather than its address, and holds through any retitling of either article. */
  @property({ type: String, attribute: 'articles-endpoint' })
  articlesEndpoint = '';

  /** The help site's primary color - what its links and accents are drawn in - so the article is shown in the
   * site's own colors. Unset, it's the color a site has until it picks one. */
  @property({ type: String, attribute: 'primary-color' })
  primaryColor = '';

  @property({ type: String })
  accept = 'image/gif,image/jpeg,image/png,image/webp';

  /** The cover image the post has now, when the page slots a file field in for one - shown at the head of the
   * card until a new file is picked, which is then shown in its place. */
  @property({ type: String })
  hero = '';

  @property({ type: Number })
  minHeight = 320;

  /** Fills the height of whatever holds the editor and scrolls the document inside it, rather than growing to fit
   * the article. Leaves `minHeight` to the container, which is now the one being sized. */
  @property({ type: Boolean, reflect: true })
  fill = false;

  /** shows the whole document as raw markdown instead of rendering it */
  @property({ type: Boolean, attribute: 'source_mode' })
  sourceMode = false;

  @property({ type: Boolean })
  uploading = false;

  @property({ type: String })
  error = '';

  /** which toolbar commands describe what the caret is sitting in */
  @state()
  private active: string[] = [];

  /** whether the caret is in the slotted title or subtitle, where none of the toolbar applies */
  @state()
  private inHead = false;

  /** whether the page slotted a subtitle in under the title, and a file field in for a cover image */
  @state()
  private hasSubtitle = false;

  @state()
  private hasHero = false;

  /** the cover image picked but not yet saved, as an object url of the file - what's shown once one is picked */
  @state()
  private heroPreview = '';

  private headSizer: ResizeObserver = null;

  /** whether the caret (or a selected image) is inside a table cell, where a new table can't go */
  @state()
  private inCell = false;

  /** whether that cell is a single column block, where the Columns command grows a second column instead */
  @state()
  private inCallout = false;

  /** the link under the caret, so it can be edited without ever showing its markdown. null when there isn't one. */
  @state()
  private linkHref: string = null;

  /** the other articles a link can point at, by title - fetched once from articlesEndpoint */
  @state()
  private articles: ArticleTarget[] = [];

  /** what's been typed into the link bar to find an article by, while it isn't an address - null when nothing has */
  @state()
  private linkQuery: string = null;

  /** the image the author clicked, ringed and offered its size controls. null when none is picked. */
  @state()
  private image: HTMLImageElement = null;

  /** the layout column the author clicked, as the cell they clicked in. null when none is picked. */
  @state()
  private column: HTMLTableCellElement = null;

  /** the org's palette, index to hex - what the backgrounds articles embed resolve against */
  @state()
  private colors: Record<string, string> = {};

  /** the column edge the pointer is hovering, ready to be dragged */
  private resizeHover: { table: Element; index: number } = null;

  /** a column resize in flight */
  private resizing: {
    table: Element;
    index: number;
    startX: number;
    startWidth: number;
    tableWidth: number;
  } = null;

  /** the document's blocks, which together are always exactly the value */
  private blocks: Block[] = [];

  private runs = new WeakMap<Element, Run>();
  private trailers = new WeakMap<Element, string>();

  /** whatever followed the last block, so a document that ended with a newline still does */
  private tail = '';

  /** whether the rendered document still has to be built from the blocks */
  private stale = true;

  /** where the caret last was inside the document. Picking a file blurs it - the dialog takes the window - so this is
   * the ordinary case for a screenshot, not an edge one. */
  private saved: Range = null;

  private anchor: HTMLAnchorElement = null;

  /** whether the edit now happening is replacing the whole document, which decides what's left of it afterwards */
  private replacing = false;

  private get commands(): Command[] {
    return [
      {
        format: 'bold',
        label: 'B',
        title: msg('Bold'),
        icon: Icon.bold,
        prefix: '**'
      },
      {
        format: 'italic',
        label: 'I',
        title: msg('Italic'),
        icon: Icon.italic,
        prefix: '_'
      },
      {
        format: 'h1',
        label: 'H1',
        title: msg('Heading 1'),
        prefix: '# ',
        lines: true
      },
      {
        format: 'h2',
        label: 'H2',
        title: msg('Heading 2'),
        prefix: '## ',
        lines: true
      },
      {
        format: 'h3',
        label: 'H3',
        title: msg('Heading 3'),
        prefix: '### ',
        lines: true
      },
      {
        format: 'bullet',
        label: 'List',
        title: msg('Bulleted list'),
        icon: Icon.list,
        prefix: '* ',
        lines: true
      },
      {
        format: 'number',
        label: '1.',
        title: msg('Numbered list'),
        prefix: '1. ',
        lines: true
      },
      {
        format: 'quote',
        label: 'Quote',
        title: msg('Quote'),
        icon: Icon.quote,
        prefix: '> ',
        lines: true
      },
      {
        format: 'code',
        label: 'Code',
        title: msg('Code'),
        icon: Icon.code,
        prefix: '`'
      },
      {
        format: 'link',
        label: 'Link',
        title: msg('Link'),
        icon: Icon.hyperlink,
        prefix: '[',
        suffix: ']()'
      },
      {
        format: 'columns',
        label: 'Columns',
        title: msg('Side by side columns'),
        icon: Icon.columns,
        prefix: ''
      },
      {
        format: 'callout',
        label: 'Style',
        title: msg('Style text'),
        icon: Icon.palette,
        prefix: ''
      },
      {
        format: 'hr',
        label: '—',
        title: msg('Divider'),
        icon: Icon.divider,
        prefix: ''
      }
    ];
  }

  /** the whole document textarea, only present in source mode */
  public get textArea(): HTMLTextAreaElement {
    return this.shadowRoot?.querySelector('textarea.document');
  }

  /** the rendered document, only present in rich mode */
  public get doc(): HTMLElement {
    return this.shadowRoot?.querySelector('.doc');
  }

  public connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('selectionchange', this.handleSelectionChange);
    // The overlays live in the document's own coordinate space, so scrolling needs no help - but a window resize
    // reflows the article under them.
    window.addEventListener('resize', this.handleViewportChange);

    // The title and subtitle wrap to the card's width, so they're sized whenever that settles - which is also the
    // first moment they can be measured at all, since the dialog around them is laid out only once it's shown.
    this.headSizer = new ResizeObserver(() => this.sizeHead());
    this.headSizer.observe(this);
    this.syncSlots();
  }

  public disconnectedCallback(): void {
    this.headSizer?.disconnect();
    this.headSizer = null;
    this.setHeroPreview('');
    document.removeEventListener('selectionchange', this.handleSelectionChange);
    window.removeEventListener('resize', this.handleViewportChange);
    document.removeEventListener('mousemove', this.handleResizeMove);
    document.removeEventListener('mouseup', this.handleResizeEnd);
    this.resizing = null;
    super.disconnectedCallback();
  }

  private handleViewportChange = (): void => {
    if (this.image || this.column || this.linkHref !== null) {
      this.requestUpdate();
    }
  };

  protected willUpdate(changes: PropertyValues): void {
    super.willUpdate(changes);

    if (changes.has('colorsEndpoint') && this.colorsEndpoint) {
      this.fetchColors();
    }

    if (changes.has('articlesEndpoint') && this.articlesEndpoint) {
      this.fetchArticles();
    }

    if (!changes.has('value') && !changes.has('sourceMode')) {
      return;
    }

    // Rebuild the blocks unless the value is the one they just serialized to - an edit has already updated them, and
    // rebuilding would throw away the document the caret is sitting in. Comparing rather than flagging means a value
    // set from outside is always picked up, including one that arrives while an edit is in flight. Switching modes
    // always re-reads, which is what keeps the two views in step.
    if (
      changes.has('sourceMode') ||
      this.blocks.length === 0 ||
      joinBlocks(this.blocks) !== (this.value || '')
    ) {
      this.blocks = splitBlocks(this.value || '');
      this.tail = this.blocks[this.blocks.length - 1].trailer;
      this.stale = true;
    }
  }

  public updated(changes: Map<string, any>): void {
    // The link bar's options list hangs from the bar, which is only there once the bar is: anchored on its left
    // edge and as wide as it is, less the list's own border, so the two read as one control.
    const options = this.shadowRoot.querySelector(
      '.link-options temba-options'
    ) as Options;
    if (options) {
      const bar = this.shadowRoot.querySelector('.link-popover') as HTMLElement;
      if (options.anchorTo !== bar) {
        options.anchorTo = bar;
      }
      const width = bar ? Math.round(bar.getBoundingClientRect().width) - 2 : 0;
      if (width > 0 && options.staticWidth !== width) {
        options.staticWidth = width;
      }
    }
    super.updated(changes);

    if (this.stale && !this.sourceMode && this.doc) {
      this.populate();
      this.stale = false;
    }

    // once now, and once next frame - the icons inside a popover are components of their own that fill in just
    // after this update, and a popover only overflows once they've taken their width
    this.clampPopovers();
    requestAnimationFrame(() => this.clampPopovers());
  }

  /**
   * Pulls any popover that would poke past the article's edges back inside them. Widths aren't known until the
   * popover is rendered, so this runs after every render - before paint - and nudges with a margin, which the
   * template's own positioning never touches.
   */
  private clampPopovers(): void {
    const layer = this.shadowRoot?.querySelector('.overlays');
    if (!layer) {
      return;
    }

    const bounds = layer.getBoundingClientRect();
    for (const popover of [
      ...layer.querySelectorAll('.popover')
    ] as HTMLElement[]) {
      const rect = popover.getBoundingClientRect();

      let shift = 0;
      if (rect.right > bounds.right - 4) {
        shift = bounds.right - 4 - rect.right;
      }
      if (rect.left + shift < bounds.left + 4) {
        shift = bounds.left + 4 - rect.left;
      }
      if (shift !== 0) {
        // rewrite left itself - the render just re-anchored it, so this is always a fresh measurement
        popover.style.left = `${rect.left - bounds.left + shift}px`;
      }
    }
  }

  // ==========================================================
  // The rendered document
  // ==========================================================

  /**
   * Renders the blocks into the document and files each one under the elements it produced, so that reading the
   * document back can tell an edited block from one that only got rendered.
   */
  private populate(): void {
    const doc = this.doc;
    const scratch = document.createElement('div');
    const parts: string[] = [];
    const counts: number[] = [];

    for (const block of this.blocks) {
      const rendered = renderBlock(block.source);
      scratch.innerHTML = rendered;

      const elements = [...scratch.children];

      if (elements.length === 0) {
        // A blank block is where an empty article starts, so it has to be a paragraph the caret can go in. A block
        // that has content but renders to nothing - a link reference definition - is held onto invisibly instead,
        // since there's nothing to show and dropping it would lose it.
        parts.push(
          block.source.trim()
            ? `<div class="${LOCKED} empty" contenteditable="false"></div>`
            : EMPTY_BLOCK
        );
        counts.push(1);
      } else if (!elements.every(isSerializable)) {
        // Content the serializer can't write back out - a table, or whatever a future renderer starts emitting - is
        // rendered inside one element that can't be edited, so it survives a save exactly as it was authored.
        parts.push(
          `<div class="${LOCKED}" contenteditable="false">${rendered}</div>`
        );
        counts.push(1);
      } else {
        parts.push(rendered);
        counts.push(elements.length);
      }
    }

    doc.innerHTML = parts.join('');

    // the renderer separates blocks with newlines, and at the top level those are formatting rather than content -
    // left there they'd each become a paragraph of their own the first time the document was tidied up
    for (const node of [...doc.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) {
        node.remove();
      }
    }

    // Sizing classes go on before the blocks are filed, so a decorated image is part of what its block rendered as
    // rather than an edit to it - and cell breaks and column stylesheets are realized here for the same reason.
    for (const img of [...doc.querySelectorAll('img')]) {
      // a relative reference is shown from storage but kept as written, so reading the document back leaves it
      setImageReference(img, imageReference(img), this.storageUrl);
      decorateImage(img as HTMLImageElement);
    }
    for (const cell of [...doc.querySelectorAll('td, th')]) {
      revealBreaks(cell);
    }
    for (const table of [...doc.querySelectorAll('table')]) {
      decorateTable(table, this.colors);
    }
    for (const pre of [...doc.querySelectorAll('pre')]) {
      if (!pre.closest(`.${LOCKED}`)) {
        highlightCode(pre);
      }
    }

    const children = [...doc.children];
    let at = 0;

    this.runs = new WeakMap();
    this.trailers = new WeakMap();

    this.blocks.forEach((block, index) => {
      const elements = children.slice(at, at + counts[index]);
      at += counts[index];

      if (elements.length > 0) {
        this.runs.set(elements[0], {
          source: block.source,
          rest: elements.slice(1),
          signature: signatureOf(elements)
        });
        this.trailers.set(elements[elements.length - 1], block.trailer);
      }
    });
  }

  private isLocked(element: Element): boolean {
    return element.classList.contains(LOCKED);
  }

  /**
   * Reads the document back to markdown. A block whose elements are still the ones it was rendered into, unchanged,
   * hands back the markdown it was authored with; only a block that has actually been edited is written out from what
   * it now renders as.
   */
  private serialize(): void {
    const children = [...this.doc.children];
    const blocks: Block[] = [];
    let at = 0;

    while (at < children.length) {
      const first = children[at];
      const run = this.runs.get(first);

      if (this.isLocked(first)) {
        blocks.push({
          source: run ? run.source : '',
          trailer: this.trailers.get(first) || ''
        });
        at += 1;
        continue;
      }

      const elements = run ? [first, ...run.rest] : [first];
      const intact =
        run &&
        at + elements.length <= children.length &&
        elements.every((element, index) => children[at + index] === element) &&
        signatureOf(elements) === run.signature;

      if (intact) {
        blocks.push({
          source: run.source,
          trailer: this.trailers.get(elements[elements.length - 1]) || ''
        });
        at += elements.length;
        continue;
      }

      // Edited, so it gets written out from what it renders as - and filed again, so the next keystroke only has to
      // compare against it rather than serialize the whole block a second time.
      const source = blockOf(first);
      this.runs.set(first, {
        source,
        rest: [],
        signature: signatureOf([first])
      });

      blocks.push({ source, trailer: this.trailers.get(first) || '' });
      at += 1;
    }

    // Only the last block can end without a blank line after it - anywhere else that would run the two blocks either
    // side of the gap together into one.
    blocks.forEach((block, index) => {
      if (index < blocks.length - 1 && !block.trailer) {
        block.trailer = '\n';
      }
    });

    if (blocks.length > 0) {
      blocks[blocks.length - 1].trailer = this.tail;
    }

    this.blocks = blocks;
    this.value = joinBlocks(blocks);
  }

  /**
   * Puts right the markup the browser leaves behind. Editing a contenteditable is the browser's, and what it produces
   * is close to but not quite the flat list of block elements the document is modelled as: a new line after a heading
   * arrives as a <div>, making a list nests the list inside the block it started from, and a paste can drop text in
   * loose at the top level. Each of those is corrected here rather than prevented, so the editing itself stays native.
   *
   * Nothing is touched in the ordinary case, which is what keeps typing cheap - `before` is only called if something
   * actually has to change, and only then does the caret have to be put back.
   */
  private repair(inputType: string, before: () => void): boolean {
    const doc = this.doc;
    let changed = false;

    const change = () => {
      if (!changed) {
        before();
        changed = true;
      }
    };

    for (const node of [...doc.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) {
        change();
        if (node.textContent.trim()) {
          const paragraph = document.createElement('p');
          node.replaceWith(paragraph);
          paragraph.appendChild(node);
        } else {
          node.remove();
        }
        continue;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        change();
        node.remove();
        continue;
      }

      const element = node as Element;
      if (this.isLocked(element)) {
        continue;
      }

      // making a list leaves it nested inside the block it was made from, which is not somewhere a list can live -
      // and an inserted table can land inside a paragraph the same way
      const nested = element.querySelector(
        ':scope > ul, :scope > ol, :scope > table'
      );
      if (
        nested &&
        element.tagName !== 'UL' &&
        element.tagName !== 'OL' &&
        element.tagName !== 'TABLE' &&
        element.childNodes.length === 1
      ) {
        change();
        element.replaceWith(nested);
        continue;
      }

      if (!TOP_LEVEL.has(element.tagName)) {
        change();

        if (element.tagName === 'DIV') {
          // the browser's own wrapper for a new line, which is a paragraph by any other name
          retag(element, 'p');
        } else {
          // Something inline the browser left loose at the top level - an image it decided to put outside the
          // paragraph, say. It's content, so it gets a paragraph to live in; turning it into one would throw it away.
          const paragraph = document.createElement('p');
          element.replaceWith(paragraph);
          paragraph.appendChild(element);
        }
      }
    }

    // Styling the browser applied as markup we don't model - the text is kept, the wrapper isn't. The spans inside
    // a code block are ours: the highlighting, rebuilt below from the text they hold.
    for (const wrapper of [...doc.querySelectorAll('span,font')]) {
      if (wrapper.closest(`.${LOCKED}`) || wrapper.closest('pre')) {
        continue;
      }
      change();
      wrapper.replaceWith(...wrapper.childNodes);
    }

    // and the styles it hangs off what it inserts, which markdown has no way to carry and which would otherwise
    // accumulate on the elements the author edits. Table styles stay: a cell's alignment lives there, put there by
    // the renderer, and a layout table's column styling is realized as styles we wrote ourselves.
    for (const styled of [...doc.querySelectorAll('[style]')]) {
      if (
        styled.closest(`.${LOCKED}`) ||
        styled.tagName === 'TH' ||
        styled.tagName === 'TD' ||
        styled.tagName === 'TABLE' ||
        styled.tagName === 'COL'
      ) {
        continue;
      }
      change();
      styled.removeAttribute('style');
    }

    // Markdown has no nested tables, so a table that lands inside a cell - by the toolbar or a paste - moves out
    // to stand after the table it landed in. Doing it here means the editor never shows a nesting that a save
    // would have flattened anyway.
    let nested: Element;
    while ((nested = doc.querySelector('td table, th table'))) {
      if (nested.closest(`.${LOCKED}`)) {
        break;
      }
      change();
      const host = nested.parentElement.closest('td, th').closest('table');
      host.after(nested);
    }

    // A table that arrived whole - pasted, or dropped in by the Columns button - still carries its stylesheet as
    // header text and its cell breaks as literal text, the same as one freshly rendered from markdown.
    for (const cell of [...doc.querySelectorAll('td, th')]) {
      if (!cell.closest(`.${LOCKED}`) && revealBreaks(cell)) {
        change();
      }
    }
    for (const table of [...doc.querySelectorAll('table')]) {
      if (!table.closest(`.${LOCKED}`) && decorateTable(table, this.colors)) {
        change();
      }
    }

    // the highlighting keeps up with the code as it's typed - rebuilt from the text, the caret put back by offset
    for (const pre of [...doc.querySelectorAll('pre')]) {
      if (!pre.closest(`.${LOCKED}`) && highlightCode(pre)) {
        change();
      }
    }

    // Whatever the last block standing is, it keeps the tag it had - so emptying an article that began with a heading
    // leaves an empty heading, and typing over a select-all writes the new text as one. Neither is what the author
    // asked for: they cleared the article, and what they type next is a paragraph until they say otherwise.
    const emptied =
      !doc.textContent.trim() && !doc.querySelector('img,hr,table,.locked');

    if (
      doc.children.length === 0 ||
      ((this.replacing || inputType.startsWith('delete')) && emptied)
    ) {
      change();
      doc.innerHTML = EMPTY_BLOCK;
    } else if (
      this.replacing &&
      doc.children.length === 1 &&
      doc.children[0].tagName !== 'P' &&
      !this.isLocked(doc.children[0])
    ) {
      change();
      retag(doc.children[0], 'p');
    }

    this.replacing = false;

    return changed;
  }

  // ==========================================================
  // The caret
  // ==========================================================

  private get selection(): Selection {
    return getSelectionFromRoot(this.doc || this);
  }

  private get range(): Range {
    const selection = this.selection;
    const range =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    return range && this.doc && this.doc.contains(range.startContainer)
      ? range
      : null;
  }

  /**
   * Whether the selection covers the whole document, which is what select-all leaves behind.
   *
   * Measured in text rather than by comparing the selection's boundaries against the document's, because the browser
   * normalizes a select-all down to the text nodes at either end - so its start sits inside the first block rather
   * than in front of it, and a boundary comparison says it covers nothing. More than one block has to be in it, so
   * that retyping the whole of a one line heading isn't read as replacing the article.
   */
  private coversDocument(): boolean {
    const range = this.range;
    if (!range || range.collapsed || this.doc.children.length < 2) {
      return false;
    }

    const text = this.doc.textContent;
    return text.length > 0 && range.toString().length >= text.length;
  }

  /** the top level block the caret is in */
  private blockAt(node: Node): Element {
    let at = node;
    while (at && at.parentNode !== this.doc) {
      at = at.parentNode;
    }
    return at && at.nodeType === Node.ELEMENT_NODE ? (at as Element) : null;
  }

  /** where the caret is, as a block and an offset into its text, which survives the markup being rearranged */
  private caretPath(): Caret {
    const range = this.range;
    if (!range) {
      return null;
    }

    const block = this.blockAt(range.startContainer);
    if (!block) {
      return null;
    }

    const measure = document.createRange();
    measure.selectNodeContents(block);
    measure.setEnd(range.startContainer, range.startOffset);

    return {
      index: [...this.doc.children].indexOf(block),
      offset: measure.toString().length
    };
  }

  private restoreCaret(caret: Caret): void {
    const children = [...this.doc.children];
    if (!caret || children.length === 0) {
      return;
    }

    const block = children[Math.min(caret.index, children.length - 1)];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const range = document.createRange();

    let seen = 0;
    let node: Text;
    let placed = false;

    while ((node = walker.nextNode() as Text)) {
      if (seen + node.length >= caret.offset) {
        range.setStart(node, caret.offset - seen);
        placed = true;
        break;
      }
      seen += node.length;
    }

    if (!placed) {
      range.selectNodeContents(block);
      range.collapse(false);
    }

    range.collapse(true);
    this.select(range);
  }

  private select(range: Range): void {
    const selection = this.selection;
    if (!selection) {
      return;
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * Puts the caret in the document if it isn't there already, back where it last was. The toolbar and uploads both
   * need somewhere to write even when nothing is focused.
   */
  private focusDocument(): boolean {
    const doc = this.doc;
    if (!doc || this.disabled) {
      return false;
    }

    // Read where the caret is before focusing, not after: focusing a contenteditable that doesn't have the caret puts
    // one at the very top, which would silently make every toolbar command and every upload act on the first block
    // instead of wherever the author actually was.
    const live = this.shadowRoot.activeElement === doc ? this.range : null;

    doc.focus();

    if (live) {
      return true;
    }

    if (this.saved && doc.contains(this.saved.startContainer)) {
      this.select(this.saved);
      return true;
    }

    const range = document.createRange();
    range.selectNodeContents(doc.lastElementChild || doc);
    range.collapse(false);
    this.select(range);

    return true;
  }

  // ==========================================================
  // Editing
  // ==========================================================

  /** reads the document back and tells anyone listening, after an edit the browser has already made */
  private edited(inputType = ''): void {
    let caret: Caret = null;

    if (this.repair(inputType, () => (caret = this.caretPath()))) {
      this.restoreCaret(caret);
    }

    this.serialize();
    this.fireEvent('change');
  }

  private handleInput(evt: InputEvent): void {
    if (this.sourceMode) {
      this.value = (evt.target as HTMLTextAreaElement).value;
      this.fireEvent('change');
      return;
    }

    this.edited(evt.inputType || '');
  }

  private handleBeforeInput(evt: InputEvent): void {
    // Noted before the edit rather than after, because afterwards there's no telling a select-all that was typed over
    // from an ordinary edit inside the one block that's left.
    this.replacing = this.coversDocument();

    if (
      evt.inputType !== 'insertParagraph' &&
      evt.inputType !== 'insertLineBreak'
    ) {
      return;
    }

    const range = this.range;

    // A cell has no blocks for Enter to split, but it can still break lines - the break goes in by hand, as the
    // <br> its markdown will carry.
    if (this.cellAt(range)) {
      evt.preventDefault();

      range.deleteContents();
      const br = document.createElement('br');
      range.insertNode(br);

      // a break at the very end of a cell isn't rendered, so the caret would have nowhere to sit
      if (!br.nextSibling) {
        br.parentNode.appendChild(document.createElement('br'));
      }

      const after = document.createRange();
      after.setStartAfter(br);
      after.collapse(true);
      this.select(after);

      this.edited(evt.inputType);
      return;
    }

    const block = range && this.blockAt(range.startContainer);

    // A heading is a line, not a mode: Enter at its end starts an ordinary paragraph below it, and Enter at its
    // start pushes an ordinary paragraph in above - the browser's own split would clone the heading both ways,
    // leaving formatting the author never asked for on the new line.
    if (
      block &&
      /^H[1-6]$/.test(block.tagName) &&
      range.collapsed &&
      evt.inputType === 'insertParagraph'
    ) {
      const measure = document.createRange();
      measure.selectNodeContents(block);
      measure.setEnd(range.startContainer, range.startOffset);
      const before = measure.toString().length;
      const total = block.textContent.length;

      if (before === 0 || before === total) {
        evt.preventDefault();

        const paragraph = document.createElement('p');
        paragraph.innerHTML = '<br>';

        if (before === 0 && total > 0) {
          // the heading keeps its text; the new empty line above it is a paragraph
          block.before(paragraph);
        } else {
          block.after(paragraph);
          const inside = document.createRange();
          inside.selectNodeContents(paragraph);
          inside.collapse(true);
          this.select(inside);
        }

        this.edited(evt.inputType);
        return;
      }
    }

    if (!block || block.tagName !== 'PRE') {
      return;
    }

    // A fenced block is one block however many lines it has, but the browser splits it in two on Enter - and so does
    // every execCommand that inserts a break. So the newline goes in by hand.
    evt.preventDefault();

    range.deleteContents();
    const newline = document.createTextNode('\n');
    range.insertNode(newline);

    // a newline at the very end of a <pre> isn't rendered, so the caret would have nowhere to sit
    if (!newline.nextSibling) {
      newline.parentNode.insertBefore(
        document.createTextNode('\n'),
        newline.nextSibling
      );
    }

    const after = document.createRange();
    after.setStartAfter(newline);
    after.collapse(true);
    this.select(after);

    this.edited(evt.inputType);
  }

  private handleKeyDown(evt: KeyboardEvent): void {
    if (evt.key === 'Escape') {
      evt.preventDefault();
      this.doc?.blur();
      return;
    }

    // inside a table, Tab is how the caret gets from one cell to the next
    if (evt.key === 'Tab') {
      const cell = this.cellAt(this.range);
      if (!cell) {
        return;
      }

      evt.preventDefault();

      // only the cells that are visible - a layout table's blank header is hidden, and tabbing into it would put
      // the caret somewhere the author can't see
      const cells = [
        ...cell.closest('table').querySelectorAll('th, td')
      ].filter((candidate) => (candidate as HTMLElement).offsetWidth > 0);

      const next = cells[cells.indexOf(cell) + (evt.shiftKey ? -1 : 1)];
      if (next) {
        const inside = document.createRange();
        inside.selectNodeContents(next);
        inside.collapse(false);
        this.select(inside);
      }
    }
  }

  /** the table cell the caret is sitting in, or null when it isn't in one */
  private cellAt(range: Range): Element {
    const node = range?.startContainer;
    if (!node) {
      return null;
    }
    const element =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    const cell = element?.closest('td, th');
    return cell && this.doc?.contains(cell) ? cell : null;
  }

  /**
   * A click on a link is the author reaching for the text, so it places the caret and never navigates - modifiers
   * included, since a modified click is muscle memory from reading pages and following it would still pull focus
   * from the draft. Where a link goes is read and edited in the link bar the caret summons.
   */
  private handleDocClick(evt: MouseEvent): void {
    const target = evt.target as Element;

    // a click on an image is the way its size gets edited - anywhere else puts the controls away. An image in a
    // locked block stays as authored, so there is nothing to offer it.
    const image =
      target instanceof HTMLImageElement && !target.closest(`.${LOCKED}`)
        ? target
        : null;
    if (image !== this.image) {
      this.image = image;
    }

    // the click is also a real selection, so everything that acts on selected text - columns taking it with them,
    // the palette wrap, typing over it - acts on the image the same way
    if (image) {
      const range = document.createRange();
      range.selectNode(image);
      this.select(range);
    }

    // a click in a layout column offers that column's styling - unless it was the image the click was for
    const cell = image
      ? null
      : (target.closest?.('td') as HTMLTableCellElement);
    const table = cell ? cell.closest('table') : null;
    const column =
      table && isLayoutTable(table) && !cell.closest(`.${LOCKED}`)
        ? cell
        : null;
    if (column !== this.column) {
      this.column = column;
    }

    if (target.closest?.('a')) {
      evt.preventDefault();
    }
  }

  private handleDocBlur(): void {
    const range = this.range;
    if (range) {
      this.saved = range.cloneRange();
    }
  }

  private handleSelectionChange = (): void => {
    if (this.sourceMode || !this.doc) {
      return;
    }

    // what the overlays were editing can be rebuilt out from under them - by an undo, or a value set from outside
    if (this.image && !this.image.isConnected) {
      this.image = null;
    }
    if (this.column && !this.column.isConnected) {
      this.column = null;
    }

    const range = this.range;
    if (!range) {
      return;
    }

    this.saved = range.cloneRange();
    this.refreshActive();
  };

  /** works out what the caret is sitting in so the toolbar can say so */
  private refreshActive(): void {
    const range = this.range;
    const block = range && this.blockAt(range.startContainer);

    const on: string[] = [];

    // a block that isn't edited here has nothing to say about the toolbar, and offering to edit a link inside one
    // would be offering an edit that goes nowhere
    if (block && !this.isLocked(block)) {
      const node =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;

      // Read off the markup rather than from queryCommandState, which answers for the rendered weight and so calls
      // every heading bold - which would light the button up on text that carries no emphasis of its own, and invite
      // a click that writes markup to cancel emphasis that was never there.
      if (node?.closest('strong,b')) {
        on.push('bold');
      }
      if (node?.closest('em,i')) {
        on.push('italic');
      }
      if (node?.closest('code')) {
        on.push('code');
      }
      if (/^H[1-3]$/.test(block.tagName)) {
        on.push(block.tagName.toLowerCase());
      }
      if (block.tagName === 'UL') {
        on.push('bullet');
      }
      if (block.tagName === 'OL') {
        on.push('number');
      }
      if (block.tagName === 'BLOCKQUOTE' || node?.closest('blockquote')) {
        on.push('quote');
      }

      this.anchor = node?.closest('a') as HTMLAnchorElement;
      if (this.anchor) {
        on.push('link');
      }
    } else {
      this.anchor = null;
    }

    // the cell the caret or a selected image is sitting in, and the table that owns it
    const cell =
      (range && this.cellAt(range)) || this.image?.closest('td, th') || null;
    const host = cell ? cell.closest('table') : null;

    // inside a columns row the Columns command is a toggle - lit, and ready to stack the columns back up
    if (
      host &&
      isLayoutTable(host) &&
      host.querySelectorAll(':scope > thead th').length > 1
    ) {
      on.push('columns');
    }

    if (on.join(',') !== this.active.join(',')) {
      this.active = on;
    }

    const href = this.anchor ? this.anchor.getAttribute('href') || '' : null;
    if (href !== this.linkHref) {
      this.linkHref = href;
      this.linkQuery = null;
    }

    // markdown has no tables inside tables, so inside a cell - the caret there, or an image there selected -
    // the commands that make one have nothing they could make
    const inCell = !!cell;
    if (inCell !== this.inCell) {
      this.inCell = inCell;
    }

    const inCallout = !!(
      host &&
      isLayoutTable(host) &&
      host.querySelectorAll(':scope > thead th').length === 1
    );
    if (inCallout !== this.inCallout) {
      this.inCallout = inCallout;
    }
  }

  private exec(command: string, value: string = null): void {
    document.execCommand(command, false, value);
  }

  private async applyFormat(command: Command): Promise<void> {
    if (this.sourceMode) {
      this.applySourceFormat(command);
      return;
    }

    if (!this.focusDocument()) {
      return;
    }

    // markup rather than inline styles, so what comes out is something markdown can say
    this.exec('styleWithCSS', 'false');

    const range = this.range;
    const block = range && this.blockAt(range.startContainer);
    const on = this.active.includes(command.format);

    switch (command.format) {
      case 'bold':
      case 'italic':
        this.exec(command.format);
        break;

      case 'code':
        this.toggleCode(on);
        break;

      case 'h1':
      case 'h2':
      case 'h3':
        this.exec('formatBlock', on ? 'p' : command.format);
        break;

      case 'bullet':
        this.exec('insertUnorderedList');
        break;

      case 'number':
        this.exec('insertOrderedList');
        break;

      case 'quote':
        // a quote is a wrapper rather than a tag on the block, so coming out of one means saying what the block is
        this.exec('formatBlock', on ? 'p' : 'blockquote');
        break;

      case 'link':
        this.startLink(block);
        break;

      case 'columns':
        if (this.active.includes('columns')) {
          this.unwrapColumns();
        } else if (this.inCallout) {
          this.addColumn();
        } else {
          this.insertColumns();
        }
        break;

      case 'callout':
        this.insertCallout();
        break;

      case 'hr':
        this.exec('insertHorizontalRule');
        break;
    }

    this.edited();
    this.refreshActive();

    if (command.format === 'link') {
      await this.updateComplete;
      this.shadowRoot
        ?.querySelector<HTMLInputElement>('.popover input[type="text"]')
        ?.focus();
    }
  }

  private toggleCode(on: boolean): void {
    const range = this.range;
    if (!range) {
      return;
    }

    if (on) {
      const node =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      const code = node?.closest('code');
      if (code) {
        code.replaceWith(...code.childNodes);
      }
      return;
    }

    const selected = range.toString();
    this.exec(
      'insertHTML',
      `<code>${escapeHtml(selected || msg('code'))}</code>`
    );
  }

  private startLink(block: Element): void {
    if (this.anchor) {
      return;
    }

    const range = this.range;
    const selected = range ? range.toString() : '';

    // A new link points nowhere yet: the bar opens empty, so what's typed is a search for an article as readily as
    // an address. createLink wants something to link to, so the placeholder goes in and comes straight back out.
    if (selected) {
      this.exec('createLink', NEW_LINK);
    } else {
      this.exec(
        'insertHTML',
        `<a href="${NEW_LINK}">${escapeHtml(msg('link'))}</a>`
      );
    }

    const anchor = block?.querySelector(`a[href="${NEW_LINK}"]`);
    if (anchor) {
      anchor.setAttribute('href', '');
    }

    // the caret has to be inside the new link for the link bar to find it
    if (anchor) {
      const inside = document.createRange();
      inside.selectNodeContents(anchor);
      inside.collapse(false);
      this.select(inside);
    }
  }

  private handleLinkInput(evt: Event): void {
    const typed = (evt.target as HTMLInputElement).value;
    if (!this.anchor) {
      return;
    }

    // with articles to choose from, anything that isn't an address is a search for one of them by title - the
    // link keeps pointing where it did until one is picked
    if (this.articles.length && !isAddress(typed)) {
      this.linkQuery = typed;
      return;
    }

    this.linkQuery = null;
    this.setLinkHref(typed);
  }

  /** the options control took a pick - by enter, or a click - so the link goes there */
  private handleLinkPick(evt: CustomEvent): void {
    const article = evt.detail?.selected as ArticleTarget;
    if (article) {
      this.linkToArticle(article);
    }
  }

  /** escape in the search gives it up and shows the link as it is */
  private handleLinkCancel(): void {
    this.linkQuery = null;
  }

  private linkToArticle(article: ArticleTarget): void {
    this.linkQuery = null;
    this.setLinkHref(`${ARTICLE_LINK}${article.uuid}`);
  }

  private setLinkHref(href: string): void {
    if (!this.anchor) {
      return;
    }
    this.anchor.setAttribute('href', href);
    this.linkHref = href;
    this.serialize();
    this.fireEvent('change');
  }

  /** the article a link points at, when it's one of ours and we know it */
  private linkedArticle(href: string): ArticleTarget {
    if (!href || !href.toLowerCase().startsWith(ARTICLE_LINK)) {
      return null;
    }
    const uuid = href.substring(ARTICLE_LINK.length).toLowerCase();
    return this.articles.find((a) => a.uuid.toLowerCase() === uuid) || null;
  }

  /** the articles whose titles the search matches, a few at most, sections and all - a section page is a link
   * target too */
  private matchingArticles(): ArticleTarget[] {
    const query = (this.linkQuery || '').trim().toLowerCase();
    if (!query) {
      return [];
    }
    return this.articles
      .filter((a) => a.title.toLowerCase().includes(query))
      .slice(0, 8);
  }

  /** what to call the section an article is filed under, for telling two articles of one title apart */
  private sectionOf(article: ArticleTarget): string {
    const section = article.parent
      ? this.articles.find((a) => a.uuid === article.parent)
      : null;
    return section ? section.title : '';
  }

  private handleLinkRemove(): void {
    const anchor = this.anchor;
    if (!anchor) {
      return;
    }

    this.doc.focus();
    const range = document.createRange();
    range.selectNodeContents(anchor);
    this.select(range);
    this.exec('unlink');

    this.anchor = null;
    this.linkHref = null;
    this.edited();
  }

  /** writes a size choice into the clicked image's fragment, which is the edit the overlay controls make. A layout
   * already in the fragment rides along untouched - columns are how layout is asked for now, but an image that asked
   * the old way keeps what it asked for. */
  private applyImageSize(size: string): void {
    const img = this.image;
    if (!img) {
      return;
    }

    const reference = imageReference(img);
    const current = imageOptions(reference);
    setImageReference(
      img,
      withImageOptions(reference, size, current.layout),
      this.storageUrl
    );
    decorateImage(img);

    // the image's block no longer matches what it rendered as, which is exactly what being edited means
    this.edited();
    this.requestUpdate();
  }

  // ==========================================================
  // Columns
  // ==========================================================

  /** merges a patch into one column's stylesheet and re-applies the table */
  private setColumnStyle(
    table: Element,
    index: number,
    patch: {
      width?: string | null;
      background?: string | null;
      padding?: string | null;
      border?: string | null;
    }
  ): void {
    const th = [...table.querySelectorAll(':scope > thead th')][index];
    if (!th) {
      return;
    }

    const merged: ColumnStyle = {
      ...(columnStyle(th.getAttribute('data-style') || '') || {})
    };
    for (const key of ['width', 'background', 'padding', 'border'] as const) {
      if (patch[key] !== undefined) {
        if (patch[key]) {
          merged[key] = patch[key];
        } else {
          delete merged[key];
        }
      }
    }

    const value = columnStyleText(merged);
    if (value) {
      th.setAttribute('data-style', value);
    } else {
      th.removeAttribute('data-style');
    }

    decorateTable(table, this.colors);
  }

  // The org's palette. Articles embed an index; the palette says what each index currently looks like. That's what
  // keeps color use consistent across articles: recoloring an entry restyles its every use at once, and removing
  // one leaves its references meaning nothing until an entry exists at that index again.

  private async fetchArticles(): Promise<void> {
    try {
      const response = await getUrl(this.articlesEndpoint);
      this.articles = response.json?.results || [];
    } catch (error) {
      console.warn('Failed to fetch articles', error);
    }
  }

  private async fetchColors(): Promise<void> {
    try {
      const response = await getUrl(this.colorsEndpoint);
      this.colors = response.json?.colors || {};
    } catch (error) {
      console.warn('Failed to fetch colors', error);
    }
    this.redecorate();
  }

  /** re-resolves every table against the palette as it now stands - a visual change only, the markdown's indexes
   * stay exactly where they were */
  private redecorate(): void {
    const doc = this.doc;
    if (!doc) {
      return;
    }
    for (const table of [...doc.querySelectorAll('table')]) {
      if (!table.closest(`.${LOCKED}`)) {
        decorateTable(table, this.colors);
      }
    }
    this.requestUpdate();
  }

  private applyColumnBackground(index: number, key: string): void {
    const table = this.column?.closest('table');
    if (!table) {
      return;
    }
    this.setColumnStyle(table, index, { background: key || null });
    this.edited();
    this.requestUpdate();
  }

  private applyColumnPadding(index: number, padding: string): void {
    const table = this.column?.closest('table');
    if (!table) {
      return;
    }
    this.setColumnStyle(table, index, { padding: padding || null });
    this.edited();
    this.requestUpdate();
  }

  private toggleColumnBorder(index: number, on: boolean): void {
    const table = this.column?.closest('table');
    if (!table) {
      return;
    }
    this.setColumnStyle(table, index, { border: on ? 'solid' : null });
    this.edited();
    this.requestUpdate();
  }

  /** tracks the pointer for a grabbable column edge, offering the resize cursor over one */
  private handleDocMouseMove(evt: MouseEvent): void {
    if (this.resizing || this.sourceMode || !this.doc) {
      return;
    }

    this.resizeHover = null;
    let cursor = '';

    const target = evt.target as Element;
    const table = target.closest?.('table');
    if (table && isLayoutTable(table) && !target.closest(`.${LOCKED}`)) {
      const row = table.querySelector(':scope > tbody > tr');
      const cells = row ? [...row.children] : [];
      // every edge between cells is grabbable; the last column takes what's left, so its edge sizes nothing
      for (let index = 0; index < cells.length - 1; index++) {
        const box = cells[index].getBoundingClientRect();
        if (Math.abs(evt.clientX - box.right) <= 4) {
          this.resizeHover = { table, index };
          cursor = 'col-resize';
          break;
        }
      }
    }

    if (this.doc.style.cursor !== cursor) {
      this.doc.style.cursor = cursor;
    }
  }

  /** starts a column drag when the pointer is on a grabbable edge, instead of placing the caret there */
  private handleDocMouseDown(evt: MouseEvent): void {
    if (!this.resizeHover) {
      return;
    }

    const { table, index } = this.resizeHover;
    const row = table.querySelector(':scope > tbody > tr');
    const cell = row ? row.children[index] : null;
    if (!cell) {
      return;
    }

    evt.preventDefault();
    this.resizing = {
      table,
      index,
      startX: evt.clientX,
      startWidth: cell.getBoundingClientRect().width,
      tableWidth: table.getBoundingClientRect().width
    };
    document.addEventListener('mousemove', this.handleResizeMove);
    document.addEventListener('mouseup', this.handleResizeEnd);
  }

  private handleResizeMove = (evt: MouseEvent): void => {
    const drag = this.resizing;
    if (!drag || drag.tableWidth <= 0) {
      return;
    }

    // the width is kept as a share of the table rather than pixels, so the row splits the same way wherever the
    // article is read - the editor, a dialog, a phone
    const width = Math.min(
      95,
      Math.max(
        5,
        Math.round(
          ((drag.startWidth + evt.clientX - drag.startX) / drag.tableWidth) *
            100
        )
      )
    );
    this.setColumnStyle(drag.table, drag.index, { width: `${width}%` });
    // any open overlay rides the cells it points at
    this.requestUpdate();
  };

  private handleResizeEnd = (): void => {
    document.removeEventListener('mousemove', this.handleResizeMove);
    document.removeEventListener('mouseup', this.handleResizeEnd);
    if (this.resizing) {
      this.resizing = null;
      this.edited();
    }
  };

  /** The selection flattened to lines of inline markup - what a cell can hold. Selected blocks contribute their
   * contents with the boundaries kept as line breaks; list items become lines of their own. */
  private selectionLines(): string[] {
    const range = this.range;
    if (!range || range.collapsed) {
      return [];
    }

    const scratch = document.createElement('div');
    scratch.appendChild(range.cloneContents());

    const lines: string[] = [];
    let inline = '';
    const flush = () => {
      if (inline.trim()) {
        lines.push(inline);
      }
      inline = '';
    };

    for (const node of [...scratch.childNodes]) {
      const element = node as Element;
      if (
        node.nodeType === Node.ELEMENT_NODE &&
        TOP_LEVEL.has(element.tagName)
      ) {
        flush();
        if (element.tagName === 'UL' || element.tagName === 'OL') {
          for (const item of [...element.children]) {
            lines.push(item.innerHTML);
          }
        } else if (element.tagName !== 'HR') {
          lines.push(element.innerHTML);
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        inline += escapeHtml(node.textContent);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        inline += element.outerHTML;
      }
    }
    flush();

    return lines;
  }

  /**
   * Inserts a two column row - a markdown table with nothing in its header, which the styles show as side by side
   * cells rather than data. A highlighted selection moves into the first column, leaving the caret in the second
   * ready for the words that go beside it.
   */
  private insertColumns(): void {
    if (!this.focusDocument()) {
      return;
    }

    const lines = this.selectionLines();
    this.exec(
      'insertHTML',
      '<table><thead><tr><th></th><th></th></tr></thead>' +
        `<tbody><tr><td>${lines.join('<br>') || '<br>'}</td><td><br></td></tr></tbody></table>`
    );
    this.enterInsertedTable(true, lines.length > 0 ? 1 : 0);
  }

  /**
   * Wraps the selection in a single column row, which is what makes its styling configurable - the background,
   * padding and width the column popover offers. A cell holds one run of inline content, so selected blocks
   * flatten into it with their boundaries kept as line breaks.
   */
  private insertCallout(): void {
    if (!this.focusDocument()) {
      return;
    }

    const lines = this.selectionLines();
    this.exec(
      'insertHTML',
      `<table><thead><tr><th></th></tr></thead>` +
        `<tbody><tr><td>${lines.join('<br>') || '<br>'}</td></tr></tbody></table>`
    );
    const table = this.enterInsertedTable(false);

    // styling is what the wrap is for, so it starts on the palette's first color rather than on nothing
    const first = Object.keys(this.colors).sort((a, b) => +a - +b)[0];
    if (table && first) {
      this.setColumnStyle(table, 0, { background: first });
    }
  }

  /** grows a single column block into columns by adding an empty second column beside it, caret waiting inside */
  private addColumn(): void {
    const cell =
      this.cellAt(this.range) || this.image?.closest('td, th') || null;
    const table = cell ? cell.closest('table') : null;
    if (!table || !isLayoutTable(table)) {
      return;
    }

    table
      .querySelector(':scope > thead tr')
      ?.appendChild(document.createElement('th'));

    let target: Element = null;
    for (const row of [...table.querySelectorAll(':scope > tbody > tr')]) {
      const td = document.createElement('td');
      td.innerHTML = '<br>';
      row.appendChild(td);
      target = target || td;
    }
    decorateTable(table, this.colors);

    if (target) {
      const inside = document.createRange();
      inside.selectNodeContents(target);
      inside.collapse(true);
      this.select(inside);
    }
  }

  /**
   * Dissolves a columns row into a vertical stack, column by column. A styled column keeps its styling by becoming
   * a single column block of its own - only its width falls away, since a stacked block takes the full width - and
   * an unstyled one returns to ordinary paragraphs.
   */
  private unwrapColumns(): void {
    const cell =
      this.cellAt(this.range) || this.image?.closest('td, th') || null;
    const table = cell ? cell.closest('table') : null;
    if (!table || !isLayoutTable(table)) {
      return;
    }

    const heads = [...table.querySelectorAll(':scope > thead th')];
    const rows = [...table.querySelectorAll(':scope > tbody > tr')];
    const blocks: Element[] = [];

    // a cell of nothing but whitespace has nothing worth a line of its own in the stack
    const holds = (from: Element) =>
      !!from.textContent.trim() || !!from.querySelector('img, hr');

    heads.forEach((th, index) => {
      const style = columnStyle(th.getAttribute('data-style') || '') || {};
      delete style.width;
      const cells = rows
        .map((row) => row.children[index])
        .filter((c) => !!c && holds(c));

      if (cells.length === 0) {
        return;
      }

      if (columnStyleText(style)) {
        const single = document.createElement('table');
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        const head = document.createElement('th');
        head.setAttribute('data-style', columnStyleText(style));
        headRow.appendChild(head);
        thead.appendChild(headRow);
        single.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const from of cells) {
          const row = document.createElement('tr');
          const td = document.createElement('td');
          td.append(...from.childNodes);
          row.appendChild(td);
          tbody.appendChild(row);
        }
        single.appendChild(tbody);
        blocks.push(single);
      } else {
        for (const from of cells) {
          const paragraph = document.createElement('p');
          paragraph.append(...from.childNodes);
          blocks.push(paragraph);
        }
      }
    });

    if (blocks.length === 0) {
      const paragraph = document.createElement('p');
      paragraph.innerHTML = '<br>';
      blocks.push(paragraph);
    }

    table.replaceWith(...blocks);
    this.column = null;

    const inside = document.createRange();
    inside.selectNodeContents(blocks[0]);
    inside.collapse(true);
    this.select(inside);
  }

  /** dissolves a single column row back into ordinary text - no colors, no padding, just the words again */
  private clearCallout(): void {
    const table = this.column?.closest('table');
    if (!table || table.querySelectorAll(':scope > thead th').length !== 1) {
      return;
    }

    const cell = table.querySelector('td');
    const paragraph = document.createElement('p');
    paragraph.append(...(cell ? [...cell.childNodes] : []));
    if (paragraph.childNodes.length === 0) {
      paragraph.innerHTML = '<br>';
    }
    table.replaceWith(paragraph);
    this.column = null;

    const inside = document.createRange();
    inside.selectNodeContents(paragraph);
    inside.collapse(false);
    this.select(inside);

    this.edited();
  }

  /** puts the caret in a cell of the table an insert just left it after, and hands the table back */
  private enterInsertedTable(atStart: boolean, at = 0): Element {
    const range = this.range;
    let block = range ? this.blockAt(range.startContainer) : null;
    if (
      block &&
      block.tagName !== 'TABLE' &&
      block.previousElementSibling?.tagName === 'TABLE'
    ) {
      block = block.previousElementSibling;
    }

    const table = block?.tagName === 'TABLE' ? block : null;
    const cell = table ? table.querySelectorAll('td')[at] : null;
    if (cell) {
      const inside = document.createRange();
      inside.selectNodeContents(cell);
      inside.collapse(atStart);
      this.select(inside);
    }
    return table;
  }

  /** drops a whole block into the source at the caret - on its own line, with a blank line either side */
  private insertSourceBlock(block: string, caretAt: number): void {
    const area = this.textArea;
    if (!area) {
      return;
    }

    const text = area.value;
    const start = area.selectionStart;
    const before = text.substring(0, start);
    const after = text.substring(area.selectionEnd);

    const lead = !before.trim()
      ? ''
      : before.endsWith('\n\n')
        ? ''
        : before.endsWith('\n')
          ? '\n'
          : '\n\n';
    const tail = !after.trim()
      ? ''
      : after.startsWith('\n\n')
        ? ''
        : after.startsWith('\n')
          ? '\n'
          : '\n\n';

    area.value = before + lead + block + tail + after;
    this.value = area.value;
    this.fireEvent('change');

    const caret = start + lead.length + caretAt;
    area.focus();
    area.setSelectionRange(caret, caret);
  }

  /** the same commands in source mode, where there is nothing rendered to act on and markdown is what the caret is in */
  private applySourceFormat(command: Command): void {
    const area = this.textArea;
    if (!area) {
      return;
    }

    const text = area.value;
    let start = area.selectionStart;
    const end = area.selectionEnd;

    if (command.format === 'columns') {
      // the caret goes into the first cell of the body row
      const table = '|  |  |\n| --- | --- |\n|  |  |';
      this.insertSourceBlock(table, table.lastIndexOf('\n') + 3);
      return;
    }

    if (command.format === 'callout') {
      // the selection becomes the cell of a single column row, its lines carried as the breaks a cell can hold
      const cell = text
        .substring(start, end)
        .trim()
        .replace(/\|/g, '\\|')
        .replace(/\n+/g, '<br>');
      const block = `|  |\n| --- |\n| ${cell} |`;
      this.insertSourceBlock(block, block.length - (cell ? 2 : 1));
      return;
    }

    if (command.format === 'hr') {
      this.insertSourceBlock('---', 3);
      return;
    }

    if (command.lines) {
      // block markers apply from the start of the line the selection begins on, and to every line it covers - marking
      // only the first would turn a three line selection into one list item and two loose lines
      start = start > 0 ? text.lastIndexOf('\n', start - 1) + 1 : 0;
      const marked = text
        .substring(start, end)
        .split('\n')
        .map((line) => command.prefix + line)
        .join('\n');

      area.value = text.substring(0, start) + marked + text.substring(end);
      this.value = area.value;
      this.fireEvent('change');
      area.focus();
      area.setSelectionRange(
        start + command.prefix.length,
        start + command.prefix.length
      );
      return;
    }

    const selected = text.substring(start, end);
    const suffix = command.suffix ?? command.prefix;
    const replacement = command.prefix + selected + suffix;

    area.value = text.substring(0, start) + replacement + text.substring(end);
    this.value = area.value;
    this.fireEvent('change');

    const caret = selected
      ? end + command.prefix.length + suffix.length
      : start + command.prefix.length;

    area.focus();
    area.setSelectionRange(caret, caret);
  }

  // ==========================================================
  // Pasting and dropping
  // ==========================================================

  /**
   * Copies the selection with any layout tables dissolved into their contents - layout never travels on the
   * clipboard. Returns whether it took the copy over; a selection with no layout in it copies natively.
   */
  private handleCopy(evt: ClipboardEvent): boolean {
    const range = this.range;
    if (!range || range.collapsed || this.sourceMode) {
      return false;
    }

    const scratch = document.createElement('div');
    scratch.appendChild(range.cloneContents());
    if (!flattenLayoutTables(scratch)) {
      return false;
    }

    evt.preventDefault();
    evt.clipboardData.setData('text/html', scratch.innerHTML);

    // the plain text flavor keeps the lines the breaks and blocks drew
    for (const br of [...scratch.querySelectorAll('br')]) {
      br.replaceWith('\n');
    }
    evt.clipboardData.setData(
      'text/plain',
      [...scratch.childNodes]
        .map((node) => node.textContent)
        .filter((text) => text.trim())
        .join('\n\n')
    );

    return true;
  }

  /** a cut is the same copy, with the browser's own delete kept since the copy was taken over */
  private handleCut(evt: ClipboardEvent): void {
    if (this.handleCopy(evt)) {
      this.exec('delete');
      this.edited();
    }
  }

  private handleDragOver(evt: DragEvent): void {
    // a div isn't a drop target until something says the drag is welcome, and without this the browser navigates to
    // the dropped image and takes the unsaved article with it
    evt.preventDefault();
  }

  private handleDrop(evt: DragEvent): void {
    const files = [...(evt.dataTransfer?.files || [])];
    if (files.length > 0) {
      evt.preventDefault();
      this.upload(files);
    }
  }

  private handlePaste(evt: ClipboardEvent): void {
    // a screenshot on the clipboard arrives as a file with no name, which is the common way to add one
    const files = [...(evt.clipboardData?.items || [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file) => !!file);

    if (files.length > 0) {
      evt.preventDefault();
      this.upload(files);
      return;
    }

    if (this.sourceMode) {
      return;
    }

    const clipboard = evt.clipboardData;
    const pasted = clipboard?.getData('text/html');
    const text = clipboard?.getData('text/plain') || '';

    if (!pasted && !text) {
      return;
    }

    evt.preventDefault();

    // Markup off the clipboard - ours or another app's - is rebuilt into the shapes the serializer knows and put
    // through the same round trip the document itself takes: read to markdown, then rendered back. So nothing can
    // land in the document that the editor couldn't have produced or couldn't write out again, and what the rebuild
    // can't express falls back to the plain text.
    const source = pasted ? this.markdownOf(pasted, text) : null;

    this.exec(
      'insertHTML',
      source === null
        ? text
            .split(/\n{2,}/)
            .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
            .join('')
        : source.inline
          ? markdown.renderInline(source.markdown)
          : renderBlock(source.markdown)
    );

    // what was pasted was rendered from markdown, so any image in it is a bare reference again
    this.resolveImages();
    this.edited('insertFromPaste');
  }

  /** shows every image in the document from storage that isn't already - a reference that arrived rendered rather
   * than through populate, from a paste say */
  private resolveImages(): void {
    const doc = this.doc;
    if (!doc) {
      return;
    }
    for (const img of [...doc.querySelectorAll('img')]) {
      if (!img.hasAttribute('data-src')) {
        setImageReference(img, imageReference(img), this.storageUrl);
      }
    }
  }

  /** the markdown for pasted markup, or null when it isn't anything the document could hold */
  private markdownOf(
    pasted: string,
    text: string
  ): { markdown: string; inline: boolean } {
    // parsed inert, so nothing in it loads or runs on the way past
    const parsed = new DOMParser().parseFromString(pasted, 'text/html');
    const blocks = importBlocks(parsed.body);

    if (blocks.length === 0) {
      return text ? null : { markdown: parsed.body.textContent, inline: true };
    }

    return {
      markdown: blocks.map((block) => blockOf(block)).join('\n\n'),
      // a single plain paragraph drops into the text at the caret; anything more is blocks of its own
      inline: blocks.length === 1 && blocks[0].tagName === 'P'
    };
  }

  // ==========================================================
  // Screenshots
  // ==========================================================

  private handleUploadClick(): void {
    (
      this.shadowRoot.querySelector('#upload-input') as HTMLInputElement
    ).click();
  }

  private handleFileInput(evt: any): void {
    this.upload([...evt.target.files]);
    evt.target.value = null;
  }

  private async upload(files: File[]): Promise<void> {
    if (!this.endpoint) {
      return;
    }

    this.error = '';
    this.uploading = true;

    // Where the images go, fixed before anything else is awaited. An upload takes seconds and the author is free to
    // click somewhere else while it runs, so reading the caret when the url comes back would put the image wherever
    // they happen to have moved to.
    const source = this.sourceMode;
    let target: Range = null;
    let start = 0;
    let end = 0;

    if (source) {
      start = this.textArea?.selectionStart ?? 0;
      end = this.textArea?.selectionEnd ?? 0;
    } else {
      if (!this.focusDocument()) {
        this.uploading = false;
        return;
      }
      target = this.range?.cloneRange();
    }

    for (const file of files) {
      const data = new FormData();
      data.append('file', file);

      try {
        const response = await postFormData(this.endpoint, data);

        // a session that expired mid-upload redirects to a login page, which resolves as a success with nothing we
        // can use - so the url has to be there before we write a reference to it
        if (response.json.error || !response.json.url) {
          this.error = response.json.error || msg('Unable to upload file.');
          break;
        }

        // the name is alt text inside brackets, and clean_name deliberately keeps [ ] ( ) in filenames
        const alt = (response.json.name || '').replace(/[[\]()]/g, '');

        // an upload is written by its storage key when the endpoint gives one, so the article never holds the
        // address storage is served from - the url is only for showing it now
        const written = response.json.path || response.json.url;

        if (source) {
          const reference = `![${alt}](${written})`;
          const document = this.value || '';
          this.value =
            document.substring(0, start) + reference + document.substring(end);
          this.fireEvent('change');

          // the next file goes after this one rather than in front of it
          start += reference.length;
          end = start;
        } else {
          target = this.insertImage(target, written, response.json.url, alt);
        }
      } catch (e) {
        this.error = msg('Unable to upload file.');
        break;
      }
    }

    this.uploading = false;

    if (source) {
      await this.updateComplete;
      this.textArea?.setSelectionRange(start, start);
    }
  }

  /**
   * Puts an image where the author asked for it and hands back where the next one goes. The insert runs through the
   * browser so it lands in the undo stack, which means moving the selection there first - and back again afterwards if
   * the author has moved on in the meantime, since being yanked back mid-sentence is worse than not seeing it land.
   */
  private insertImage(
    target: Range,
    reference: string,
    url: string,
    alt: string
  ): Range {
    const doc = this.doc;
    if (!doc || !target || !doc.contains(target.startContainer)) {
      return target;
    }

    const current = this.range?.cloneRange();
    const moved =
      current &&
      (current.startContainer !== target.startContainer ||
        current.startOffset !== target.startOffset);

    doc.focus();
    this.select(target);
    const source =
      reference !== url ? ` data-src="${escapeHtml(reference)}"` : '';
    this.exec(
      'insertHTML',
      `<img src="${escapeHtml(url)}"${source} alt="${escapeHtml(alt)}">`
    );

    const after = this.range?.cloneRange() || target;

    if (moved && doc.contains(current.startContainer)) {
      this.select(current);
    }

    return after;
  }

  // ==========================================================
  // Rendering
  // ==========================================================

  public render(): TemplateResult {
    return this.renderField();
  }

  /** A floor under the document, which a filled editor doesn't get - it's the container that's being sized, and an
   * inline minimum here would win over the flex rules and put the scroll back on the page. */
  private get documentStyle(): string {
    const styles = [];
    if (!this.fill) {
      styles.push(`min-height:${this.minHeight}px`);
    }
    if (this.primaryColor) {
      styles.push(`--primary:${this.primaryColor}`);
    }
    return styles.join(';');
  }

  /** the form's title or subtitle field, slotted in at the head of the card - null when it wasn't */
  private headField(
    slot: 'title' | 'subtitle'
  ): HTMLTextAreaElement | HTMLInputElement {
    return this.querySelector(`[slot="${slot}"]`);
  }

  /** what the page slotted in, which is what the card has to make room for */
  private syncSlots(): void {
    this.hasSubtitle = !!this.headField('subtitle');
    this.hasHero = !!this.heroInput;
    this.sizeHead();
  }

  /** A textarea title or subtitle is grown to its text and no further, so a long one wraps to the card as the
   * site's heading does rather than scrolling inside a box. Left alone until it has a size to measure. */
  private sizeHead(): void {
    for (const slot of ['title', 'subtitle'] as const) {
      const field = this.headField(slot);
      if (!(field instanceof HTMLTextAreaElement) || !field.offsetWidth) {
        continue;
      }
      field.style.height = '0';
      field.style.height = `${field.scrollHeight}px`;
    }
  }

  /** a title or subtitle is one line of text however it's typed or pasted, so any line breaks that get in become
   * spaces */
  private handleHeadInput(evt: Event): void {
    const field = evt.target as HTMLTextAreaElement | HTMLInputElement;
    if (field?.value && /[\r\n]/.test(field.value)) {
      field.value = field.value.replace(/\s*[\r\n]+\s*/g, ' ');
    }
    this.sizeHead();
  }

  /** Enter in the title goes on to the subtitle if there is one and the article otherwise, and Enter in the
   * subtitle to the article - rather than breaking the line, or submitting the form as Enter in a form's lone text
   * input would */
  private handleHeadKeyDown(evt: KeyboardEvent): void {
    // not while an IME is composing, where Enter commits the composition rather than the field
    if (evt.key !== 'Enter' || evt.isComposing) {
      return;
    }
    evt.preventDefault();

    const subtitle = this.headField('subtitle');
    if (evt.target === this.headField('title') && subtitle) {
      subtitle.focus();
      subtitle.setSelectionRange(subtitle.value.length, subtitle.value.length);
    } else {
      this.focusStart();
    }
  }

  /** the form's file field for the cover image, slotted in and never shown - the cover itself is the control */
  private get heroInput(): HTMLInputElement {
    return this.querySelector('input[slot="hero"]');
  }

  /** a press on the cover asks the slotted input for a file */
  private pickHero(): void {
    if (!this.disabled) {
      this.heroInput?.click();
    }
  }

  private handleCoverKeyDown(evt: KeyboardEvent): void {
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      this.pickHero();
    }
  }

  /** the file the input was given is what the cover shows from here on - or the saved image again, if the
   * picking was cancelled and the input emptied */
  private handleHeroChange(evt: Event): void {
    if (evt.target !== this.heroInput) {
      return;
    }
    const file = this.heroInput.files?.[0];
    this.setHeroPreview(file ? URL.createObjectURL(file) : '');
  }

  private setHeroPreview(url: string): void {
    if (this.heroPreview) {
      URL.revokeObjectURL(this.heroPreview);
    }
    this.heroPreview = url;
  }

  /** puts the caret at the start of the article's first block */
  private focusStart(): void {
    const doc = this.doc;
    if (!doc) {
      return;
    }
    doc.focus();
    const range = document.createRange();
    range.selectNodeContents(doc.firstElementChild || doc);
    range.collapse(true);
    this.select(range);
  }

  /** A press on the ground beside or below the article, or on the card's own margins - the frame is wider than
   * the article's measure, as the site's page is - puts the caret at the end of the article's last block, so the
   * whole editor is somewhere to click to write. Inside the block rather than after it: the caret is always in a
   * block, and the rest of the editor reads where it is on that footing. */
  private handleFrameMouseDown(evt: MouseEvent): void {
    const doc = this.doc;
    const target = evt.target as Element;
    if (
      (target !== evt.currentTarget &&
        !target.classList?.contains('article')) ||
      !doc ||
      this.disabled
    ) {
      return;
    }
    evt.preventDefault();
    doc.focus();

    const last = doc.lastElementChild;
    if (!last) {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(last);
    range.collapse(false);
    this.select(range);
  }

  /** Where an element sits relative to the overlay layer, which is what the overlays position against. The layer
   * scrolls with the document, so these coordinates hold at any scroll position. */
  private overlayRect(
    target: Element
  ): { left: number; top: number; width: number; height: number } | null {
    const layer = this.shadowRoot?.querySelector('.overlays');
    if (!layer || !target || !target.isConnected) {
      return null;
    }
    const outer = layer.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    return {
      left: rect.left - outer.left,
      top: rect.top - outer.top,
      width: rect.width,
      height: rect.height
    };
  }

  /** the clicked image's selection ring, and its size controls floated just inside its top edge */
  private renderImageOverlay(): TemplateResult {
    const rect = this.image ? this.overlayRect(this.image) : null;
    if (!rect) {
      return null;
    }

    const current = imageOptions(imageReference(this.image)).size;
    const sizes = [
      { value: '', label: msg('Original') },
      { value: 'small', label: msg('Small') },
      { value: 'medium', label: msg('Medium') },
      { value: 'large', label: msg('Large') }
    ];

    return html`
      <div
        class="image-ring"
        style="left:${rect.left - 2}px;top:${rect.top -
        2}px;width:${rect.width}px;height:${rect.height}px"
      ></div>
      <div
        class="image-actions"
        style="left:${rect.left + 6}px;top:${rect.top + 6}px"
        @mousedown=${(evt: MouseEvent) => evt.preventDefault()}
      >
        ${sizes.map(
          (size) => html`
            <div
              class="chip ${current === size.value ? 'on' : ''}"
              @click=${() => this.applyImageSize(size.value)}
            >
              ${size.label}
            </div>
          `
        )}
      </div>
    `;
  }

  /** the link under the caret, edited just above its text - without ever showing its markdown */
  private renderLinkPopover(): TemplateResult {
    const rect =
      this.linkHref !== null && this.anchor
        ? this.overlayRect(this.anchor)
        : null;
    if (!rect) {
      return null;
    }

    // an article link shows the article it points at rather than its uuid; while a search is being typed the box
    // holds the search instead
    const linked = this.linkedArticle(this.linkHref);
    const shown =
      this.linkQuery !== null
        ? this.linkQuery
        : linked
          ? linked.title
          : this.linkHref;
    const matches = this.matchingArticles();

    return html`
      <div
        class="popover link-popover ${rect.top < 44 ? 'below' : ''}"
        style="left:${rect.left}px;top:${rect.top < 44
          ? rect.top + rect.height + 6
          : rect.top - 6}px"
        @mousedown=${(evt: MouseEvent) => {
          if ((evt.target as Element).tagName !== 'INPUT') {
            evt.preventDefault();
          }
        }}
      >
        <temba-icon
          class="link-kind"
          name=${this.linkQuery !== null
            ? Icon.search
            : linked
              ? Icon.help
              : Icon.hyperlink}
          title=${this.linkQuery !== null
            ? msg('Searching articles')
            : linked
              ? msg('Links to an article')
              : msg('Links to an address')}
        ></temba-icon>
        <input
          type="text"
          spellcheck="false"
          .value=${shown}
          placeholder=${this.articles.length
            ? msg('https:// or an article title')
            : 'https://'}
          @input=${this.handleLinkInput}
        />
        <temba-icon
          class="link-remove"
          name=${Icon.delete_small}
          title=${msg('Remove link')}
          @click=${this.handleLinkRemove}
        ></temba-icon>
      </div>
      ${this.renderLinkOptions(matches)}
    `;
  }

  /** The articles a search matches, as an options list floated under the link bar's box - the same control as a
   * select's dropdown, so it's steered the same way: arrows or ctrl-n and ctrl-p, enter to take one, escape to
   * give the search up. It stands beside the bar rather than inside it, since the bar is shifted into place with
   * a transform that would otherwise pin the list to it. A press on it keeps the caret where it is. */
  private renderLinkOptions(matches: ArticleTarget[]): TemplateResult {
    const searching = !!(this.linkQuery || '').trim();
    return html`
      <div
        class="link-options"
        @mousedown=${(evt: MouseEvent) => evt.preventDefault()}
      >
        <temba-options
          .options=${matches}
          ?visible=${searching}
          showEmptyMessage
          emptyMessage=${msg('No matching articles')}
          .renderOption=${(article: ArticleTarget) => html`
            <div
              class="name"
              style="flex: 1; min-width: 0; font-weight: 500; ${article.status ===
              'draft'
                ? 'color: var(--color-text-help)'
                : ''}"
            >
              ${article.title}
            </div>
            <div
              class="detail"
              style="flex-shrink: 0; max-width: 45%; margin-left: 1em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
            >
              ${article.parent ? this.sectionOf(article) : msg('Section')}
            </div>
          `}
          @temba-selection=${this.handleLinkPick}
          @temba-canceled=${this.handleLinkCancel}
        ></temba-options>
      </div>
    `;
  }

  /** the clicked column's background choices, floated just above its table */
  private renderColumnPopover(): TemplateResult {
    const table = this.column ? this.column.closest('table') : null;
    if (!table || this.image) {
      return null;
    }

    const rect = this.overlayRect(this.column);
    const tableRect = this.overlayRect(table);
    if (!rect || !tableRect) {
      return null;
    }

    const index = [...this.column.parentElement.children].indexOf(this.column);
    const th = [...table.querySelectorAll(':scope > thead th')][index];
    const current =
      (th && columnStyle(th.getAttribute('data-style') || '')) || {};

    // the org's palette, in index order - what everyone else's articles use too, which is the point
    const palette = Object.entries(this.colors).sort((a, b) => +a[0] - +b[0]);
    const selected =
      current.background && this.colors[current.background]
        ? current.background
        : '';

    // three densities as one control, tightest to airiest - each icon the same frame around a block of content,
    // with the gap between them the size the padding is
    const paddings = [
      { value: '4px', icon: Icon.padding_less, title: msg('Less padding') },
      { value: '', icon: Icon.padding_normal, title: msg('Normal padding') },
      { value: '28px', icon: Icon.padding_more, title: msg('More padding') }
    ];

    // the column under edit, traced in blue - every cell at this index and only this index, so one column of a
    // wider row lights up alone
    let ring: { left: number; top: number; right: number; bottom: number } =
      null;
    for (const row of [...table.querySelectorAll(':scope > tbody > tr')]) {
      const cell = row.children[index];
      const box = cell ? this.overlayRect(cell) : null;
      if (!box) {
        continue;
      }
      ring = ring
        ? {
            left: Math.min(ring.left, box.left),
            top: Math.min(ring.top, box.top),
            right: Math.max(ring.right, box.left + box.width),
            bottom: Math.max(ring.bottom, box.top + box.height)
          }
        : {
            left: box.left,
            top: box.top,
            right: box.left + box.width,
            bottom: box.top + box.height
          };
    }

    return html`
      ${ring
        ? html`<div
            class="column-ring"
            style="left:${ring.left}px;top:${ring.top}px;width:${ring.right -
            ring.left}px;height:${ring.bottom - ring.top}px"
          ></div>`
        : null}
      <div
        class="popover ${tableRect.top < 44 ? 'below' : ''}"
        style="left:${rect.left}px;top:${tableRect.top < 44
          ? tableRect.top + tableRect.height + 6
          : tableRect.top - 6}px"
        @mousedown=${(evt: MouseEvent) => {
          if ((evt.target as Element).tagName !== 'INPUT') {
            evt.preventDefault();
          }
        }}
      >
        <div
          class="swatch none ${selected ? '' : 'on'}"
          title=${msg('No color')}
          @click=${() => this.applyColumnBackground(index, '')}
        ></div>
        ${palette.map(
          ([key, hex]) => html`
            <div
              class="swatch ${selected === key ? 'on' : ''}"
              style="background:${hex}"
              title=${hex}
              @click=${() => this.applyColumnBackground(index, key)}
            ></div>
          `
        )}
        <div class="divider"></div>
        <div class="pad-group">
          ${paddings.map(
            (padding) => html`
              <div
                class="pad ${(current.padding || '') === padding.value
                  ? 'on'
                  : ''}"
                title=${padding.title}
                @click=${() => this.applyColumnPadding(index, padding.value)}
              >
                <temba-icon name=${padding.icon} size="1.1"></temba-icon>
              </div>
            `
          )}
        </div>
        <div class="divider"></div>
        <div
          class="pad ${current.border ? 'on' : ''}"
          title=${msg('Border drawn from the background color')}
          @click=${() => this.toggleColumnBorder(index, !current.border)}
        >
          <temba-icon name=${Icon.border} size="1.1"></temba-icon>
        </div>
        ${table.querySelectorAll(':scope > thead th').length === 1
          ? html`
              <div class="divider"></div>
              <div
                class="pad"
                title=${msg('Remove styling')}
                @click=${() => this.clearCallout()}
              >
                <temba-icon name=${Icon.clear_style} size="1.1"></temba-icon>
              </div>
            `
          : null}
      </div>
    `;
  }

  /** Where the cover image goes: across the head of the card, as on the page - when the page has slotted a file
   * field in for one. The cover shows the image the post has, or the one just picked, and is itself the way to
   * pick one; the input stays the form's. */
  private renderCover(): TemplateResult {
    if (!this.hasHero) {
      return html`<slot name="hero" @slotchange=${this.syncSlots}></slot>`;
    }

    const url = this.heroPreview || this.hero;
    // the address is written into an inline style, so anything that could end the url() is percent-encoded first
    // - by hand, since encodeURIComponent leaves quotes and parentheses alone
    const cssUrl = url.replace(
      /[()'"\s\\]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
    );
    return html`
      <div
        class="cover ${url ? '' : 'empty'}"
        role="button"
        tabindex="0"
        style=${url ? `background-image:url('${cssUrl}')` : ''}
        @click=${this.pickHero}
        @keydown=${this.handleCoverKeyDown}
        @change=${this.handleHeroChange}
      >
        <div class="cover-prompt">
          <temba-icon name="${Icon.image}"></temba-icon>
          ${url ? msg('Change cover image') : msg('Add a cover image')}
        </div>
        <slot name="hero" @slotchange=${this.syncSlots}></slot>
      </div>
      <slot name="hero-errors"></slot>
    `;
  }

  /** Where the title and subtitle go: at the head of the card, as on the site. The page slots the form's own
   * fields in here, with whatever the form had to say about them after each; the editor's part is placing them,
   * drawing them as the site's heading and standfirst, and standing its toolbar down while one of them is what's
   * being written. */
  private renderHead(): TemplateResult {
    return html`
      <div
        class="head ${this.hasSubtitle ? 'with-subtitle' : ''}"
        @focusin=${() => (this.inHead = true)}
        @focusout=${() => (this.inHead = false)}
        @keydown=${this.handleHeadKeyDown}
        @input=${this.handleHeadInput}
      >
        <slot name="title" @slotchange=${this.syncSlots}></slot>
        <slot name="title-errors"></slot>
        <slot name="subtitle" @slotchange=${this.syncSlots}></slot>
        <slot name="subtitle-errors"></slot>
      </div>
    `;
  }

  private renderOverlays(): TemplateResult {
    if (this.sourceMode) {
      return null;
    }
    return html`${this.renderImageOverlay()}${this.renderLinkPopover()}${this.renderColumnPopover()}`;
  }

  private renderSource(): TemplateResult {
    return html`
      <textarea
        class="document"
        style=${this.documentStyle}
        .value=${this.value || ''}
        ?disabled=${this.disabled}
        @input=${this.handleInput}
        @drop=${this.handleDrop}
        @paste=${this.handlePaste}
      ></textarea>
    `;
  }

  protected renderWidget(): TemplateResult {
    return html`
      <div class="container">
        <div class="chrome">
          <div
            class="toolbar ${this.inHead ? 'muted' : ''}"
            @mousedown=${(evt: MouseEvent) => evt.preventDefault()}
          >
            ${this.sourceMode
              ? null
              : html`
                  ${this.commands.map((command) => {
                    const disabled =
                      this.inCell &&
                      (command.format === 'callout' ||
                        (command.format === 'columns' &&
                          !this.active.includes('columns') &&
                          !this.inCallout));
                    return html`
                      <div
                        class="format ${command.format} ${this.active.includes(
                          command.format
                        )
                          ? 'on'
                          : ''} ${disabled ? 'disabled' : ''}"
                        title="${command.title}"
                        @click=${() => !disabled && this.applyFormat(command)}
                      >
                        ${command.icon
                          ? html`<temba-icon
                              name=${command.icon}
                              size="1.1"
                            ></temba-icon>`
                          : command.label}
                      </div>
                    `;
                  })}
                  <temba-icon
                    name="${Icon.image}"
                    title="${msg('Image')}"
                    class="${this.uploading ? 'uploading' : ''}"
                    @click=${this.handleUploadClick}
                  ></temba-icon>
                `}
            <div class="spacer"></div>
            <div
              class="format ${this.sourceMode ? 'on' : ''}"
              title="${msg('Markdown source')}"
              @click=${() => (this.sourceMode = !this.sourceMode)}
            >
              <temba-icon name=${Icon.markdown} size="1.1"></temba-icon>
            </div>
          </div>
        </div>
        ${this.sourceMode
          ? this.renderSource()
          : html`
              <div class="doc-frame" @mousedown=${this.handleFrameMouseDown}>
                <div class="article">
                  ${this.renderCover()} ${this.renderHead()}
                  <div
                    class="doc"
                    style=${this.documentStyle}
                    contenteditable=${this.disabled ? 'false' : 'true'}
                    @beforeinput=${this.handleBeforeInput}
                    @input=${this.handleInput}
                    @click=${this.handleDocClick}
                    @keydown=${this.handleKeyDown}
                    @mousemove=${this.handleDocMouseMove}
                    @mousedown=${this.handleDocMouseDown}
                    @blur=${this.handleDocBlur}
                    @copy=${this.handleCopy}
                    @cut=${this.handleCut}
                    @dragenter=${this.handleDragOver}
                    @dragover=${this.handleDragOver}
                    @drop=${this.handleDrop}
                    @paste=${this.handlePaste}
                  ></div>
                </div>
                <div class="overlays">${this.renderOverlays()}</div>
              </div>
            `}
        ${this.error ? html`<div class="error">${this.error}</div>` : null}
        <input
          id="upload-input"
          type="file"
          accept="${this.accept}"
          multiple
          style="display:none"
          @change=${this.handleFileInput}
        />
      </div>
    `;
  }
}
