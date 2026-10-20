import { lru } from 'tiny-lru';
import { markdown } from '../markdown';

/**
 * A top level chunk of the document - a paragraph, heading, list, fenced block, and so on.
 *
 * A block keeps the markdown it was authored with rather than anything derived from it, so a document that is only
 * partly edited comes back out byte for byte apart from the block that was touched. That's the whole reason the editor
 * models the document this way instead of parsing to a tree and serializing back: a round trip through an AST would
 * renormalize headings, emphasis markers, bullet characters and line wrapping across content nobody edited, and article
 * bodies have to stay diffable.
 */
export interface Block {
  /** the block's markdown, exactly as authored */
  source: string;
  /** the blank lines that followed it, kept so untouched documents serialize back unchanged */
  trailer: string;
}

const LIST_ITEM = /^ {0,3}([-*+]|\d+[.)])\s/;
const FENCE = /^ {0,3}(```|~~~)/;
// a fence only closes on a line that is nothing but fence characters, so an info string like ```js opens rather than
// closes the block it appears in
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const QUOTE = /^ {0,3}>/;

const NBSP = /\u00a0/g;

// rendering the same block over and over is the common case - the author edits one block while the rest of the
// document sits there, and re-rendering the document walks every block
const renderCache = lru<string>(200);

const isBlank = (line: string) => line.trim() === '';

/**
 * Whether a blank line between the block built so far and the next line of content is inside the block rather than a
 * boundary. Blank lines separate blocks except where markdown says otherwise - a loose list, a list item with more than
 * one paragraph, and a blockquote all survive them.
 */
const continues = (body: string[], line: string): boolean => {
  const first = body.find((l) => !isBlank(l));
  if (!first) {
    return true;
  }

  if (LIST_ITEM.test(first)) {
    return LIST_ITEM.test(line) || /^ {2,}\S/.test(line);
  }

  if (QUOTE.test(first)) {
    return QUOTE.test(line);
  }

  return false;
};

/**
 * Splits markdown into blocks, assigning every line to exactly one block or to the blank run that follows it, so
 * joinBlocks is an exact inverse.
 */
export const splitBlocks = (source: string): Block[] => {
  const blocks: Block[] = [];
  let body: string[] = [];
  let gap: string[] = [];
  let fence: string = null;

  const flush = () => {
    blocks.push({
      source: body.join('\n'),
      trailer: gap.length > 0 ? '\n' + gap.join('\n') : ''
    });
    body = [];
    gap = [];
  };

  for (const line of (source || '').split('\n')) {
    // a fenced block owns its blank lines, so nothing inside one is a boundary
    if (fence) {
      body.push(line);
      if (FENCE_CLOSE.test(line) && line.trimStart()[0] === fence[0]) {
        fence = null;
      }
      continue;
    }

    if (isBlank(line)) {
      // blank lines before any content belong to the first block, otherwise they'd be dropped
      if (body.length === 0) {
        body.push(line);
      } else {
        gap.push(line);
      }
      continue;
    }

    if (gap.length > 0) {
      if (continues(body, line)) {
        body.push(...gap);
        gap = [];
      } else {
        flush();
      }
    }

    body.push(line);

    const fenced = FENCE.exec(line);
    if (fenced) {
      fence = fenced[1];
    }
  }

  // an empty document still gets a block - there has to be somewhere to type
  if (body.length > 0 || gap.length > 0 || blocks.length === 0) {
    flush();
  }

  return blocks;
};

// The text of a block that's nothing but notes - an author's comments, which an article never shows: lines that start
// with //, or a run from a /* at the start of a line to the next */ - or null for a block with anything else in it.
// Only a block of notes is one; a comment inside a paragraph stays part of the paragraph here, though rendering the
// article leaves it out all the same.
export const noteOf = (source: string): string | null => {
  const lines = source.split('\n');
  const text: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) {
      continue;
    }

    const comment = /^\s*\/\/\s?(.*)$/.exec(line);
    if (comment) {
      text.push(comment[1]);
      continue;
    }

    if (!/^\s*\/\*/.test(line)) {
      return null;
    }

    const rest = [
      line.slice(line.indexOf('/*') + 2),
      ...lines.slice(i + 1)
    ].join('\n');
    const end = rest.indexOf('*/');
    if (
      end < 0 ||
      rest
        .slice(end + 2)
        .split('\n')[0]
        .trim()
    ) {
      return null;
    }
    text.push(rest.slice(0, end).trim());
    i += rest.slice(0, end).split('\n').length - 1;
  }

  return text.length > 0 ? text.join('\n').trim() : null;
};

/** a note as the markdown that keeps it: a comment that can't be closed early by anything in its text */
export const noteSource = (text: string): string =>
  `/* ${text.trim().replace(/\*\//g, '* /')} */`;

/**
 * A screenshot directive - a description of how a screenshot is made, for tools that generate screenshots - kept as a
 * comment block after the image it makes, so the article never shows it. The comment opens with a line of its own,
 * `/* shot <name> [<hash>]`, and the rest of it, up to where it closes, is the text: how to get to what the screenshot
 * shows and what to crop and mark, a sentence to a line.
 *
 * The hash is of the text as it was when the screenshot was last made from it, so a directive edited since is
 * recognized by anyone who recomputes it; one without a hash describes a screenshot that hasn't been made yet.
 */
export interface Directive {
  /** the screenshot's name, which is its file name */
  name: string;
  hash: string | null;
  /** the description, a line at a time - each trimmed, with no blank ones, which is what the hash is of */
  text: string;
}

const DIRECTIVE =
  /^(\s*)\/\*[ \t]*shot[ \t]+([a-z0-9-]+)(?:[ \t]+([0-9a-f]{8}))?[ \t]*\n([\s\S]*?)\*\/\s*$/;

const directiveText = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line)
    .join('\n');

/** the directive a block is - one comment opening with its header line - or null for any other block */
export const directiveOf = (source: string): Directive | null => {
  const match = DIRECTIVE.exec(source);
  if (!match || match[4].includes('*/')) {
    return null;
  }
  return {
    name: match[2],
    hash: match[3] || null,
    text: directiveText(match[4])
  };
};

/** a directive's hash: the first 8 hex characters of the sha256 of its text */
export const directiveHash = (text: string): string =>
  sha256(directiveText(text)).slice(0, 8);

/**
 * a directive as the markdown that keeps it, ahead of whatever the block it was read from had ahead of it - its text
 * can't close it early, and the hash stays whatever it was, which is how an edit since the screenshot was made shows
 */
export const directiveSource = (directive: Directive, lead = ''): string => {
  const header = [`/* shot ${directive.name}`, directive.hash]
    .filter((part) => part)
    .join(' ');
  const text = directiveText(directive.text).replace(/\*\//g, '* /');
  return `${lead}${header}\n${text ? text + '\n' : ''}*/`;
};

/** whatever a directive's block has ahead of its comment - blank lines at the top of the document, or an indent */
export const directiveLead = (source: string): string =>
  DIRECTIVE.exec(source)?.[1] || '';

// SHA-256 as hex, computed here rather than with crypto.subtle, which only exists in a secure context and only
// answers asynchronously
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const sha256 = (text: string): string => {
  const data = new TextEncoder().encode(text);
  // the message, a 1 bit, zeros, and its length in bits, to a multiple of 64 bytes
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(data.length / 0x20000000));
  view.setUint32(padded.length - 4, (data.length << 3) >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }

  return [...h].map((word) => word.toString(16).padStart(8, '0')).join('');
};

export const joinBlocks = (blocks: Block[]): string =>
  blocks.map((block) => block.source + block.trailer).join('\n');

/** renders a block's markdown, cached because the document is re-rendered far more often than it changes */
export const renderBlock = (source: string): string => {
  let rendered = renderCache.get(source);
  if (rendered === undefined) {
    rendered = markdown.render(source).trim();
    renderCache.set(source, rendered);
  }
  return rendered;
};

// The rendered shapes the editor knows how to turn back into markdown. Anything outside this set - some construct a
// future renderer starts emitting - becomes an island the author can't edit richly, so content the editor can't
// express is never rewritten by it. See isSerializable.
const BLOCKS = new Set([
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'P',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'HR',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TH',
  'TD',
  'COLGROUP',
  'COL'
]);

const INLINES = new Set([
  'STRONG',
  'B',
  'EM',
  'I',
  'DEL',
  'S',
  'CODE',
  'A',
  'IMG',
  'BR'
]);

/** whether every element in a rendered block is one the serializer can turn back into markdown */
export const isSerializable = (element: Element): boolean =>
  BLOCKS.has(element.tagName) &&
  [...element.querySelectorAll('*')].every(
    (node) => BLOCKS.has(node.tagName) || INLINES.has(node.tagName)
  );

// ==========================================================
// Importing foreign markup
// ==========================================================

// What other apps put on the clipboard is nothing like what our own renderer emits - divs for paragraphs, styled
// spans for emphasis, wrappers around everything - so pasted markup is first rebuilt into the clean shapes the
// serializer knows, and only what survives the rebuild reaches the document.

/** elements that aren't content at all, dropped along with everything in them */
const DROPPED = new Set([
  'HEAD',
  'META',
  'LINK',
  'TITLE',
  'STYLE',
  'SCRIPT',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'SVG',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA'
]);

/** the tags read as blocks when they arrive at the top level of a paste */
const FOREIGN_BLOCKS = new Set([
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
  'TABLE',
  'DIV',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'NAV',
  'FIGURE',
  'FIGCAPTION',
  'DL',
  'DT',
  'DD',
  'FORM',
  'FIELDSET'
]);

/**
 * Whether a pasted node holds block content. The tag alone isn't enough: apps wrap whole documents in inline
 * elements - a copy from a Google Doc arrives inside a <b> - and those have to be read as the containers they are,
 * not as emphasis around a run of text.
 */
const isForeignBlock = (node: Node): boolean => {
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  const element = node as Element;
  return (
    FOREIGN_BLOCKS.has(element.tagName) ||
    !!element.querySelector('p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,pre,hr,table')
  );
};

/** whether any of the nodes amount to something worth keeping - text that isn't blank, or an image */
const hasContent = (nodes: Node[]): boolean =>
  nodes.some(
    (node) =>
      (node.textContent || '').trim() ||
      (node as Element).tagName === 'IMG' ||
      ((node as Element).querySelector &&
        (node as Element).querySelector('img'))
  );

/**
 * The emphasis a pasted element means, whether it says so as a tag or as the styling another app writes instead. A
 * <b> that styles itself back to normal weight - the wrapper a Google Docs copy arrives in - means nothing at all.
 */
const foreignEmphasis = (element: Element): string[] => {
  const tag = element.tagName;
  const style = element.getAttribute('style') || '';
  const wraps: string[] = [];

  if (
    ((tag === 'STRONG' || tag === 'B') &&
      !/font-weight:\s*(normal|[1-4]00)/i.test(style)) ||
    /font-weight:\s*(bold|bolder|[6-9]00)/i.test(style)
  ) {
    wraps.push('strong');
  }
  if (tag === 'EM' || tag === 'I' || /font-style:\s*italic/i.test(style)) {
    wraps.push('em');
  }
  if (
    tag === 'DEL' ||
    tag === 'S' ||
    tag === 'STRIKE' ||
    /line-through/i.test(style)
  ) {
    wraps.push('del');
  }

  return wraps;
};

/** wraps rebuilt content in the emphasis its source element carried on itself */
const wrapForeign = (nodes: Node[], element: Element): Node[] => {
  let out = nodes;
  if (hasContent(out)) {
    for (const wrap of foreignEmphasis(element).reverse()) {
      const wrapper = document.createElement(wrap);
      wrapper.append(...out);
      out = [wrapper];
    }
  }
  return out;
};

/**
 * Rebuilds a pasted node as the inline content it means. Semantic tags are kept as their canonical forms, and the
 * styling other apps write instead of tags - a span carrying font-weight, a div of italics - is read back as the
 * emphasis it stands for. Anything else contributes its contents and nothing else.
 */
const foreignInline = (node: Node): Node[] => {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ? [document.createTextNode(node.textContent)] : [];
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return [];
  }

  const element = node as Element;
  const tag = element.tagName;

  if (DROPPED.has(tag)) {
    return [];
  }

  if (tag === 'BR') {
    return [document.createElement('br')];
  }

  if (tag === 'IMG') {
    // a data: url is the image itself rather than a reference to one, far too big to live in an article body
    const src = element.getAttribute('src') || '';
    if (!src || src.startsWith('data:')) {
      return [];
    }
    const img = document.createElement('img');
    img.setAttribute('src', src);
    // a relative reference resolved for display keeps the reference it was written with alongside
    const reference = element.getAttribute('data-src');
    if (reference) {
      img.setAttribute('data-src', reference);
    }
    img.setAttribute('alt', element.getAttribute('alt') || '');
    return [img];
  }

  if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') {
    const code = document.createElement('code');
    code.textContent = element.textContent;
    return element.textContent ? [code] : [];
  }

  let out = [...element.childNodes].flatMap(foreignInline);

  if (tag === 'A') {
    const href = element.getAttribute('href') || '';
    if (href && !/^javascript:/i.test(href) && hasContent(out)) {
      const anchor = document.createElement('a');
      anchor.setAttribute('href', href);
      const title = element.getAttribute('title');
      if (title) {
        anchor.setAttribute('title', title);
      }
      anchor.append(...out);
      out = [anchor];
    }
  }

  return wrapForeign(out, element);
};

const foreignList = (list: Element): Element[] => {
  const clean = document.createElement(list.tagName.toLowerCase());
  const start = list.getAttribute('start');
  if (list.tagName === 'OL' && start) {
    clean.setAttribute('start', start);
  }

  for (const item of [...list.children]) {
    if (item.tagName !== 'LI') {
      continue;
    }

    // an item's own text stays loose in the item - wrapping it in a paragraph would read back as a loose list -
    // while a nested list or a genuine paragraph stays the block it is
    const li = document.createElement('li');
    for (const child of [...item.childNodes]) {
      const tag = (child as Element).tagName;
      if (tag === 'UL' || tag === 'OL') {
        li.append(...foreignList(child as Element));
      } else if (isForeignBlock(child)) {
        li.append(...gatherForeign([child]));
      } else {
        li.append(...foreignInline(child));
      }
    }

    if (li.childNodes.length > 0) {
      clean.appendChild(li);
    }
  }

  return clean.children.length > 0 ? [clean] : [];
};

const foreignTable = (table: Element): Element[] => {
  const rows = [...table.querySelectorAll('tr')];
  if (rows.length === 0) {
    return [];
  }

  // A layout table - a header that says nothing, or that only carries its column stylesheet - never travels as a
  // table: only its contents arrive, each cell a paragraph of its own. Styling belongs where it was authored.
  const heads = [...table.querySelectorAll('th')];
  if (
    heads.length > 0 &&
    heads.every(
      (th) => !th.textContent.trim() || columnStyle(th.textContent.trim())
    )
  ) {
    const blocks: Element[] = [];
    for (const row of rows) {
      for (const cell of [...row.children]) {
        if (cell.tagName !== 'TD') {
          continue;
        }
        const paragraph = document.createElement('p');
        paragraph.append(...[...cell.childNodes].flatMap(foreignInline));
        if (hasContent([paragraph])) {
          blocks.push(paragraph);
        }
      }
    }
    return blocks;
  }

  const clean = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');

  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    for (const cell of [...row.children]) {
      if (cell.tagName !== 'TD' && cell.tagName !== 'TH') {
        continue;
      }
      const out = document.createElement(index === 0 ? 'th' : 'td');
      out.append(...[...cell.childNodes].flatMap(foreignInline));
      tr.appendChild(out);
    }
    if (tr.children.length > 0) {
      (index === 0 ? thead : tbody).appendChild(tr);
    }
  });

  if (thead.children.length === 0) {
    return [];
  }

  clean.appendChild(thead);
  if (tbody.children.length > 0) {
    clean.appendChild(tbody);
  }
  return [clean];
};

/** rebuilds one pasted block-level element as the clean blocks it means */
const foreignBlock = (element: Element): Element[] => {
  const tag = element.tagName;

  if (/^H[1-6]$/.test(tag)) {
    const heading = document.createElement(tag.toLowerCase());
    heading.append(
      ...wrapForeign([...element.childNodes].flatMap(foreignInline), element)
    );
    return hasContent([heading]) ? [heading] : [];
  }

  if (tag === 'P') {
    // emphasis some apps hang on the paragraph itself - a wholly italic line, say - belongs to its text
    const paragraph = document.createElement('p');
    paragraph.append(
      ...wrapForeign([...element.childNodes].flatMap(foreignInline), element)
    );
    return hasContent([paragraph]) ? [paragraph] : [];
  }

  if (tag === 'HR') {
    return [document.createElement('hr')];
  }

  if (tag === 'PRE') {
    if (!element.textContent.trim()) {
      return [];
    }
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = element.textContent;
    pre.appendChild(code);
    return [pre];
  }

  if (tag === 'UL' || tag === 'OL') {
    return foreignList(element);
  }

  if (tag === 'TABLE') {
    return foreignTable(element);
  }

  if (tag === 'BLOCKQUOTE') {
    const quote = document.createElement('blockquote');
    quote.append(...gatherForeign([...element.childNodes]));
    return quote.children.length > 0 ? [quote] : [];
  }

  // anything else is a wrapper - its blocks matter, it doesn't
  return gatherForeign([...element.childNodes]);
};

/** turns pasted nodes into a flat run of clean blocks, wrapping the loose inline runs between them in paragraphs */
const gatherForeign = (nodes: Node[]): Element[] => {
  const blocks: Element[] = [];
  let inline: Node[] = [];

  const flush = () => {
    if (hasContent(inline)) {
      const paragraph = document.createElement('p');
      paragraph.append(...inline);
      blocks.push(paragraph);
    }
    inline = [];
  };

  for (const node of nodes) {
    if (isForeignBlock(node)) {
      flush();
      blocks.push(...foreignBlock(node as Element));
    } else {
      inline.push(...foreignInline(node));
    }
  }

  flush();
  return blocks;
};

/**
 * Rebuilds parsed clipboard markup - ours or another app's - into the clean block elements the serializer can read
 * back to markdown. What can't be expressed contributes its text; what isn't content at all is dropped.
 */
export const importBlocks = (root: Element): Element[] =>
  gatherForeign([...root.childNodes]);

const isWord = (char: string) => /[A-Za-z0-9]/.test(char || '');

/**
 * Escapes text so it comes back out of the renderer as itself. Only the characters that would otherwise start a
 * construct are escaped - an author who types * or [ means those characters, and one who wants emphasis uses the
 * toolbar. Underscores inside a word are left alone, because snake_case is far more common in this content than
 * emphasis written that way, and the renderer doesn't read them as emphasis there either.
 */
const escapeText = (text: string): string =>
  text
    // a non-breaking space is something the browser inserted to hold a run of spaces open, not something the author
    // typed, and markdown has no use for it
    .replace(NBSP, ' ')
    .replace(/([\\`*[\]])/g, '\\$1')
    .replace(/_+/g, (run, at, whole) =>
      isWord(whole[at - 1]) && isWord(whole[at + run.length])
        ? run
        : run.replace(/_/g, '\\_')
    );

/**
 * Escapes anything at the front of a line that would turn the line into a different kind of block - a paragraph
 * beginning "1. " is a paragraph, not a list, and has to still be one after a round trip.
 *
 * The backslash goes in front of the punctuation that does the work rather than in front of the whole marker, because
 * markdown only honours an escape before punctuation: "\1." leaves the backslash showing and then gets escaped again
 * on the next round trip, so each save would grow another one.
 */
const escapeLeading = (md: string): string =>
  md
    .split('\n')
    .map((line) =>
      line
        // a bullet or heading marker, and a > which needs no space after it to open a quote. A * is already escaped
        // as text, so it can't reach this.
        .replace(/^(\s*)(#{1,6}\s|[-+]\s|>)/, '$1\\$2')
        // a line of only dashes or equals underlines the line above it into a heading, or rules off the page
        .replace(/^(\s*)([-=]+\s*)$/, '$1\\$2')
        .replace(/^(\s*\d+)([.)]\s)/, '$1\\$2')
    )
    .join('\n');

/**
 * Trims a block's markdown without losing a hard break. Two or more spaces before a newline is what markdown calls a
 * line break, so trailing whitespace can't just be stripped - it's normalized to the two spaces that mean it.
 */
const tidy = (md: string): string =>
  md
    .replace(/[^\S\n]+(?=\n)/g, (space) => (space.length >= 2 ? '  ' : ''))
    .replace(/^\s+|\s+$/g, '');

/** a code span needs a fence longer than any run of backticks inside it, and padding if it starts or ends with one */
const codeSpan = (text: string): string => {
  const runs: string[] = text.match(/`+/g) || [];
  const fence = '`'.repeat(
    runs.reduce((longest, run) => Math.max(longest, run.length), 0) + 1
  );
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
};

/** a destination with spaces or parens in it has to be wrapped, or it ends the link early */
const destination = (url: string): string =>
  /[\s()]/.test(url) ? `<${url}>` : url;

/** the text character rendered immediately beside an inline element, looking past whatever markup it nests in */
const charBeside = (element: Element, after: boolean): string => {
  let at: Node = element;
  while (at && !BLOCKS.has((at as Element).tagName)) {
    const sibling = after ? at.nextSibling : at.previousSibling;
    if (sibling) {
      const text = sibling.textContent || '';
      return after ? text.charAt(0) : text.charAt(text.length - 1);
    }
    at = at.parentNode;
  }
  return '';
};

/**
 * Wraps a run in emphasis markers. Markers have to sit against the text rather than against the whitespace around it,
 * or the renderer shows them literally, so any padding is left outside.
 *
 * An underscore doesn't open or close emphasis against a word character - word_like_this reads as snake_case, not
 * italics - so emphasis that touches one on either side is written with the * that still parses there. Everywhere
 * else _ is kept, so an author's _em_ comes back as it was written.
 */
const emphasize = (element: Element, marker: string): string => {
  const inner = inlineOf(element);
  const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!core) {
    return inner;
  }

  if (
    marker === '_' &&
    ((!lead && isWord(charBeside(element, false))) ||
      (!tail && isWord(charBeside(element, true))))
  ) {
    marker = '*';
  }

  return `${lead}${marker}${core}${marker}${tail}`;
};

const inlineOf = (node: Node): string => {
  let out = '';
  let afterBreak = false;

  for (const child of [...node.childNodes]) {
    // The renderer writes a newline after the <br> it emits for a hard break, and that newline is its formatting
    // rather than content - keeping it would turn one line break into two every time the block was saved.
    out +=
      afterBreak && child.nodeType === Node.TEXT_NODE
        ? escapeText(child.textContent.replace(/^\n/, ''))
        : inlineNode(child);

    afterBreak = (child as Element).tagName === 'BR';
  }

  return out;
};

const inlineNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeText(node.textContent);
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const element = node as Element;

  switch (element.tagName) {
    case 'BR':
      // two spaces is the hard break the renderer emits a <br> for
      return '  \n';
    case 'STRONG':
    case 'B':
      return emphasize(element, '**');
    case 'EM':
    case 'I':
      return emphasize(element, '_');
    case 'DEL':
    case 'S':
      return emphasize(element, '~~');
    case 'CODE':
      // code is its own source, so nothing inside it is escaped
      return codeSpan(element.textContent.replace(NBSP, ' '));
    case 'IMG': {
      const alt = (element.getAttribute('alt') || '').replace(/[[\]]/g, '');
      // written as it was referenced - the src may be that reference resolved for display
      return `![${alt}](${destination(element.getAttribute('data-src') ?? (element.getAttribute('src') || ''))})`;
    }
    case 'A': {
      const title = element.getAttribute('title');
      const href = destination(element.getAttribute('href') || '');
      return `[${inlineOf(element)}](${href}${title ? ` "${title}"` : ''})`;
    }
    default:
      // a wrapper we don't model - a span the browser left behind, say - contributes its contents and nothing else
      return inlineOf(element);
  }
};

/** indents every line after the first, which is what puts a block inside a list item */
const hang = (md: string, pad: string): string =>
  md
    .split('\n')
    .map((line, at) => (at === 0 || !line ? line : pad + line))
    .join('\n');

const listItem = (item: Element, marker: string): string => {
  let out = '';

  const add = (md: string, separator: string) => {
    out = out ? `${out}${separator}${md}` : md;
  };

  // a loose item holds its text in paragraphs and a nested list is a block of its own; everything else on the item is
  // the item's own inline content. A nested list joins on a single newline - a blank line before it would make the
  // outer list loose, which changes how the whole thing renders.
  let inline = '';

  const flush = () => {
    if (inline.trim()) {
      add(tidy(escapeLeading(inline)), '\n\n');
    }
    inline = '';
  };

  for (const child of [...item.childNodes]) {
    const tag = (child as Element).tagName;

    if (tag === 'UL' || tag === 'OL') {
      flush();
      add(blockOf(child as Element), '\n');
    } else if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'PRE') {
      flush();
      add(blockOf(child as Element), '\n\n');
    } else {
      inline += inlineNode(child);
    }
  }

  flush();

  return marker + hang(out, ' '.repeat(marker.length));
};

const listOf = (list: Element): string => {
  const ordered = list.tagName === 'OL';
  const start = ordered ? parseInt(list.getAttribute('start') || '1', 10) : 0;
  const items = [...list.children].filter((child) => child.tagName === 'LI');

  // a list whose items hold paragraphs is loose, and has to keep the blank lines that made it loose
  const loose = items.some((item) =>
    [...item.children].some((child) => child.tagName === 'P')
  );

  return items
    .map((item, at) => listItem(item, ordered ? `${start + at}. ` : '* '))
    .join(loose ? '\n\n' : '\n');
};

/**
 * The column styling a layout table's hidden header cells can carry - a tiny stylesheet only we read, riding in the
 * markdown itself so it survives every copy. Only width, background and padding are understood, and only in forms we
 * would write; a header whose text says anything else is an ordinary header, shown as text.
 *
 * A background is an index into the org's shared palette rather than a color: the article embeds the choice, the
 * palette says what the choice currently looks like. Recoloring a palette entry restyles its every use at once, and
 * removing one leaves its references meaning nothing until an entry exists at that index again.
 */
export interface ColumnStyle {
  width?: string;
  background?: string;
  padding?: string;
  border?: string;
}

/** reads a header cell's stylesheet, or null when its text isn't one */
export const columnStyle = (text: string): ColumnStyle | null => {
  const out: ColumnStyle = {};

  for (const piece of text.split(';')) {
    const declaration = piece.trim();
    if (!declaration) {
      continue;
    }

    const match = /^(width|background|padding|border)\s*:\s*(\S+)$/i.exec(
      declaration
    );
    if (!match) {
      return null;
    }

    const key = match[1].toLowerCase() as keyof ColumnStyle;
    const value = match[2].toLowerCase();
    if (key === 'width' && !/^\d+(px|%)$/.test(value)) {
      return null;
    }
    if (key === 'background' && !/^\d+$/.test(value)) {
      return null;
    }
    if (key === 'padding' && !/^\d+px$/.test(value)) {
      return null;
    }
    if (key === 'border' && value !== 'solid') {
      return null;
    }

    out[key] = value;
  }

  return out;
};

/** writes a column's styling back as the declarations columnStyle reads */
export const columnStyleText = (style: ColumnStyle): string =>
  [
    style.width && `width: ${style.width}`,
    style.background && `background: ${style.background}`,
    style.padding && `padding: ${style.padding}`,
    style.border && `border: ${style.border}`
  ]
    .filter(Boolean)
    .join('; ');

/** A cell is one line of inline content: the pipes that would end it early are escaped, and its line breaks ride
 * as the literal <br> a table cell can carry - a real newline would end the whole row. */
const cellOf = (cell: Element): string =>
  tidy(inlineOf(cell))
    .replace(/ {2}\n\s*/g, '<br>')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|');

/** a header cell's markdown is its column stylesheet when it carries one, its text otherwise */
const headerOf = (cell: Element): string =>
  cell.getAttribute('data-style') || cellOf(cell);

/** the alignment a cell was rendered with, which is where the renderer records what the ruler row asked for */
const alignOf = (cell: Element): string => {
  const match = /text-align:\s*(left|center|right)/.exec(
    cell.getAttribute('style') || ''
  );
  return match ? match[1] : '';
};

const tableOf = (table: Element): string => {
  const rows = [...table.querySelectorAll('tr')];
  if (rows.length === 0) {
    return '';
  }

  const line = (row: Element) =>
    `| ${[...row.children].map(cellOf).join(' | ')} |`;

  const ruler = [...rows[0].children].map((cell) => {
    const align = alignOf(cell);
    return align === 'center'
      ? ':---:'
      : align === 'right'
        ? '---:'
        : align === 'left'
          ? ':---'
          : '---';
  });

  return [
    `| ${[...rows[0].children].map(headerOf).join(' | ')} |`,
    `| ${ruler.join(' | ')} |`,
    ...rows.slice(1).map(line)
  ].join('\n');
};

const preOf = (element: Element): string => {
  const code = element.querySelector('code') || element;
  const language = /\blanguage-(\S+)/.exec(code.getAttribute('class') || '');
  const text = code.textContent.replace(/\n$/, '');

  // the fence has to be longer than any run of backticks the code starts a line with, or the block closes early
  const runs: string[] = text.match(/^\s*`{3,}/gm) || [];
  const fence = '`'.repeat(
    runs.reduce((longest, run) => Math.max(longest, run.trim().length), 2) + 1
  );

  return `${fence}${language ? language[1] : ''}\n${text}\n${fence}`;
};

/** the markdown for one rendered block element */
export const blockOf = (element: Element): string => {
  const tag = element.tagName;

  if (/^H[1-6]$/.test(tag)) {
    // a heading is one line, so a break inside one becomes a space rather than splitting the heading
    const text = tidy(inlineOf(element)).replace(/\s*\n\s*/g, ' ');
    return `${'#'.repeat(+tag[1])} ${text}`;
  }

  if (tag === 'HR') {
    return '---';
  }

  if (tag === 'PRE') {
    return preOf(element);
  }

  if (tag === 'UL' || tag === 'OL') {
    return listOf(element);
  }

  if (tag === 'TABLE') {
    return tableOf(element);
  }

  if (tag === 'BLOCKQUOTE') {
    // The renderer's quotes hold paragraphs, but a quote the browser just made holds its text loose - text nodes
    // and inline markup directly in the quote. Reading only element children there would keep the markup and drop
    // the text around it, so anything loose means the quote is one run of inline content.
    const loose = [...element.childNodes].some(
      (node) =>
        (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) ||
        (node.nodeType === Node.ELEMENT_NODE &&
          !BLOCKS.has((node as Element).tagName))
    );

    const inner = loose
      ? ''
      : [...element.children].map((child) => blockOf(child)).join('\n\n');

    return (inner || tidy(escapeLeading(inlineOf(element))))
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');
  }

  return tidy(escapeLeading(inlineOf(element)));
};
